"""Isolated real-gateway integration test. Set REVIEW_GATEWAY_BINARY to a built binary."""
import copy
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import secrets
import socket
import subprocess
import tempfile
import threading
import time
import unittest
import urllib.parse
import urllib.request

from configure import Client, configure, validate_config, validate_url


class ValidationTest(unittest.TestCase):
    def test_invalid_model_and_payment_shapes_are_rejected_before_requests(self):
        template = json.loads(Path(__file__).with_name("integration.example.json").read_text(encoding="utf-8"))
        for field, value in [("models", "model"), ("models", [" model "]), ("models", [{}]),
                             ("model_mapping", []), ("model_mapping", {"xinguang-chat": ""}), ("api_key_env", "")]:
            config = copy.deepcopy(template)
            config["channel"][field] = value
            if field == "models":
                config["channel"]["model_mapping"] = {}
            with self.subTest(field=field, value=value), self.assertRaises(ValueError):
                validate_config(config)
        config = copy.deepcopy(template)
        config["payment"]["enabled"] = "false"
        with self.assertRaises(ValueError):
            validate_config(config)

    def test_remote_credentials_require_tls_and_urls_cannot_embed_secrets(self):
        for url in ["http://example.com", "https://user:secret@example.com", "https://example.com?key=secret",
                    None, "https://example.com:0", "https://example.com:99999", "https://example.com/has space"]:
            with self.subTest(url=url), self.assertRaises(ValueError):
                validate_url(url)

    def test_negative_nonfinite_and_zero_temporary_prices_are_rejected(self):
        template = json.loads(Path(__file__).with_name("integration.example.json").read_text(encoding="utf-8"))
        for value in [-1, 0, float("nan"), float("inf"), True, 10**1000]:
            config = copy.deepcopy(template)
            config["temporary_prices_usd_per_million"]["input"] = value
            with self.subTest(value=value), self.assertRaises(ValueError):
                validate_config(config)


