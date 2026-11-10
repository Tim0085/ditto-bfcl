"""WebSearchAPI 的网络适配及逐题回放。"""
from contextvars import ContextVar, copy_context
import importlib.util
import ipaddress
import json
import queue
import re
import socket
import sys
import threading
from time import monotonic, sleep
from types import SimpleNamespace
from urllib.parse import urlsplit

import requests
from requests.adapters import HTTPAdapter, _urllib3_request_context
from urllib3.connection import HTTPConnection, HTTPSConnection
from urllib3.connectionpool import HTTPConnectionPool, HTTPSConnectionPool
from urllib3.exceptions import ConnectTimeoutError, NewConnectionError
from urllib3.util.connection import _set_socket_options
from urllib3.util.timeout import Timeout


SEARCH_TIMEOUT = 900
# 容器内中继连不上宿主出口时的固定应答（scripts/docker-entry.py 的 REJECT_RESPONSE）；只有它表示请求一个字节都没发到出口。
SEARCH_RELAY_NOT_CONNECTED_HEADERS = [("connection", "close"), ("content-length", "38"), ("content-type", "text/plain"),
                                      ("x-ditto-relay", "upstream-not-connected-v1")]
SEARCH_RELAY_NOT_CONNECTED_BODY = b"DITTO_RELAY_UPSTREAM_NOT_CONNECTED_V1\n"
SEARCH_CONNECT_RETRY_WAITS = (1, 2, 4)
FETCH_TIMEOUT = 60
FETCH_MAX_BYTES = 16 * 1024 * 1024
FETCH_TIMEOUT_ERROR = "fetch_timeout: 网页抓取超过总时限（60 秒）"
DOH_TIMEOUT = 20
DOH_MAX_BYTES = 65_536
DOH_URL = "https://dns.google/resolve"
SEARCH_NAME = "search_engine_query"
FETCH_NAME = "fetch_url_content"


class WebChannelError(RuntimeError):
    """工具通道故障，不能当作工具观察交给模型。"""


class _SearchAbort(BaseException):
    # 官方 search_engine_query 捕获 Exception，而且字符串里含 429 时会重试。
    def __init__(self, kind, message):
        self.kind, self.message = kind, message


def wire(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False)


class _FetchDeadline:
    """同一个截止时间覆盖 DoH、跳转及正文；关闭副本可中断 TLS/HTTP 读取。"""
    def __init__(self):
        self.end = monotonic() + FETCH_TIMEOUT
        self.lock = threading.Lock()
        self.sockets = []
        self.closed = False

    def remaining(self):
        seconds = self.end - monotonic()
        if self.closed or seconds <= 0:
            raise TimeoutError(FETCH_TIMEOUT_ERROR)
        return seconds

    def track(self, sock):
        with self.lock:
            self.remaining()
            self.sockets.append((sock, sock.dup()))

    def close(self):
        with self.lock:
            self.closed = True
            sockets, self.sockets = self.sockets, []
        for sock, duplicate in sockets:
            try:
                sock.shutdown(socket.SHUT_RDWR)
            except OSError:
                # TLS may already have transferred the original socket handle.
                try:
                    duplicate.shutdown(socket.SHUT_RDWR)
                except OSError:
                    pass
            finally:
                duplicate.close()


_FETCH_DEADLINE = ContextVar("web_fetch_deadline", default=None)


class _FetchSession(requests.Session):
    def resolve_redirects(self, response, request, **kwargs):
        if response.is_redirect:
            # Requests 默认会先把跳转正文读完。只需要响应头来选择下一跳。
            response.close()
            response._content = b""
        return super().resolve_redirects(response, request, **kwargs)


def _fetch_error_text(error, url):
    message = str(error)
    pattern = r"""\b\w*Pool\(host=(?:'[^']*'|"[^"]*"), port=\d+\)|(?<![\d.])(?:[0-9]{1,3}\.){3}[0-9]{1,3}(?![\d.])"""
    return re.sub(pattern, lambda _: url, message)


