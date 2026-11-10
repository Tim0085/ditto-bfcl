"""Fixed-destination loopback relay and signal-forwarding supervisor. No dependencies."""
import argparse
import json
import os
import re
import signal
import socket
import socketserver
import subprocess
import sys
import threading
import time
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('--target', required=True)
args = parser.parse_args()
if not re.fullmatch(r'host\.docker\.internal:[0-9]{1,5}', args.target):
    parser.error('only the host egress destination is permitted')
port = int(args.target.split(':')[1])
if not 1 <= port <= 65535:
    parser.error('invalid egress port')
target_ipv4 = socket.getaddrinfo('host.docker.internal', port, socket.AF_INET, socket.SOCK_STREAM)[0][4]
CONNECT_TIMEOUT = 3  # Local host hop: fail promptly; the client owns 1/2/4 second retries.
NOT_CONNECTED = b'DITTO_RELAY_UPSTREAM_NOT_CONNECTED_V1\n'
REJECT_RESPONSE = (b'HTTP/1.1 502 Bad Gateway\r\n'
                   b'X-Ditto-Relay: upstream-not-connected-v1\r\n'
                   b'Content-Type: text/plain\r\n'
                   b'Content-Length: ' + str(len(NOT_CONNECTED)).encode('ascii') +
                   b'\r\nConnection: close\r\n\r\n' + NOT_CONNECTED)
relay_log_lock = threading.Lock()

class Relay(socketserver.BaseRequestHandler):
    def reject_unconnected(self, error):
        try:
            with relay_log_lock, open('/unit/relay.jsonl', 'a') as output:
                output.write(json.dumps({'at': time.time(), 'error': repr(error)}) + '\n')
        except OSError as log_error:
            # Diagnostics must not turn an unconnected upstream into socket reset.
            try:
                print(json.dumps({'relayLogError': repr(log_error), 'error': repr(error)}), file=sys.stderr, flush=True)
            except OSError:
                pass
        # Drain ONE complete HTTP request before replying. Closing with unread Linux
        # receive buffers sends RST; replying before the upload ends can cause EPIPE.
        # The Node client sends Content-Length or chunked encoding, never a stream
        # delimited by EOF. No request byte has been written to the failed upstream.
        self.request.settimeout(30)
        with self.request.makefile('rb') as request:
            def line():
                value = request.readline(65537)
                if not value or len(value) > 65536 or not value.endswith(b'\r\n'):
                    raise ValueError('incomplete/oversized HTTP line')
                return value
            def consume(size):
                while size:
                    data = request.read(min(size, 65536))
                    if not data:
                        raise ValueError('incomplete HTTP body')
                    size -= len(data)
            line()
            headers = {}
            total = 0
            while (header := line()) != b'\r\n':
                total += len(header)
                if total > 65536:
                    raise ValueError('oversized HTTP headers')
                key, value = header.split(b':', 1)
                headers[key.lower()] = value.strip()
            if headers.get(b'transfer-encoding', b'').lower() == b'chunked':
                while True:
                    size = int(line().split(b';', 1)[0], 16)
                    if size < 0:
                        raise ValueError('invalid chunk size')
                    if not size:
                        while line() != b'\r\n':
                            pass
                        break
                    consume(size)
                    if line() != b'\r\n':
                        raise ValueError('invalid chunk delimiter')
            else:
                size = int(headers.get(b'content-length', b'0'))
                if size < 0:
                    raise ValueError('invalid content length')
                consume(size)
        self.request.sendall(REJECT_RESPONSE)
        self.request.shutdown(socket.SHUT_WR)

    def handle(self):
        # Request data is never used to choose the destination (no CONNECT/proxy routing).
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as upstream:
            upstream.settimeout(CONNECT_TIMEOUT)
            try:
                upstream.connect(target_ipv4)
            except OSError as error:
                self.reject_unconnected(error)
                return
            upstream.settimeout(None)
            def copy(source, target):
                try:
                    while data := source.recv(65536):
                        target.sendall(data)
                except OSError:
                    pass
                finally:
                    try:
                        target.shutdown(socket.SHUT_WR)
                    except OSError:
                        pass
            thread = threading.Thread(target=copy, args=(self.request, upstream), daemon=True)
            thread.start()
            copy(upstream, self.request)
            thread.join()

class Server(socketserver.ThreadingTCPServer):
    daemon_threads = True
    allow_reuse_address = True
    request_queue_size = 128

runtime = {'clockTicks': int(subprocess.check_output(['getconf', 'CLK_TCK'])),
           'pageBytes': int(subprocess.check_output(['getconf', 'PAGESIZE']))}
block = json.loads(Path('/unit/block.json').read_text())
if any(block['sampling'][key] != value for key, value in runtime.items()):
    raise RuntimeError('plan getconf values differ from actual container')
Path('/unit/runtime.json').write_text(json.dumps(runtime))
server = Server(('127.0.0.1', 18080), Relay)
threading.Thread(target=server.serve_forever, daemon=True).start()
env = dict(os.environ, NODE_OPTIONS='--import=/app/scripts/egress-offline-guard.mjs',
           OFFLINE_GUARD_REPORT_DIR='/guard', PYTHONDONTWRITEBYTECODE='1')
child = None
pending_stop = False
def stop(signum, frame):
    global pending_stop
    pending_stop = True
    with open('/unit/signals.jsonl', 'a') as signals:
        signals.write(json.dumps({'at': time.time(), 'signal': 'SIGTERM', 'childPid': child.pid if child else None}) + '\n')
    if child is not None and child.poll() is None:
        child.send_signal(signal.SIGTERM)
signal.signal(signal.SIGTERM, stop)
child = subprocess.Popen(['node', '--experimental-transform-types', 'src/ts/config-main.ts', '--block', '/unit/block.json'], env=env)
if pending_stop:
    child.send_signal(signal.SIGTERM)
with open('/unit/pids.jsonl', 'x') as output:
    previous = None
    last_write = 0
    while child.poll() is None:
        values = (int(Path('/sys/fs/cgroup/pids.current').read_text()), int(Path('/sys/fs/cgroup/pids.peak').read_text()))
        now = time.monotonic()
        if values != previous or now - last_write >= 30:
            output.write(json.dumps({'at': time.time(), 'current': values[0], 'peak': values[1]}) + '\n')
            output.flush()
            previous, last_write = values, now
        time.sleep(0.05)
    # pids.peak is cumulative; always capture a final sample, including short spikes.
    output.write(json.dumps({'at': time.time(), 'current': int(Path('/sys/fs/cgroup/pids.current').read_text()),
                             'peak': int(Path('/sys/fs/cgroup/pids.peak').read_text())}) + '\n')
server.shutdown()
server.server_close()
raise SystemExit(child.returncode if child.returncode >= 0 else 128-child.returncode)