class MockUpstream(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_POST(self):
        request = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        if self.headers.get("Authorization") != "Bearer local-upstream-secret" or request.get("model") != "mock-upstream":
            self.send_error(400)
            return
        if request["messages"][0]["content"] == "fail-upstream":
            self.send_error(503)
            return
        if request.get("stream"):
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.end_headers()
            for choices, usage in [([{"index": 0, "delta": {"role": "assistant", "content": "review-stream"}, "finish_reason": None}], None),
                                   ([{"index": 0, "delta": {}, "finish_reason": "stop"}], None),
                                   ([], {"prompt_tokens": 100, "completion_tokens": 20, "total_tokens": 120})]:
                chunk = {"id": "chatcmpl-stream-review", "object": "chat.completion.chunk", "created": 1, "model": "mock-upstream", "choices": choices}
                if usage is not None:
                    chunk["usage"] = usage
                self.wfile.write(("data: " + json.dumps(chunk) + "\n\n").encode())
            self.wfile.write(b"data: [DONE]\n\n")
            self.wfile.flush()
            return
        data = {"id": "chatcmpl-review", "object": "chat.completion", "created": 1,
            "model": "mock-upstream", "choices": [{"index": 0, "message": {"role": "assistant", "content": "芯光智数联调成功"}, "finish_reason": "stop"}],
            "usage": {"prompt_tokens": 100, "completion_tokens": 20, "total_tokens": 120}}
        body = json.dumps(data).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


@unittest.skipUnless(os.environ.get("REVIEW_GATEWAY_BINARY"), "Set REVIEW_GATEWAY_BINARY for real gateway verification")
class GatewayTest(unittest.TestCase):
    def assert_settled_quotas(self, client, token_id, wallet_quota, token_quota):
        deadline = time.monotonic() + 5
        while True:
            wallet = client.call("GET", "/api/user/self")["quota"]
            remaining = client.call("GET", f"/api/token/{token_id}")["remain_quota"]
            if (wallet, remaining) == (wallet_quota, token_quota):
                return
            if time.monotonic() >= deadline:
                self.fail(f"Settlement did not finish: wallet={wallet}, token remaining={remaining}")
            time.sleep(.05)

    def test_model_mapping_wallet_token_charge_and_signed_topup_replay(self):
        with tempfile.TemporaryDirectory(prefix="xinguang-review-") as directory:
            upstream = ThreadingHTTPServer(("127.0.0.1", 0), MockUpstream)
            threading.Thread(target=upstream.serve_forever, daemon=True).start()
            with socket.socket() as sock:
                sock.bind(("127.0.0.1", 0))
                port = sock.getsockname()[1]
            base = f"http://127.0.0.1:{port}"
            env = os.environ.copy()
            env.update({"PORT": str(port), "LISTEN_ADDRESS": "127.0.0.1", "SQLITE_PATH": str(Path(directory) / "review.db"), "SQL_DSN": "", "LOG_SQL_DSN": "",
                "REDIS_CONN_STRING": "", "SESSION_SECRET": secrets.token_hex(32), "SESSION_COOKIE_SECURE": "false",
                "BATCH_UPDATE_ENABLED": "false", "MEMORY_CACHE_ENABLED": "false", "ERROR_LOG_ENABLED": "false"})
            with open(Path(directory) / "server.log", "w", encoding="utf-8") as log:
                process = subprocess.Popen([os.environ["REVIEW_GATEWAY_BINARY"], "--log-dir", directory], cwd=directory, env=env, stdout=log, stderr=log)
                try:
                    for _ in range(120):
                        if process.poll() is not None:
                            self.fail("Gateway exited: " + Path(directory, "server.log").read_text(encoding="utf-8")[-2500:])
                        try:
                            urllib.request.urlopen(base + "/api/status", timeout=1).close()
                            break
                        except OSError:
                            time.sleep(.25)
                    else:
                        self.fail("Gateway did not become ready")
                    client = Client(base, "")
                    password = "Review!" + secrets.token_hex(16)
                    client.call("POST", "/api/setup", {"username": "review", "password": password, "confirmPassword": password})
                    login = client.call("POST", "/api/user/login", {"username": "review", "password": password})
                    client.token = login["access_token"]
                    client.call("POST", "/api/option/payment_compliance", {"confirmed": True})
                    config = json.loads(Path(__file__).with_name("integration.example.json").read_text(encoding="utf-8"))
                    config["gateway_url"] = base
                    config["channel"].update({"base_url": f"http://127.0.0.1:{upstream.server_port}", "models": ["xinguang-chat"], "model_mapping": {"xinguang-chat": "mock-upstream"}})
                    config["payment"].update({"enabled": True, "gateway_url": "http://127.0.0.1:9999", "public_url": base, "merchant_id": "1001"})
                    os.environ["UPSTREAM_API_KEY"] = "local-upstream-secret"
                    os.environ["EPAY_KEY"] = "local-payment-secret"
                    first = configure(client, config)
                    self.assertEqual(first["prices_initialized"], 1)
                    self.assertEqual(configure(client, config)["prices_initialized"], 0)
                    self.assertEqual(client.call("GET", "/api/channel/?page_size=100")["total"], 1)
                    client.call("POST", "/api/token/", {"name": "review-key", "remain_quota": 500000, "unlimited_quota": False,
                        "expired_time": -1, "group": "default", "model_limits_enabled": True, "model_limits": "xinguang-chat"})
                    token = client.call("GET", "/api/token/?page_size=100")["items"][0]
                    key = client.call("POST", f'/api/token/{token["id"]}/key')["key"]
                    before = client.call("GET", "/api/user/self")["quota"]
                    req = urllib.request.Request(base + "/v1/chat/completions", data=json.dumps({"model": "xinguang-chat", "messages": [{"role": "user", "content": "ping"}]}).encode(), headers={"Authorization": "Bearer " + key, "Content-Type": "application/json"})
                    with urllib.request.urlopen(req, timeout=30) as response:
                        result = json.load(response)
                    self.assertEqual(result["choices"][0]["message"]["content"], "芯光智数联调成功")
                    deadline = time.monotonic() + 5
                    while True:
                        after = client.call("GET", "/api/user/self")["quota"]
                        remaining = client.call("GET", f'/api/token/{token["id"]}')["remain_quota"]
                        if before - after == 70 and remaining == 500000 - 70:
                            break
                        if time.monotonic() >= deadline:
                            self.fail(f"Settlement did not finish: wallet charge={before - after}, token remaining={remaining}")
                        time.sleep(.05)
                    # (100 * $1 + 20 * $2) / 1M * 500000 quota/USD = 70.
                    self.assertEqual(before - after, 70)
                    self.assertEqual(client.call("GET", f'/api/token/{token["id"]}')["remain_quota"], 500000 - 70)
                    stream_request = urllib.request.Request(base + "/v1/chat/completions", data=json.dumps({"model": "xinguang-chat",
                        "messages": [{"role": "user", "content": "ping"}], "stream": True, "stream_options": {"include_usage": True}}).encode(),
                        headers={"Authorization": "Bearer " + key, "Content-Type": "application/json"})
                    with urllib.request.urlopen(stream_request, timeout=30) as response:
                        stream = response.read()
                    self.assertIn(b"review-stream", stream)
                    self.assertIn(b"[DONE]", stream)
                    after = before - 140
                    self.assert_settled_quotas(client, token["id"], after, 500000 - 140)
                    failed_request = urllib.request.Request(base + "/v1/chat/completions", data=json.dumps({"model": "xinguang-chat",
                        "messages": [{"role": "user", "content": "fail-upstream"}]}).encode(),
                        headers={"Authorization": "Bearer " + key, "Content-Type": "application/json"})
                    with self.assertRaises(urllib.error.HTTPError) as failure:
                        urllib.request.urlopen(failed_request, timeout=30)
                    self.assertGreaterEqual(failure.exception.code, 500)
                    self.assert_settled_quotas(client, token["id"], after, 500000 - 140)
                    pricing = client.call("GET", "/api/option/model_pricing?model=xinguang-chat")["entries"][0]
                    client.call("PATCH", "/api/option/model_pricing", {"changes": [{"model_name": "xinguang-chat",
                        "expected_version": pricing["version"], "pricing": {"billing_setting.billing_mode": "tiered_expr",
                        "billing_setting.billing_expr": 'tier("administrator", p * 3 + c * 4)'}}]})
                    configure(client, config)
                    preserved = client.call("GET", "/api/option/model_pricing?model=xinguang-chat")["entries"][0]
                    self.assertIn('administrator', preserved["configured"]["billing_setting.billing_expr"])
                    with self.assertRaises(RuntimeError):
                        Client(base, "invalid-access-token").call("GET", "/api/option/")
                    req = urllib.request.Request(base + "/api/user/pay", data=json.dumps({"amount": 1, "payment_method": "alipay"}).encode(), headers={"Authorization": "Bearer " + client.token, "Content-Type": "application/json"})
                    with urllib.request.urlopen(req) as response:
                        order = json.load(response)
                    self.assertIn("url", order)
                    params = {"pid": "1001", "trade_no": "mock-review-payment", "out_trade_no": order["data"]["out_trade_no"],
                        "type": "alipay", "name": "TUC1", "money": "7.00", "trade_status": "TRADE_SUCCESS"}
                    unsigned = "&".join(f"{k}={v}" for k, v in sorted(params.items()))
                    params["sign"] = hashlib.md5((unsigned + "local-payment-secret").encode()).hexdigest()
                    params["sign_type"] = "MD5"
                    invalid = dict(params, sign="invalid")
                    with urllib.request.urlopen(base + "/api/user/epay/notify?" + urllib.parse.urlencode(invalid)) as response:
                        self.assertEqual(response.read(), b"fail")
                    self.assertEqual(client.call("GET", "/api/user/self")["quota"], after)
                    for _ in range(2):
                        with urllib.request.urlopen(base + "/api/user/epay/notify?" + urllib.parse.urlencode(params)) as response:
                            self.assertEqual(response.read(), b"success")
                    self.assertEqual(client.call("GET", "/api/user/self")["quota"], after + 500000)
                    if os.environ.get("REVIEW_SERVE") == "1":
                        access_file = Path(__file__).with_name("review-access.local.json")
                        access_file.write_text(json.dumps({"url": base, "username": "review", "password": password,
                            "note": "Local mock services only; no real payments or upstream charges"}, ensure_ascii=False, indent=2), encoding="utf-8")
                        print("Local review is ready. Access details: " + str(access_file), flush=True)
                        process.wait()
                finally:
                    process.terminate()
                    process.wait(timeout=20)
                    upstream.shutdown()
                    upstream.server_close()
                    os.environ.pop("UPSTREAM_API_KEY", None)
                    os.environ.pop("EPAY_KEY", None)


if __name__ == "__main__":
    unittest.main()