class _ProxyConnection:
    def _new_conn(self):
        deadline = _FETCH_DEADLINE.get()
        if deadline is not None:
            deadline.remaining()
        try:
            address = ipaddress.ip_address(self.host.strip("[]"))
        except ValueError:
            # 此处 host 是冻结计划的代理地址，网页域名和 DoH 域名都走隧道。
            sock = super()._new_conn()
            if deadline is not None:
                try:
                    deadline.track(sock)
                except Exception:
                    sock.close()
                    raise
            return sock
        family = socket.AF_INET if address.version == 4 else socket.AF_INET6
        sock = socket.socket(family, socket.SOCK_STREAM)
        try:
            _set_socket_options(sock, self.socket_options)
            sock.settimeout(Timeout.resolve_default_timeout(self.timeout))
            if self.source_address:
                sock.bind(self.source_address)
            sock.connect((str(address), self.port))
            if deadline is not None:
                deadline.track(sock)
            return sock
        except OSError as error:
            sock.close()
            if isinstance(error, TimeoutError):
                raise ConnectTimeoutError(self, f"连接代理超时（{self.timeout} 秒）") from error
            raise NewConnectionError(self, f"无法连接代理：{error}") from error


class _ProxyHttpsConnection(_ProxyConnection, HTTPSConnection):
    pass


class _ProxyHttpsPool(HTTPSConnectionPool):
    ConnectionCls = _ProxyHttpsConnection


class _ProxyAdapter(HTTPAdapter):
    def proxy_manager_for(self, proxy, **kwargs):
        manager = super().proxy_manager_for(proxy, **kwargs)
        manager.pool_classes_by_scheme = {**manager.pool_classes_by_scheme, "https": _ProxyHttpsPool}
        return manager


def _doh_body(proxy, host):
    # 只有固定的 DoH 服务允许由代理解析。该 Session 不装网页适配器，以免循环解析。
    with requests.Session() as session:
        session.trust_env = False
        session.mount("https://", _ProxyAdapter())
        with session.get(DOH_URL, params={"name": host, "type": "A"},
                         headers={"Accept": "application/dns-json", "Accept-Encoding": "identity"},
                         proxies={"https": proxy}, verify=True, allow_redirects=False,
                         timeout=DOH_TIMEOUT, stream=True) as response:
            if response.status_code != 200:
                raise ValueError("dns_lookup_failed: 代理DNS未返回可用地址")
            body = bytearray()
            for chunk in response.iter_content(8192):
                if len(body) + len(chunk) > DOH_MAX_BYTES:
                    raise ValueError("dns_lookup_failed: 代理DNS返回的内容无法解析")
                body.extend(chunk)
            return body


def _public_address(proxy, host):
    try:
        ipaddress.ip_address(host)
    except ValueError:
        pass
    else:
        raise ValueError("不允许网页使用 IP 字面量")
    if host.rstrip(".").lower() == "localhost" or host.rstrip(".").lower().endswith(".localhost"):
        raise ValueError("private_address: 网页目的地包含非公网地址，已阻止访问")

    result = queue.Queue(maxsize=1)

    def resolve():
        try:
            result.put((True, _doh_body(proxy, host)))
        except ValueError as error:
            result.put((False, str(error)))
        except (requests.RequestException, OSError):
            result.put((False, "dns_lookup_failed: 代理DNS查询失败"))

    # requests 的 timeout 限制连接和单次读，另限制本次 DoH 的总等待。
    deadline = _FETCH_DEADLINE.get()
    wait = DOH_TIMEOUT if deadline is None else min(DOH_TIMEOUT, deadline.remaining())
    threading.Thread(target=copy_context().run, args=(resolve,), daemon=True).start()
    try:
        ok, body = result.get(timeout=wait)
    except queue.Empty:
        raise ValueError("dns_lookup_failed: 代理DNS查询超时") from None
    if not ok:
        raise ValueError(body)
    try:
        payload = json.loads(body)
    except ValueError:
        raise ValueError("dns_lookup_failed: 代理DNS返回的内容无法解析") from None
    if not isinstance(payload, dict) or type(payload.get("Status")) is not int or payload["Status"] != 0:
        raise ValueError("dns_lookup_failed: 代理DNS未返回可用地址")
    rows = payload.get("Answer", [])
    if not isinstance(rows, list) or any(not isinstance(row, dict) or type(row.get("type")) is not int for row in rows):
        raise ValueError("dns_lookup_failed: 代理DNS返回的内容无法解析")
    a_records = [row.get("data") for row in rows if row["type"] == 1]
    try:
        if any(not isinstance(value, str) for value in a_records):
            raise ValueError("invalid A record")
        addresses = [ipaddress.IPv4Address(value) for value in a_records]
    except ValueError:
        raise ValueError("dns_lookup_failed: 代理DNS返回的内容无法解析") from None
    if not addresses:
        raise ValueError("dns_lookup_failed: 代理DNS未返回IPv4地址")
    if any(not ip.is_global or ip.is_multicast or ip.is_reserved for ip in addresses):
        raise ValueError("private_address: 网页目的地包含非公网地址，已阻止访问")
    return addresses[0]


