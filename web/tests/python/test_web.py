import io
import json
import queue
import select
import socket
import sys
import threading
from time import monotonic, sleep
import unittest
from types import SimpleNamespace
from pathlib import Path
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "src/python"))
from common import load_case
from score import evaluate, final_assistant_content, terminated_result
from web_backend import (FETCH_MAX_BYTES, FETCH_TIMEOUT, WebBackend, WebChannelError,
                         _PlainTunnelConnection, _PlainTunnelPool, _ProxyHttpsConnection, _public_address)
from urllib.parse import parse_qs, urlsplit
from urllib3.connectionpool import HTTPSConnectionPool
from urllib3.response import HTTPResponse

CASE = "web_search_no_snippet_0"
SEARCH = "search_engine_query"
FETCH = "fetch_url_content"


class WebTests(unittest.TestCase):
    def test_fixture_no_network(self):
        with patch.object(socket.socket, "connect", side_effect=AssertionError("network")) as connect, patch.object(
                socket, "getaddrinfo", side_effect=AssertionError("dns")) as dns:
            backend = WebBackend(ROOT, load_case(CASE), {"mode": "fixture"})
            self.assertEqual(json.loads(backend.call(SEARCH, {"keywords": "fixture"})), [
                {"title": "Fixture result", "href": "https://example.org/fixture"},
                {"title": "Second fixture result", "href": "https://example.org/second"}])
            self.assertEqual(backend.call(FETCH, {"url": "https://example.org/fixture"}), '{"content":"Fixture webpage body."}')
            connect.assert_not_called()
            dns.assert_not_called()

    def test_replay_no_network(self):
        selection = json.loads((ROOT / "config/web-replay-selection.json").read_text(encoding="utf-8"))
        case_id = next(c["caseId"] for c in selection["cases"] if c["toolCalls"] >= 2 and
                       {"fetch_raw", "fetch_markdown", "fetch_truncate"}.intersection(c["features"]))
        data = json.loads((ROOT / "data/replay/tools" / (case_id + ".json")).read_text(encoding="utf-8"))
        with patch.object(socket.socket, "connect", side_effect=AssertionError("network")) as connect, patch.object(
                socket, "getaddrinfo", side_effect=AssertionError("dns")) as dns:
            backend = WebBackend(ROOT, load_case(case_id), {"mode": "replay"})
            self.assertEqual({c["name"] for c in data["calls"]}, {SEARCH, FETCH})
            for call in data["calls"]:
                self.assertEqual(backend.call(call["name"], call["arguments"]), call["observation"])
            with self.assertRaisesRegex(WebChannelError, "回放错误"):
                backend.call(SEARCH, {"keywords": "beyond"})
            wrong = WebBackend(ROOT, load_case(case_id), {"mode": "replay"})
            with self.assertRaisesRegex(WebChannelError, "参数不一致"):
                wrong.call(data["calls"][0]["name"], {})
            connect.assert_not_called()
            dns.assert_not_called()

    def test_live_search_contract(self):
        settings = {"mode": "live", "taskId": "run/config/r1/" + CASE, "configId": "config",
                    "searchEndpoint": "http://127.0.0.1:18080/v1/search", "fetchProxy": "http://host.docker.internal:7897"}
        backend = WebBackend(ROOT, load_case(CASE), settings)
        success = {"ok": True, "output": {"organic_results": [
            {"title": "title", "link": "https://example.org", "snippet": "removed"}]}}
        def reply(payload):
            response = Mock(status_code=200)
            response.json.return_value = payload
            context = Mock()
            context.__enter__ = Mock(return_value=response)
            context.__exit__ = Mock(return_value=False)
            return context
        with patch.object(socket.socket, "connect", side_effect=AssertionError("network")) as connect, patch.object(
                backend.session, "post", side_effect=[reply(success), reply({"ok": True, "output": {"organic_results": []}}),
                    reply({"ok": False, "error": {"kind": "search_failed", "message": "429 exhausted"}}),
                    reply({"ok": False, "error": {"kind": "invalid_argument", "message": "reject"}}),
                    reply({"ok": False, "error": {"kind": "run_stop", "message": "429 stop"}}),
                    OSError("disconnected")]) as post:
            for arguments in ({"keywords": "x"*129}, {"keywords": "ok", "max_results": True},
                              {"keywords": "ok", "region": "us-en"}):
                self.assertIn("error", json.loads(backend.call(SEARCH, arguments)))
            post.assert_not_called()
            self.assertEqual(backend.call(SEARCH, {"keywords": "test", "max_results": 1.0}),
                             '[{"title":"title","href":"https://example.org"}]')
            self.assertEqual(post.call_args.kwargs, {"json": {"protocol": "bfcl-web-search-v1", "configId": "config",
                "taskId": settings["taskId"], "caseId": "web_search_0", "call": 4,
                "query": {"keywords": "test", "max_results": 1, "region": "wt-wt"}},
                "timeout": 900, "allow_redirects": False})
            self.assertEqual(backend.call(SEARCH, {"keywords": "empty"}), "[]")
            self.assertIn("search_failed", backend.call(SEARCH, {"keywords": "fail"}))
            self.assertIn("invalid_argument", backend.call(SEARCH, {"keywords": "reject"}))
            with self.assertRaisesRegex(WebChannelError, "BFCL_RUN_STOP:429 stop"):
                backend.call(SEARCH, {"keywords": "stop"})
            with self.assertRaisesRegex(WebChannelError, "连接断开"):
                backend.call(SEARCH, {"keywords": "disconnect"})
            self.assertEqual(post.call_count, 6)
            connect.assert_not_called()

    def live_fetch(self, url, lookup, pages, mode="raw"):
        settings = {"mode": "live", "taskId": "run/config/r1/" + CASE, "configId": "config",
                    "searchEndpoint": "http://127.0.0.1:18080/v1/search", "fetchProxy": "http://127.0.0.1:7897"}
        backend = WebBackend(ROOT, load_case(CASE), settings)
        observed = []

        def reply(status, body, headers):
            return HTTPResponse(body=io.BytesIO(body), status=status, headers=headers, preload_content=False)

        def https(pool, method, url, **kwargs):
            path = url
            self.assertEqual(method, "GET")
            self.assertEqual(pool.proxy.host, "127.0.0.1")
            self.assertEqual(pool.proxy.port, 7897)
            self.assertEqual(kwargs["timeout"].connect_timeout, 20)
            self.assertEqual(kwargs["timeout"].read_timeout, 20)
            self.assertEqual(pool.cert_reqs, "CERT_REQUIRED")
            connection = pool._new_conn()
            with patch.object(connection, "connect"):
                pool._prepare_proxy(connection)
            self.assertEqual(connection._tunnel_port, 443)
            if pool.host == "dns.google":
                self.assertEqual(connection._tunnel_host, "dns.google")
                self.assertEqual(urlsplit(path).path, "/resolve")
                query = parse_qs(urlsplit(path).query)
                host = query["name"][0]
                self.assertEqual(query, {"name": [host], "type": ["A"]})
                self.assertEqual(kwargs["headers"]["Accept"], "application/dns-json")
                self.assertEqual(kwargs["headers"]["Accept-Encoding"], "identity")
                observed.append(("doh", host))
                status, body = lookup[host]
                if isinstance(body, Exception):
                    raise body
                return reply(status, body, {"Content-Type": "application/dns-json"})
            host = kwargs["headers"]["Host"]
            self.assertEqual(connection._tunnel_host, pool.host)
            self.assertEqual(connection.server_hostname, host)
            self.assertEqual(connection.assert_hostname, host)
            return page(host, connection._tunnel_host, path, kwargs)

        def plain(pool, method, url, **kwargs):
            path = url
            self.assertEqual(method, "GET")
            self.assertEqual(kwargs["timeout"].connect_timeout, 20)
            connection = pool._new_conn()
            self.assertIsInstance(connection, _PlainTunnelConnection)
            self.assertEqual((connection.host, connection.port), ("127.0.0.1", 7897))
            with patch("urllib3.connection.HTTPConnection.connect", autospec=True):
                connection.connect()
            self.assertEqual(connection._tunnel_port, 80)
            return page(kwargs["headers"]["Host"], connection._tunnel_host, path, kwargs)

        def page(host, address, path, kwargs):
            self.assertTrue(path.startswith("/") and not path.startswith("//"))
            self.assertIn("Chrome/112", kwargs["headers"]["User-Agent"])
            observed.append(("page", host, address))
            status, body, headers = pages[host]
            if isinstance(body, Exception):
                raise body
            return reply(status, body, headers)

        with patch.object(socket, "getaddrinfo", side_effect=AssertionError("unexpected DNS")) as dns, patch.object(
                socket.socket, "connect", side_effect=AssertionError("network")) as connect, patch.object(
                HTTPSConnectionPool, "urlopen", autospec=True, side_effect=https), patch.object(
                _PlainTunnelPool, "urlopen", autospec=True, side_effect=plain):
            result = json.loads(backend.call(FETCH, {"url": url, "mode": mode}))
            dns.assert_not_called()
            connect.assert_not_called()
        return result, observed

    @staticmethod
    def dns_response(*rows):
        return 200, json.dumps({"Status": 0, "Answer": list(rows)}).encode()

    def test_live_fetch_doh_success_preserves_official_conversion_and_tls_pin(self):
        answer = self.dns_response({"type": 5, "data": "alias.example."}, {"type": 1, "data": "8.8.8.8"},
                                   {"type": 28, "data": "2001:4860:4860::8888"})
        for mode in ("raw", "markdown", "truncate"):
            with self.subTest(mode=mode):
                out, hops = self.live_fetch("https://example.org", {"example.org": answer},
                                            {"example.org": (200, b"<h1>Heading</h1>", {"Content-Type": "text/html; charset=utf-8"})}, mode)
                self.assertIn("Heading", out["content"])
                self.assertEqual(hops, [("doh", "example.org"), ("page", "example.org", "8.8.8.8")])

    def test_live_fetch_doh_failures_are_tool_observations(self):
        from requests import ConnectionError
        cases = (
            (self.dns_response({"type": 5, "data": "alias.example."}), "dns_lookup_failed: 代理DNS未返回IPv4地址"),
            ((200, b'{"Status":3}'), "dns_lookup_failed: 代理DNS未返回可用地址"),
            ((302, b''), "dns_lookup_failed: 代理DNS未返回可用地址"),
            ((200, ConnectionError("stubbed connection")), "dns_lookup_failed: 代理DNS查询失败"),
            ((200, b'{bad json'), "dns_lookup_failed: 代理DNS返回的内容无法解析"),
            (self.dns_response({"type": 1, "data": "not an IP"}), "dns_lookup_failed: 代理DNS返回的内容无法解析"),
            (self.dns_response({"type": 1, "data": "8.8.8.8"}, {"type": 1, "data": "198.18.1.2"}),
             "private_address: 网页目的地包含非公网地址，已阻止访问"),
            (self.dns_response({"type": 1, "data": "8.8.8.8"}, {"type": 1, "data": "192.168.1.1"}),
             "private_address: 网页目的地包含非公网地址，已阻止访问"),
        )
        for reply, expected in cases:
            with self.subTest(expected=expected, reply=reply):
                out, hops = self.live_fetch("https://example.org", {"example.org": reply}, {})
                self.assertIn(expected, out["error"])
                self.assertEqual(hops, [("doh", "example.org")])

    def test_live_fetch_redirect_resolves_and_pins_each_hop(self):
        lookup = {"example.org": self.dns_response({"type": 1, "data": "8.8.8.8"}),
                  "redirect.example": self.dns_response({"type": 1, "data": "1.1.1.1"})}
        pages = {"example.org": (302, b"", {"Location": "https://redirect.example/final"}),
                 "redirect.example": (200, b"Redirected", {"Content-Type": "text/plain; charset=utf-8"})}
        out, hops = self.live_fetch("http://example.org/start", lookup, pages)
        self.assertEqual(out, {"content": "Redirected"})
        self.assertEqual(hops, [("doh", "example.org"), ("page", "example.org", "8.8.8.8"),
                                ("doh", "redirect.example"), ("page", "redirect.example", "1.1.1.1")])
        lookup["redirect.example"] = self.dns_response({"type": 1, "data": "127.0.0.1"})
        out, hops = self.live_fetch("http://example.org/start", lookup, pages)
        self.assertIn("private_address", out["error"])
        self.assertEqual(hops, [("doh", "example.org"), ("page", "example.org", "8.8.8.8"), ("doh", "redirect.example")])

    def test_live_fetch_rejects_ip_literal_and_localhost_before_doh(self):
        for host in ("127.0.0.1", "[::1]", "169.254.1.1", "8.8.8.8", "localhost"):
            with self.subTest(host=host):
                out, hops = self.live_fetch("https://" + host, {}, {})
                self.assertIn("error", out)
                self.assertEqual(hops, [])

    def test_numeric_proxy_connection_does_not_call_getaddrinfo(self):
        with patch.object(socket, "getaddrinfo", side_effect=AssertionError("unexpected DNS")) as dns, patch.object(
                socket, "socket") as create_socket:
            for connection in (_ProxyHttpsConnection("127.0.0.1", 7897, timeout=20),
                               _PlainTunnelConnection("8.8.8.8", 80, proxy_host="127.0.0.1", proxy_port=7897, timeout=20)):
                self.assertIs(connection._new_conn(), create_socket.return_value)
            self.assertEqual(create_socket.return_value.connect.call_count, 2)
            create_socket.return_value.connect.assert_called_with(("127.0.0.1", 7897))
            create_socket.return_value.settimeout.assert_called_with(20)
            dns.assert_not_called()

    def test_live_fetch_doh_total_deadline_is_tool_error(self):
        result = Mock()
        result.get.side_effect = queue.Empty
        fake_queue = SimpleNamespace(Queue=Mock(return_value=result), Empty=queue.Empty)
        with patch("web_backend.threading.Thread"), patch("web_backend.queue", new=fake_queue), patch.object(
                socket, "getaddrinfo", side_effect=AssertionError("unexpected DNS")) as dns:
            with self.assertRaisesRegex(ValueError, "dns_lookup_failed: 代理DNS查询超时"):
                _public_address("http://127.0.0.1:7897", "example.org")
            dns.assert_not_called()
        result.get.assert_called_once_with(timeout=20)

    def test_live_fetch_byte_cap_keeps_exact_limit_and_rejects_one_extra_byte(self):
        url = "https://example.org/body"
        lookup = {"example.org": self.dns_response({"type": 1, "data": "8.8.8.8"})}
        content = "é".encode() * (FETCH_MAX_BYTES // 2)
        headers = {"Content-Type": "text/plain; charset=utf-8"}
        out, _ = self.live_fetch(url, lookup, {"example.org": (200, content, headers)})
        self.assertEqual(len(out["content"].encode("utf-8")), 16 * 1024 * 1024)
        del out
        out, _ = self.live_fetch(url, lookup, {"example.org": (200, content + b"x", headers)})
        self.assertIn("response_too_large", out["error"])
        print("body cap: 16777216 bytes accepted; 16777217 bytes returned tool error")

    def test_live_fetch_error_replaces_pool_and_connect_ip_with_original_url(self):
        from requests import ConnectionError
        url = "https://example.org/article"
        failure = ConnectionError("_ProxyHttpsPool(host='8.8.8.8', port=443): CONNECT 8.8.8.8:443 refused")
        out, hops = self.live_fetch(url, {"example.org": self.dns_response({"type": 1, "data": "8.8.8.8"})},
                                    {"example.org": (0, failure, {})})
        self.assertIn(url, out["error"])
        self.assertIn("refused", out["error"])
        self.assertNotIn("8.8.8.8", out["error"])
        self.assertNotIn("_ProxyHttpsPool", out["error"])
        self.assertEqual(len(hops), 2)

    def test_finished_null_content_reaches_official_checker_as_none(self):
        from bfcl_eval.eval_checker.agentic_eval.agentic_checker import agentic_checker
        from common import load_answers
        task = {"caseId":CASE,"transcriptFormat":"full","messages":[{"role":"assistant","content":""}],
                "modelSteps":[{"output":{"finishReason":"stop","message":{"role":"assistant","content":"",
                    "metadata":{"chatMessage":{"content":None}}}}}]}
        content = final_assistant_content(task)
        self.assertIsNone(content)
        result = evaluate(CASE,content)
        self.assertEqual(result["official_result"], agentic_checker(None,load_answers(CASE)[CASE]))
        self.assertFalse(result["valid"])

    def fetch_through_loopback(self, replies, url):
        observed, errors = [], []
        stopped = threading.Event()

        def read_headers(stream):
            first = stream.readline()
            while stream.readline() not in (b"", b"\r\n"):
                pass
            return first

        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            listener.listen()
            listener.settimeout(3)
            proxy = f"http://127.0.0.1:{listener.getsockname()[1]}"

            def serve():
                try:
                    for response in replies:
                        conn, _ = listener.accept()
                        with conn, conn.makefile("rb") as stream:
                            conn.settimeout(3)
                            tunnel = read_headers(stream)
                            conn.sendall(b"HTTP/1.1 200 Connection established\r\n\r\n")
                            observed.append((tunnel, read_headers(stream)))
                            if response(conn):
                                stopped.set()
                except (BrokenPipeError, ConnectionResetError):
                    stopped.set()
                except Exception as error:
                    errors.append(error)

            worker = threading.Thread(target=serve, daemon=True)
            worker.start()
            settings = {"mode": "live", "taskId": "test", "configId": "test",
                        "searchEndpoint": "http://127.0.0.1:18080/v1/search", "fetchProxy": proxy}
            backend = WebBackend(ROOT, load_case(CASE), settings)
            body = self.dns_response({"type": 1, "data": "8.8.8.8"})[1]
            with patch("web_backend._doh_body", return_value=body) as doh, patch.object(
                    socket, "getaddrinfo", side_effect=AssertionError("unexpected DNS")) as dns:
                start = monotonic()
                out = json.loads(backend.call(FETCH, {"url": url}))
                elapsed = monotonic() - start
                dns.assert_not_called()
            worker.join(4)
            self.assertFalse(worker.is_alive())
            self.assertEqual(errors, [])
        return out, elapsed, observed, doh.call_count, stopped.is_set()

    def test_live_fetch_slow_one_byte_per_second_stops_at_real_60_second_deadline(self):
        def slow(conn):
            conn.sendall(b"HTTP/1.1 200 OK\r\nContent-Length: 80\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\n")
            for _ in range(80):
                conn.sendall(b"x")
                ready, _, _ = select.select([conn], [], [], 1)
                if ready and conn.recv(1) == b"":
                    return True

        self.assertEqual(FETCH_TIMEOUT, 60)
        out, elapsed, observed, lookups, stopped = self.fetch_through_loopback([slow], "http://example.org/slow")
        self.assertIn("fetch_timeout", out["error"])
        self.assertLessEqual(elapsed, 60.6)
        self.assertGreaterEqual(elapsed, 59)
        self.assertEqual((len(observed), lookups), (1, 1))
        self.assertTrue(stopped, "deadline should close the proxy connection")
        print(f"slow stream: one byte/second; tool returned after {elapsed:.3f}s; proxy observed closed connection")

    def test_live_fetch_redirects_share_one_total_deadline(self):
        def redirect(host):
            def send(conn):
                sleep(.22)
                # The client follows Location without buffering this incomplete body.
                conn.sendall(b"HTTP/1.1 302 Found\r\nLocation: http://" + host +
                             b"/next\r\nContent-Length: 10000\r\nConnection: close\r\n\r\n")
            return send

        def final(conn):
            sleep(.55)
            conn.sendall(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok")

        with patch("web_backend.FETCH_TIMEOUT", .7):
            out, elapsed, observed, lookups, _ = self.fetch_through_loopback(
                [redirect(b"second.example"), redirect(b"third.example"), final], "http://first.example/start")
        self.assertIn("fetch_timeout", out["error"])
        self.assertLess(elapsed, 1.0)
        self.assertEqual((len(observed), lookups), (3, 3))
        print(f"redirects: {lookups} DoH lookups share one shortened deadline; elapsed {elapsed:.3f}s")

    def test_final_content_and_termination_do_not_extract_answer_json(self):
        from common import load_answers
        answer = load_answers(CASE)[CASE][0]
        content = "{'answer':'something else','context':" + repr(answer) + "}"
        task = {"caseId":CASE,"transcriptFormat":"full","messages":[{"role":"assistant","content":content}],
                "modelSteps":[{"output":{"finishReason":"stop","message":{"role":"assistant","content":content,
                    "metadata":{"chatMessage":{"content":content}}}}}]}
        self.assertEqual(final_assistant_content(task), content)
        self.assertTrue(evaluate(CASE,content)["valid"])
        self.assertFalse(evaluate(CASE,"incorrect nonspecific response")["valid"])
        task = {"status":"terminated","caseId":CASE,"taskId":"test","executionOutcome":"input_limit",
                "termination":{"reason":"input_limit","turn":1,"step":1,"inputBytes":200,"maxRequestBytes":100},
                "modelSteps":[],"completed":[],"completedTurns":0,
                "usage":{"requests":0,"inputTokens":0,"outputTokens":0,"totalTokens":0}}
        with patch("score.agentic_checker", side_effect=AssertionError("terminated must not score")) as checker:
            result = terminated_result(task)
            self.assertIs(result["officialScoring"],False)
            self.assertIs(result["valid"],False)
            checker.assert_not_called()


if __name__ == "__main__":
    unittest.main(verbosity=2)
