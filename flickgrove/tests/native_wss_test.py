"""Opt-in isolated native acceptance. Never connect to a real Grove or provider."""
import hashlib
import json
import os
from pathlib import Path
import select
import shlex
import signal
import socket
import socketserver
import ssl
import subprocess
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

REPO = Path(__file__).resolve().parents[2]
CODEX = os.environ.get("TEST_CODEX_BINARY", "")
OG = os.environ.get("TEST_OG_BINARY", "")
BUN = "/usr/local/bin/bun"


class Tunnel(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True

    def disconnect(self):
        with self.lock:
            self.offline = True
            connections = list(self.connections)
        for connection in connections:
            try:
                connection.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass


class TunnelHandler(socketserver.BaseRequestHandler):
    def handle(self):
        try:
            with self.server.context.wrap_socket(self.request, server_side=True) as client:
                with socket.create_connection(("127.0.0.1", self.server.port), timeout=3) as upstream:
                    with self.server.lock:
                        if self.server.offline:
                            return
                        self.server.connections.update((client, upstream))
                    client.settimeout(None)
                    upstream.settimeout(None)
                    pending = b""
                    upgraded = False
                    while True:
                        ready, _, _ = select.select([client, upstream], [], [], 1)
                        for src in ready:
                            data = src.recv(65536)
                            if not data:
                                return
                            if src is client:
                                pending += data
                                if not upgraded and b"\r\n\r\n" in pending:
                                    _, pending = pending.split(b"\r\n\r\n", 1)
                                    upgraded = True
                                while upgraded and len(pending) >= 2:
                                    length = pending[1] & 127
                                    offset = 2
                                    if length == 126:
                                        if len(pending) < 4: break
                                        length, offset = int.from_bytes(pending[2:4], "big"), 4
                                    elif length == 127:
                                        if len(pending) < 10: break
                                        length, offset = int.from_bytes(pending[2:10], "big"), 10
                                    masked = bool(pending[1] & 128)
                                    end = offset + (4 if masked else 0) + length
                                    if len(pending) < end: break
                                    mask = pending[offset:offset+4] if masked else b""
                                    body = pending[offset + (4 if masked else 0):end]
                                    if masked:
                                        body = bytes(value ^ mask[i % 4] for i, value in enumerate(body))
                                    if pending[0] & 15 == 1:
                                        try:
                                            message = json.loads(body)
                                            if message.get("method") == "process/start":
                                                self.server.starts.append(message["params"])
                                        except (ValueError, UnicodeDecodeError):
                                            pass
                                    pending = pending[end:]
                            (upstream if src is client else client).sendall(data)
        except (OSError, ssl.SSLError):
            return
        finally:
            with self.server.lock:
                self.server.connections.difference_update((locals().get("client"), locals().get("upstream")))


class Provider(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        self.server.requests.append(body)
        index = len(self.server.requests)
        if index == 1:
            item = {"type": "function_call", "call_id": "owned-og-call", "namespace": "mcp__og",
                    "name": self.server.tool, "arguments": json.dumps(self.server.arguments)}
        else:
            item = {"type": "message", "role": "assistant", "id": "done",
                    "content": [{"type": "output_text", "text": "done"}]}
        events = [{"type": "response.created", "response": {"id": f"owned-{index}"}},
                  {"type": "response.output_item.done", "item": item},
                  {"type": "response.completed", "response": {"id": f"owned-{index}",
                    "usage": {"input_tokens": 1, "output_tokens": 1, "total_tokens": 2}}}]
        payload = "".join(f"event: {event['type']}\ndata: {json.dumps(event)}\n\n" for event in events).encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)


def stop(process):
    if process is None:
        return
    try:
        os.killpg(process.pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    try:
        process.communicate(timeout=5)
    except subprocess.TimeoutExpired:
        os.killpg(process.pid, signal.SIGKILL)
        process.communicate(timeout=5)


def send(process, message):
    process.stdin.write(json.dumps(message) + "\n")
    process.stdin.flush()


def receive(process, predicate, events=None):
    end = time.monotonic() + 30
    while time.monotonic() < end:
        while b"\n" not in process.buffer:
            if not select.select([process.stdout], [], [], max(0, end - time.monotonic()))[0]:
                raise AssertionError("native response timed out")
            chunk = os.read(process.stdout.fileno(), 65536)
            if not chunk:
                raise AssertionError("native app server exited")
            process.buffer += chunk
        line, process.buffer = process.buffer.split(b"\n", 1)
        event = json.loads(line)
        if events is not None:
            events.append(event)
        if predicate(event):
            return event
    raise AssertionError("native response timed out")


@unittest.skipUnless(os.environ.get("RUN_NATIVE_WSS") == "1", "requires explicit resource approval")
class NativeWssTest(unittest.TestCase):
    def test_read_and_remote_og_mcp(self):
        with tempfile.TemporaryDirectory(prefix="grove-wss-", dir=os.environ["TMPDIR"]) as tmp:
            root = Path(tmp)
            app_home, codex_home, remote_home, project = [root / name for name in
                ("app-home", "app-codex", "remote-home", "project")]
            for path in (app_home, codex_home, remote_home, project):
                path.mkdir()
            registry = remote_home / ".config" / "ttal"
            registry.mkdir(parents=True)
            (registry / "projects.toml").write_text(f'[owned]\nname="Owned"\npath={json.dumps(str(project))}\nremote="https://example.invalid/owned/project.git"\n')
            (project / "index.html").write_text("owned preview")
            (root / "outside.html").write_text("outside")
            base = {"PATH": "/usr/local/bin:/usr/bin:/bin", "HOME": str(root), "TMPDIR": str(root),
                    "PYTHONDONTWRITEBYTECODE": "1", "BUN_RUNTIME_TRANSPILER_CACHE_PATH": "0",
                    "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": "/dev/null"}
            subprocess.run(["git", "init", "-q", "-b", "owned-branch", str(project)], env=base, check=True)
            ca, cert, key = root / "ca.pem", root / "cert.pem", root / "key.pem"
            for command in (
                ["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", str(root / "ca-key.pem"), "-out", str(ca), "-days", "1", "-subj", "/CN=owned-ca", "-addext", "basicConstraints=critical,CA:TRUE"],
                ["openssl", "req", "-newkey", "rsa:2048", "-nodes", "-keyout", str(key), "-out", str(root / "leaf.csr"), "-subj", "/CN=localhost"],
            ):
                subprocess.run(command, env=base, cwd=root, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=15)
            (root / "leaf.ext").write_text("basicConstraints=critical,CA:FALSE\nsubjectAltName=DNS:localhost\n")
            subprocess.run(["openssl", "x509", "-req", "-in", str(root / "leaf.csr"), "-CA", str(ca), "-CAkey", str(root / "ca-key.pem"), "-CAcreateserial", "-out", str(cert), "-days", "1", "-extfile", str(root / "leaf.ext")], env=base, cwd=root, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=15)
            with socket.socket() as sock:
                sock.bind(("127.0.0.1", 0))
                port = sock.getsockname()[1]
            token = "owned-token"
            remote_env = {**base, "HOME": str(remote_home), "CODEX_HOME": str(remote_home / ".codex"), "SHELL": "/bin/sh"}
            executor = subprocess.Popen([CODEX, "exec-server", "--listen", f"ws://127.0.0.1:{port}", "--ws-auth", "capability-token", "--ws-token-sha256", hashlib.sha256(token.encode()).hexdigest()], cwd=project, env=remote_env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
            app = proxy = provider = None
            try:
                end = time.monotonic() + 10
                while True:
                    try:
                        socket.create_connection(("127.0.0.1", port), timeout=.2).close()
                        break
                    except OSError:
                        if executor.poll() is not None or time.monotonic() > end:
                            self.fail("executor failed to start")
                        time.sleep(.05)
                proxy = Tunnel(("127.0.0.1", 0), TunnelHandler)
                proxy.port = port
                proxy.starts = []
                proxy.connections = set()
                proxy.lock = threading.Lock()
                proxy.offline = False
                proxy.context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
                proxy.context.load_cert_chain(cert, key)
                threading.Thread(target=proxy.serve_forever, daemon=True).start()
                native = codex_home / "environments.toml"
                native.write_text(f'include_local=true\n[[environments]]\nid="owned-wss"\nurl="wss://localhost:{proxy.server_address[1]}/"\nauth_bearer_token="{token}"\n')
                native.chmod(0o600)
                (root / "grove.toml").write_text(f'[[project_environments]]\nid="owned-wss"\nname="Owned"\ntransport="wss"\nog={json.dumps(OG)}\n')
                owned_env = {**base, "HOME": str(app_home), "CODEX_HOME": str(codex_home), "SSL_CERT_FILE": str(ca),
                             "CODEX_CA_CERTIFICATE": str(ca), "NODE_EXTRA_CA_CERTS": str(ca), "OWNED_WSS_ROOT": str(root),
                             "OWNED_OG_BINARY": OG, "CODEX_APP_SERVER_DISABLE_MANAGED_CONFIG": "1"}
                untrusted_env = {k: v for k, v in owned_env.items() if k not in ("SSL_CERT_FILE", "CODEX_CA_CERTIFICATE", "NODE_EXTRA_CA_CERTS")}
                subprocess.run([BUN, "run", "--no-env-file", str(REPO / "flickgrove/tests/wss-project-read.probe.ts")], env={**untrusted_env, "OWNED_WSS_UNTRUSTED": "1"}, cwd=REPO, check=True, timeout=30)
                subprocess.run([BUN, "run", "--no-env-file", str(REPO / "flickgrove/tests/wss-project-read.probe.ts")], env=owned_env, cwd=REPO, check=True, timeout=90)
                provider = ThreadingHTTPServer(("127.0.0.1", 0), Provider)
                provider.requests = []
                provider.tool = "project_list"
                provider.arguments = {}
                threading.Thread(target=provider.serve_forever, daemon=True).start()
                (codex_home / "config.toml").write_text(f'model="owned-model"\nmodel_provider="owned"\n[model_providers.owned]\nname="owned"\nbase_url="http://127.0.0.1:{provider.server_address[1]}/v1"\nwire_api="responses"\nrequires_openai_auth=false\nrequest_max_retries=0\nstream_max_retries=0\n[features]\nplugins=false\nshell_snapshot=false\n')
                local_mcp = root / "local-mcp.py"
                local_mcp.write_text('''import json,os,sys\nfrom pathlib import Path\nPath(os.environ["OWNED_MARKER"]).write_text(os.environ.get("FLICKGROVE_AGENT_TOKEN", "missing"))\nfor line in sys.stdin:\n r=json.loads(line)\n if "id" not in r: continue\n result={}\n if r["method"]=="initialize": result={"protocolVersion":"2025-03-26","capabilities":{"tools":{}},"serverInfo":{"name":"owned-local","version":"1"}}\n if r["method"]=="tools/list": result={"tools":[]}\n print(json.dumps({"jsonrpc":"2.0","id":r["id"],"result":result}),flush=True)\n''')
                og_wrapper = root / "owned-og-mcp"
                og_pid = root / "owned-og-mcp.pid"
                og_wrapper.write_text(f'#!/bin/sh\nprintf "%s" "$$" > {shlex.quote(str(og_pid))}\nexec {shlex.quote(OG)} "$@"\n')
                og_wrapper.chmod(0o700)
                app = subprocess.Popen([CODEX, "app-server", "--listen", "stdio://"], cwd=app_home, env=owned_env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, bufsize=1, start_new_session=True)
                app.buffer = b""
                send(app, {"id": 1, "method": "initialize", "params": {"clientInfo": {"name": "owned", "version": "1"}, "capabilities": {"experimentalApi": True}}})
                self.assertNotIn("error", receive(app, lambda e: e.get("id") == 1))
                send(app, {"method": "initialized"})
                selection = [{"environmentId": "owned-wss", "cwd": str(project)}]
                config = {"mcp_servers.og": {"command": str(og_wrapper), "args": ["mcp"], "cwd": str(project), "environment_id": "owned-wss", "required": True},
                          "mcp_servers.flickgrove": {"command": "/usr/bin/python3", "args": [str(local_mcp)], "cwd": str(app_home), "environment_id": "local", "required": True,
                              "env": {"FLICKGROVE_AGENT_TOKEN": "owned-local-secret", "OWNED_MARKER": str(root / "local-marker")}}}
                send(app, {"id": 2, "method": "thread/start", "params": {"cwd": str(project), "model": "owned-model", "approvalPolicy": "never", "sandbox": "danger-full-access", "environments": selection, "config": config}})
                response = receive(app, lambda e: e.get("id") == 2)
                self.assertNotIn("error", response)
                thread = response["result"]["thread"]["id"]
                send(app, {"id": 3, "method": "turn/start", "params": {"threadId": thread, "environments": selection, "input": [{"type": "text", "text": "Call the owned project list", "text_elements": []}]}})
                self.assertNotIn("error", receive(app, lambda e: e.get("id") == 3))
                completed = receive(app, lambda e: e.get("method") == "turn/completed")
                self.assertEqual(completed["params"]["turn"]["status"], "completed")
                self.assertGreaterEqual(len(provider.requests), 2)
                outputs = [item for item in provider.requests[1].get("input", []) if item.get("type") == "function_call_output" and item.get("call_id") == "owned-og-call"]
                self.assertEqual(len(outputs), 1)
                self.assertIn("owned", json.dumps(outputs[0]))
                self.assertIn(str(project), json.dumps(outputs[0]))
                self.assertEqual((root / "local-marker").read_text(), "owned-local-secret")
                self.assertTrue(any(start.get("argv", [])[0:2] == [str(og_wrapper), "mcp"] for start in proxy.starts))
                self.assertNotIn("owned-local-secret", json.dumps(proxy.starts))
                print("PASS real WSS app-server and remote og stdio MCP project_list")
                # Observe an actual og application-level isError result before
                # disconnecting the executor; it must differ structurally from
                # an invocation/transport error, without parsing error text.
                provider.requests.clear()
                provider.tool = "project_get"
                provider.arguments = {"project": "missing-owned-project"}
                app_error_events = []
                send(app, {"id": 6, "method": "turn/start", "params": {"threadId": thread, "environments": selection, "input": [{"type": "text", "text": "Look up the missing owned project", "text_elements": []}]}})
                self.assertNotIn("error", receive(app, lambda e: e.get("id") == 6, app_error_events))
                app_error_turn = receive(app, lambda e: e.get("method") == "turn/completed", app_error_events)
                app_errors = [event["params"]["item"] for event in app_error_events if event.get("method") == "item/completed" and event.get("params", {}).get("item", {}).get("type") == "mcpToolCall" and event["params"]["item"].get("server") == "og" and event["params"]["item"].get("status") == "failed"]
                self.assertEqual(len(app_errors), 1)
                self.assertIsNotNone(app_errors[0].get("result"))
                self.assertIsNone(app_errors[0].get("error"))
                self.assertEqual(app_error_turn["params"]["turn"]["status"], "completed")
                print("PASS real og application error is a failed item with result and no invocation error")
                # Terminate only the test-owned og child, not its executor or WSS.
                with proxy.lock:
                    original_connections = set(proxy.connections)
                self.assertTrue(original_connections)
                owned_pid = int(og_pid.read_text())
                pidfd = os.pidfd_open(owned_pid)
                try:
                    proc = Path(f"/proc/{owned_pid}")
                    self.assertEqual((proc / "cgroup").read_text(), Path("/proc/self/cgroup").read_text())
                    self.assertTrue(os.path.samefile(proc / "exe", OG))
                    self.assertEqual((proc / "cmdline").read_bytes().split(b"\0")[1], b"mcp")
                    signal.pidfd_send_signal(pidfd, signal.SIGKILL)
                finally:
                    os.close(pidfd)
                provider.requests.clear()
                provider.tool = "project_list"
                provider.arguments = {}
                og_events = []
                send(app, {"id": 7, "method": "turn/start", "params": {"threadId": thread, "environments": selection, "input": [{"type": "text", "text": "Call the stopped owned og", "text_elements": []}]}})
                self.assertNotIn("error", receive(app, lambda e: e.get("id") == 7, og_events))
                og_turn = receive(app, lambda e: e.get("method") == "turn/completed", og_events)
                og_failed = [event["params"]["item"] for event in og_events if event.get("method") == "item/completed" and event.get("params", {}).get("item", {}).get("type") == "mcpToolCall" and event["params"]["item"].get("server") == "og" and event["params"]["item"].get("status") == "failed"]
                print("OG_STDIO_EVENT_ORDER", json.dumps([e.get("method") for e in og_events if e.get("method") in ("item/completed", "thread/environment/disconnected", "turn/completed")]))
                self.assertEqual(len(og_failed), 1)
                self.assertIsNone(og_failed[0].get("result"))
                self.assertIsNotNone(og_failed[0].get("error"))
                self.assertEqual(og_turn["params"]["turn"]["status"], "completed")
                self.assertFalse(any(e.get("method") == "thread/environment/disconnected" for e in og_events))
                self.assertIsNone(executor.poll())
                self.assertIsNone(app.poll())
                with proxy.lock:
                    self.assertTrue(original_connections & proxy.connections)
                print("PASS stopped remote og stdio while WSS remained connected")
                # A fresh thread starts a new test-owned og for the WSS cut below.
                send(app, {"id": 8, "method": "thread/start", "params": {"cwd": str(project), "model": "owned-model", "approvalPolicy": "never", "sandbox": "danger-full-access", "environments": selection, "config": config}})
                replacement = receive(app, lambda e: e.get("id") == 8)
                self.assertNotIn("error", replacement)
                thread = replacement["result"]["thread"]["id"]
                provider.requests.clear()
                recovered_events = []
                send(app, {"id": 9, "method": "turn/start", "params": {"threadId": thread, "environments": selection, "input": [{"type": "text", "text": "Call the replacement owned og", "text_elements": []}]}})
                self.assertNotIn("error", receive(app, lambda e: e.get("id") == 9, recovered_events))
                recovered_turn = receive(app, lambda e: e.get("method") == "turn/completed", recovered_events)
                recovered_calls = [e["params"]["item"] for e in recovered_events if e.get("method") == "item/completed" and e.get("params", {}).get("item", {}).get("type") == "mcpToolCall" and e["params"]["item"].get("server") == "og" and e["params"]["item"].get("status") == "completed"]
                self.assertEqual(len(recovered_calls), 1)
                self.assertIsNotNone(recovered_calls[0].get("result"))
                self.assertEqual(recovered_turn["params"]["turn"]["status"], "completed")
                print("PASS fresh thread successfully calls replacement remote og over WSS")
                missing = {"mcp_servers.og": {**config["mcp_servers.og"], "command": str(root / "missing-og")}}
                send(app, {"id": 4, "method": "thread/start", "params": {"cwd": str(project), "model": "owned-model", "approvalPolicy": "never", "sandbox": "danger-full-access", "environments": selection, "config": missing}})
                self.assertIn("error", receive(app, lambda e: e.get("id") == 4))
                print("PASS required remote og startup failure is explicit")
                # Break the running App Server's established executor/MCP
                # connection and refuse its reconnects while keeping the App
                # Server, fake provider and local MCP alive.
                starts_before = len(proxy.starts)
                proxy.disconnect()
                self.assertIsNone(app.poll())
                provider.requests.clear()
                provider.tool = "project_list"
                provider.arguments = {}
                events = []
                send(app, {"id": 5, "method": "turn/start", "params": {"threadId": thread, "environments": selection, "input": [{"type": "text", "text": "Call the owned project list again", "text_elements": []}]}})
                restarted = receive(app, lambda e: e.get("id") == 5, events)
                self.assertNotIn("error", restarted)
                second = receive(app, lambda e: e.get("method") == "turn/completed", events)
                failures = [event["params"]["item"] for event in events if event.get("method") == "item/completed" and event.get("params", {}).get("item", {}).get("type") == "mcpToolCall" and event["params"]["item"].get("server") == "og" and event["params"]["item"].get("status") == "failed"]
                self.assertEqual(len(failures), 1)
                self.assertIsNone(failures[0].get("result"))
                self.assertIsNotNone(failures[0].get("error"))
                self.assertIn("Transport closed", failures[0]["error"]["message"])
                relevant = [event for event in events if event.get("method") in ("turn/started", "thread/environment/connected", "thread/environment/disconnected", "turn/completed") or (event.get("method") == "item/completed" and event.get("params", {}).get("item", {}).get("type") == "mcpToolCall")]
                print("DISCONNECT_EVENT_ORDER", json.dumps([event["method"] for event in relevant]))
                disconnected = [event for event in relevant if event["method"] == "thread/environment/disconnected"]
                self.assertTrue(any(event["params"] == {"threadId": thread, "environmentId": "owned-wss"} for event in disconnected))
                self.assertEqual(second["params"]["turn"]["status"], "completed")
                self.assertIsNone(second["params"]["turn"]["error"])
                self.assertEqual(len(proxy.starts), starts_before)
                self.assertIsNone(app.poll())
                print("PASS interrupted remote og MCP reports Transport closed while native turn remains completed")
                stop(app)
                app = None
                stop(executor)
                executor = None
                subprocess.run([BUN, "run", "--no-env-file", str(REPO / "flickgrove/tests/wss-project-read.probe.ts")], env={**owned_env, "OWNED_WSS_OFFLINE": "1"}, cwd=REPO, check=True, timeout=30)
            finally:
                stop(app)
                if provider:
                    provider.shutdown()
                    provider.server_close()
                if proxy:
                    proxy.shutdown()
                    proxy.server_close()
                stop(executor)