class _PlainTunnelConnection(_ProxyConnection, HTTPConnection):
    """urllib3 默认转发 HTTP；明文网页也经 CONNECT 固定到已经检查的 IP。"""
    def __init__(self, host, port, *, proxy_host, proxy_port, **kwargs):
        super().__init__(proxy_host, proxy_port, **kwargs)
        self.target = (host, port)

    def connect(self):
        self.set_tunnel(*self.target)
        super().connect()


class _PlainTunnelPool(HTTPConnectionPool):
    ConnectionCls = _PlainTunnelConnection


class PublicProxyAdapter(_ProxyAdapter):
    """每一跳都经代理 DoH，再由同一代理连接已检查的 IP，TLS 仍校验原域名。"""
    def __init__(self, proxy):
        super().__init__()
        self.proxy = proxy
        self.plain_pools = {}

    def get_connection_with_tls_context(self, request, verify, proxies=None, cert=None):
        url = urlsplit(request.url)
        if url.scheme not in ("http", "https") or not url.hostname or url.username is not None or url.password is not None:
            raise ValueError("网页地址须使用 HTTP(S) 且不能携带账号")
        ip = str(_public_address(self.proxy, url.hostname))
        request.headers["Host"] = url.netloc
        if url.scheme == "http":
            key = (ip, url.port or 80)
            if key not in self.plain_pools:
                proxy = urlsplit(self.proxy)
                self.plain_pools[key] = _PlainTunnelPool(*key, proxy_host=proxy.hostname, proxy_port=proxy.port)
            return self.plain_pools[key]
        host_params, pool = _urllib3_request_context(request, verify, cert)
        host_params["host"] = ip
        pool.update(server_hostname=url.hostname, assert_hostname=url.hostname)
        return self.proxy_manager_for(self.proxy).connection_from_host(**host_params, pool_kwargs=pool)

    def request_url(self, request, proxies):
        # CONNECT 隧道内使用 origin-form，Host 仍是原域名。
        return super().request_url(request, {})

    def close(self):
        for pool in self.plain_pools.values():
            pool.close()
        super().close()


def _search_arguments(arguments):
    if set(arguments) - {"keywords", "max_results", "region"}:
        raise ValueError("搜索工具包含不支持的参数")
    keywords = arguments.get("keywords")
    count = arguments.get("max_results", 10)
    region = arguments.get("region", "wt-wt")
    if not isinstance(keywords, str) or not keywords.strip() or len(keywords) > 128:
        raise ValueError("keywords 必须为 1–128 个字符且不能全为空白")
    if type(count) is float and count.is_integer():
        count = int(count)
    if type(count) is not int or not 1 <= count <= 50:
        raise ValueError("max_results 必须为 1–50 的整数")
    if region != "wt-wt":
        raise ValueError("region 只能是 wt-wt")
    return {"keywords": keywords, "max_results": count, "region": region}


def _fetch_arguments(arguments):
    if set(arguments) - {"url", "mode"}:
        raise ValueError("抓网页工具包含不支持的参数")
    url, mode = arguments.get("url"), arguments.get("mode", "raw")
    if not isinstance(url, str) or not url.startswith(("http://", "https://")) or mode not in ("raw", "markdown", "truncate"):
        raise ValueError("抓网页需要 HTTP(S) 地址及 raw、markdown 或 truncate 模式")
    return {"url": url, "mode": mode}


class WebBackend:
    def __init__(self, root, case, settings):
        if not isinstance(settings, dict) or settings.get("mode") not in ("fixture", "replay", "live"):
            raise ValueError("Web 工具缺少冻结的执行模式")
        self.mode = settings["mode"]
        self.search_count = self.call_count = 0
        self._query = None
        self.records = None
        self.session = None
        self.settings = settings
        self.case_id = case["id"]
        if self.mode == "replay":
            with (root / "data/replay/tools" / (self.case_id + ".json")).open(encoding="utf-8") as f:
                self.records = json.load(f)
            if self.records["caseId"] != self.case_id:
                raise WebChannelError("回放题号不一致")
            self.records = self.records["calls"]
        if self.mode == "live":
            endpoint = urlsplit(settings["searchEndpoint"])
            if (endpoint.scheme != "http" or endpoint.hostname != "127.0.0.1" or not endpoint.port
                    or endpoint.netloc != f"127.0.0.1:{endpoint.port}" or endpoint.path != "/v1/search"
                    or endpoint.query or endpoint.fragment or not settings.get("taskId") or not settings.get("configId")):
                raise ValueError("搜索出口需要指定的本机地址、任务和配置编号")
            proxy = urlsplit(settings["fetchProxy"])
            if (proxy.scheme != "http" or not proxy.hostname or not proxy.port or proxy.username is not None
                    or proxy.password is not None or proxy.path not in ("", "/") or proxy.query or proxy.fragment):
                raise ValueError("冻结计划的抓网页代理地址无效")
            self.session = requests.Session()
            self.session.trust_env = False
        # 每题独立加载模块，两个网络入口的替换不会串到别的题。
        source = root / "vendor/bfcl_eval/eval_checker/multi_turn_eval/func_source_code/web_search.py"
        spec = importlib.util.spec_from_file_location("wa_official_web_search", source)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        module.os = SimpleNamespace(getenv=lambda name: None)
        module.GoogleSearch = lambda params: SimpleNamespace(get_dict=self._search)
        module.requests = SimpleNamespace(get=self._fetch)
        self.api = module.WebSearchAPI()
        self.api._load_scenario(case["initial_config"]["WebSearchAPI"])

    def _search(self):
        if self.mode == "fixture":
            return {"organic_results": [
                {"title": "Fixture result", "link": "https://example.org/fixture", "snippet": "Fixture snippet."},
                {"title": "Second fixture result", "link": "https://example.org/second", "snippet": "Second fixture snippet."},
            ]}
        payload = {"protocol": "bfcl-web-search-v1", "configId": self.settings["configId"],
                   "taskId": self.settings["taskId"], "caseId": "web_search_" + self.case_id.rsplit("_", 1)[1],
                   "call": self.search_count, "query": self._query}
        result = queue.Queue(maxsize=1)
        deadline, not_connected = monotonic() + SEARCH_TIMEOUT, object()

        def post():
            # 每次搜索用一条新连接（与问模型一路一致）：用完即关闭连接池，不复用可能已被出口按空闲超时关掉的 keep-alive 连接。
            try:
                with self.session.post(self.settings["searchEndpoint"], json=payload, timeout=SEARCH_TIMEOUT,
                                       allow_redirects=False) as response:
                    # 只认中继的固定"没连上"应答：状态码、头、正文完全相同（判法同 model-client.ts），这时请求没到出口，可以重连。
                    if (response.status_code == 502 and response.content == SEARCH_RELAY_NOT_CONNECTED_BODY
                            and sorted((k.lower(), v) for k, v in response.raw.headers.items()) == SEARCH_RELAY_NOT_CONNECTED_HEADERS):
                        return not_connected
                    if response.status_code != 200:
                        raise ValueError("搜索出口状态无效")
                    return response.json()
            finally:
                self.session.close()

        def send():
            # 没连上时按 1、2、4 秒最多重连 3 次，等待算在 15 分钟总等待里；其他任何错误（连上后断开、超时、别的状态码、
            # 回复不合约定）请求可能已到出口、可能已计费，一律不重试，照旧算通道失败。
            retries, waited, outcome = 0, 0.0, (False, None)
            try:
                while True:
                    reply = post()
                    if reply is not not_connected:
                        outcome = (True, reply)
                        break
                    if retries == len(SEARCH_CONNECT_RETRY_WAITS) or monotonic() + SEARCH_CONNECT_RETRY_WAITS[retries] >= deadline:
                        break
                    started = monotonic()
                    sleep(SEARCH_CONNECT_RETRY_WAITS[retries])
                    waited += monotonic() - started
                    retries += 1
            except Exception:
                pass
            if retries:
                # 重连次数和等待只写 stderr，交给模型的工具结果不变。
                try:
                    print(wire({"searchConnectRetries": retries, "searchConnectRetryWaitMs": round(waited * 1000),
                                "call": payload["call"], "outcome": "ok" if outcome[0] else "channel"}), file=sys.stderr, flush=True)
                except Exception:
                    pass
            result.put(outcome)

        # requests 的 read timeout 是两次读之间的上限，另限制一次搜索的总等待。
        threading.Thread(target=send, daemon=True).start()
        try:
            ok, reply = result.get(timeout=SEARCH_TIMEOUT)
        except queue.Empty:
            raise _SearchAbort("channel", "搜索出口总等待超过 15 分钟") from None
        if not ok or not isinstance(reply, dict):
            raise _SearchAbort("channel", "搜索出口连接断开或回复无效")
        if reply.get("ok") is True and isinstance(reply.get("output"), dict):
            organic = reply["output"].get("organic_results")
            if isinstance(organic, list) and all(isinstance(row, dict) and all(isinstance(row.get(k), str)
                    for k in ("title", "link", "snippet")) for row in organic):
                return reply["output"]
        if reply.get("ok") is False and isinstance(reply.get("error"), dict):
            error = reply["error"]
            if error.get("kind") in ("invalid_argument", "search_failed", "run_stop") and isinstance(error.get("message"), str):
                raise _SearchAbort(error["kind"], error["message"])
        raise _SearchAbort("channel", "搜索出口回复不符合约定")

    def _fetch(self, url, **kwargs):
        if self.mode == "fixture":
            return SimpleNamespace(text="Fixture webpage body.", raise_for_status=lambda: None)
        proxy = self.settings["fetchProxy"]
        deadline = _FetchDeadline()
        completed = queue.Queue(maxsize=1)

        def download():
            token = _FETCH_DEADLINE.set(deadline)
            try:
                with _FetchSession() as session:
                    session.trust_env = False
                    adapter = PublicProxyAdapter(proxy)
                    session.mount("https://", adapter)
                    session.mount("http://", adapter)
                    with session.get(url, proxies={"http": proxy, "https": proxy}, stream=True, **kwargs) as response:
                        body = bytearray()
                        for chunk in response.iter_content(64 * 1024):
                            deadline.remaining()
                            if len(body) + len(chunk) > FETCH_MAX_BYTES:
                                raise ValueError("response_too_large: 网页正文超过 16 MiB")
                            body.extend(chunk)
                        response._content = bytes(body)
                        response._content_consumed = True
                completed.put((True, response))
            except Exception as error:
                completed.put((False, error))
            finally:
                _FETCH_DEADLINE.reset(token)

        threading.Thread(target=download, daemon=True).start()
        try:
            try:
                ok, value = completed.get(timeout=deadline.remaining())
            except queue.Empty:
                raise TimeoutError(FETCH_TIMEOUT_ERROR) from None
            deadline.remaining()
            if not ok:
                message = _fetch_error_text(value, url)
                if message != str(value):
                    raise ValueError(message) from None
                raise value
            return value
        finally:
            deadline.close()

    def call(self, name, arguments):
        self.call_count += 1
        if self.mode == "replay":
            offset = self.call_count - 1
            if offset >= len(self.records):
                raise WebChannelError(f"回放错误：缺少第 {self.call_count} 个工具结果")
            expected = self.records[offset]
            if (name != expected["name"] or json.dumps(arguments, sort_keys=True) != json.dumps(expected["arguments"], sort_keys=True)
                    or not isinstance(expected["observation"], str)):
                raise WebChannelError(f"回放错误：第 {self.call_count} 个工具名或参数不一致")
            return expected["observation"]
        if name == SEARCH_NAME:
            self.search_count += 1
        try:
            if not isinstance(arguments, dict):
                raise ValueError("工具参数必须为 JSON 对象")
            if name == SEARCH_NAME:
                self._query = _search_arguments(arguments)
                return wire(self.api.search_engine_query(**self._query))
            if name == FETCH_NAME:
                return wire(self.api.fetch_url_content(**_fetch_arguments(arguments)))
            raise ValueError("未知 Web 工具")
        except ValueError as error:
            return wire({"error": str(error)})
        except _SearchAbort as error:
            if error.kind == "run_stop":
                raise WebChannelError("BFCL_RUN_STOP:" + error.message) from None
            if error.kind == "channel":
                raise WebChannelError(error.message) from None
            return wire({"error": f"{error.kind}: {error.message}"})
