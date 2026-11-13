"""Isolated real-gateway integration test. Set REVIEW_GATEWAY_BINARY to a built binary."""
from contextlib import closing
import copy
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import secrets
import sqlite3
import socket
import subprocess
import tempfile
import threading
import time
import unittest
import urllib.parse
import urllib.request

from backup_sqlite import copy_database
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
        if self.path.endswith("/embeddings"):
            values = request.get("input", [])
            data = {"object": "list", "model": "mock-upstream",
                    "data": [{"object": "embedding", "index": i, "embedding": [1.0, 0.0]} for i, _ in enumerate(values)],
                    "usage": {"prompt_tokens": 100, "total_tokens": 100}}
            body = json.dumps(data).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if request["messages"][0].get("role") == "system":
            submitted = request["messages"][-1]["content"]
            if "营业收入持续增长" not in submitted or "irrelevant-document" in submitted:
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
        content = "芯光智数联调成功"
        instruction = request["messages"][0]["content"]
        if instruction.startswith("Read ALL supplied material"):
            if "尾部验证" not in request["messages"][-1]["content"]:
                self.send_error(400)
                return
            content = "营业收入持续增长；尾部验证 [S1]"
        elif instruction.startswith("Organize ALL") or instruction.startswith("Answer the question using ONLY"):
            content = "## 资料主题\n营业收入持续增长；尾部验证 [S1]"
        data = {"id": "chatcmpl-review", "object": "chat.completion", "created": 1,
            "model": "mock-upstream", "choices": [{"index": 0, "message": {"role": "assistant", "content": content}, "finish_reason": "stop"}],
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

    def assert_knowledge_workflow(self, client, key, user_id, log_path):
        text = "营业收入持续增长" + "长期研究材料。" * 1100 + "尾部验证"
        boundary = "knowledge-" + secrets.token_hex(8)
        multipart = ("--" + boundary + '\r\nContent-Disposition: form-data; name="file"; filename="knowledge.txt"'
                     + "\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n" + text + "\r\n--" + boundary + "--\r\n").encode()
        request = urllib.request.Request(client.base + "/api/knowledge/extract", data=multipart,
            headers={"Authorization": "Bearer " + client.token, "Content-Type": "multipart/form-data; boundary=" + boundary})
        with client.opener.open(request, timeout=30) as response:
            extracted = json.load(response)
        self.assertTrue(extracted["success"])
        self.assertEqual(extracted["data"]["text"], text)
        document = client.call("POST", "/api/knowledge/documents", {"owner_id": user_id,
            **extracted["data"], "knowledge_base": "验证知识库", "author": "测试作者", "document_date": "2026-01-01"})
        updated = client.call("PUT", f'/api/knowledge/documents/{document["id"]}/metadata', {
            "owner_id": user_id, "knowledge_base": "验证知识库", "author": "测试作者", "topic": "收入研究",
            "document_date": "2026-01-02", "text": "must-not-replace-source"})
        self.assertEqual(updated["text"], text)
        self.assertEqual(updated["document_date"], "2026-01-02")
        matches = client.call("POST", "/api/knowledge/search", {"query": "营业收入",
            "documents": [{"id": str(document["id"]), "name": document["name"], "text": text}], "limit": 5})
        self.assertTrue(matches)
        self.assertEqual(matches[0]["document_id"], str(document["id"]))
        def relay(path, payload):
            req = urllib.request.Request(client.base + path, data=json.dumps(payload).encode(),
                headers={"Authorization": "Bearer " + key, "Content-Type": "application/json"})
            with urllib.request.urlopen(req, timeout=30) as response:
                return json.load(response)
        vectors = relay("/v1/embeddings", {"model": "xinguang-chat", "input": ["营业收入", "收入增长"]})
        self.assertEqual(len(vectors["data"]), 2)
        self.assertEqual(len(vectors["data"][0]["embedding"]), 2)
        notes = relay("/v1/agent/chat/completions", {"model": "xinguang-chat", "task": "notes",
            "question": "整理全部资料", "max_tokens": 512, "documents": [{"id": "S1", "name": document["name"], "text": text}]})
        note = notes["choices"][0]["message"]["content"]
        self.assertIn("尾部验证", note)
        organized = relay("/v1/agent/chat/completions", {"model": "xinguang-chat", "task": "organize",
            "question": "整理知识库", "max_tokens": 512, "documents": [{"id": "notes", "name": "All notes", "text": note}]})
        result = organized["choices"][0]["message"]["content"]
        self.assertIn("[S1]", result)
        answer = relay("/v1/agent/chat/completions", {"model": "xinguang-chat", "task": "answer",
            "question": "营业收入如何变化", "max_tokens": 512,
            "documents": [{"id": "S1", "name": document["name"], "text": matches[0]["text"]}]})
        self.assertIn("[S1]", answer["choices"][0]["message"]["content"])
        report = {"kind": "organize", "body": result + "\n人工修订：仍需验证。", "sources": [
            {"id": "S1", "documentId": document["id"], "name": document["name"], "start": 0, "end": len(text)}]}
        saved_payload = {"owner_id": user_id, "name": "知识库整理验证",
            "text": "<!-- research-report:v1 -->\n" + json.dumps(report, ensure_ascii=False),
            "knowledge_base": "验证知识库", "document_type": "report"}
        request = urllib.request.Request(client.base + "/api/knowledge/documents", data=json.dumps(saved_payload).encode(),
            headers={"Authorization": "Bearer " + client.token, "Content-Type": "application/json"})
        with client.opener.open(request, timeout=30) as response:
            saved_response = json.load(response)
        if not saved_response.get("success"):
            failures = [line for line in log_path.read_text(encoding="utf-8").splitlines() if "locked" in line.lower() or "SQLITE_BUSY" in line]
            self.fail(saved_response.get("message", "Save rejected") + "; " + " | ".join(failures[-3:]))
        saved = saved_response["data"]
        reopened = next(item for item in client.call("GET", "/api/knowledge/documents") if item["id"] == saved["id"])
        self.assertEqual(reopened["document_type"], "report")
        self.assertEqual(json.loads(reopened["text"].split("\n", 1)[1]), report)
        self.assertTrue(any(item["id"] == document["id"] and item["text"] == text for item in client.call("GET", "/api/knowledge/documents")))

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
                process = subprocess.Popen([os.environ["REVIEW_GATEWAY_BINARY"], "--log-dir", directory], cwd=directory, env=env, stdout=log, stderr=log, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
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
                    user_id = client.call("GET", "/api/user/self")["id"]
                    saved = client.call("POST", "/api/knowledge/documents", {"owner_id": user_id, "name": "review.txt", "text": "收入增长"})
                    self.assertEqual(client.call("GET", "/api/knowledge/documents")[0]["text"], "收入增长")
                    client.call("DELETE", f'/api/knowledge/documents/{saved["id"]}')
                    self.assertFalse(client.call("GET", "/api/knowledge/documents"))
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
                    invalid_agent = urllib.request.Request(base + "/v1/agent/chat/completions", data=json.dumps({
                        "model": "xinguang-chat", "question": "test", "max_tokens": 999999, "documents": []}).encode(),
                        headers={"Authorization": "Bearer " + key, "Content-Type": "application/json"})
                    with self.assertRaises(urllib.error.HTTPError) as rejected:
                        urllib.request.urlopen(invalid_agent, timeout=30)
                    self.assertEqual(rejected.exception.code, 400)
                    self.assert_settled_quotas(client, token["id"], after, 500000 - 140)
                    agent_request = urllib.request.Request(base + "/v1/agent/chat/completions", data=json.dumps({
                        "model": "xinguang-chat", "question": "营业收入如何", "max_tokens": 32,
                        "documents": [{"id": "report", "name": "report.txt", "text": "营业收入持续增长"},
                                      {"id": "other", "name": "other.txt", "text": "irrelevant-document"}]}).encode(),
                        headers={"Authorization": "Bearer " + key, "Content-Type": "application/json"})
                    with urllib.request.urlopen(agent_request, timeout=30) as response:
                        agent = json.load(response)
                    self.assertEqual(agent["choices"][0]["message"]["content"], "芯光智数联调成功")
                    after = before - 210
                    self.assert_settled_quotas(client, token["id"], after, 500000 - 210)
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
                    # Even a correctly signed callback must match the order and merchant.
                    for changes in ({"money": "0.01"}, {"money": "7.01"}, {"money": "7.001"},
                                    {"money": ""}, {"pid": "another-merchant"}):
                        wrong = {k: v for k, v in params.items() if k not in ("sign", "sign_type")}
                        wrong.update(changes)
                        text = "&".join(f"{k}={v}" for k, v in sorted(wrong.items()) if v)
                        wrong["sign"] = hashlib.md5((text + "local-payment-secret").encode()).hexdigest()
                        wrong["sign_type"] = "MD5"
                        with urllib.request.urlopen(base + "/api/user/epay/notify?" + urllib.parse.urlencode(wrong)) as response:
                            self.assertEqual(response.read(), b"fail")
                        with closing(sqlite3.connect(Path(directory) / "review.db")) as db:
                            self.assertEqual(db.execute("SELECT status FROM top_ups WHERE trade_no=?", (params["out_trade_no"],)).fetchone()[0], "pending")
                    invalid = dict(params, sign="invalid")
                    with urllib.request.urlopen(base + "/api/user/epay/notify?" + urllib.parse.urlencode(invalid)) as response:
                        self.assertEqual(response.read(), b"fail")
                    self.assertEqual(client.call("GET", "/api/user/self")["quota"], after)
                    for _ in range(2):
                        with urllib.request.urlopen(base + "/api/user/epay/notify?" + urllib.parse.urlencode(params)) as response:
                            self.assertEqual(response.read(), b"success")
                    self.assertEqual(client.call("GET", "/api/user/self")["quota"], after + 500000)
                    # A fresh gateway must recover a persisted intent exactly once.
                    user_id = client.call("GET", "/api/user/self")["id"]
                    process.terminate()
                    process.wait(timeout=20)
                    with closing(sqlite3.connect(Path(directory) / "review.db")) as db:
                        db.execute("UPDATE users SET quota=quota-10 WHERE id=?", (user_id,))
                        db.execute("INSERT INTO billing_refunds (id,user_id,wallet_quota,token_quota,subscription_extra,status,created_at,updated_at,attempts) VALUES (?,?,10,0,0,'pending',?,?,0)",
                                   ("restart-refund", user_id, int(time.time()), int(time.time())))
                        db.commit()
                    backup = copy_database(Path(directory) / "review.db", Path(directory) / "backup.db")
                    restored = copy_database(backup, Path(directory) / "restored.db")
                    with closing(sqlite3.connect(restored)) as db:
                        self.assertEqual(db.execute("SELECT status FROM billing_refunds WHERE id='restart-refund'").fetchone()[0], "pending")
                    with self.assertRaises(ValueError):
                        copy_database(backup, restored)
                    for restart in range(2):
                        process = subprocess.Popen([os.environ["REVIEW_GATEWAY_BINARY"], "--log-dir", directory], cwd=directory, env=env, stdout=log, stderr=log, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
                        for attempt in range(120):
                            try:
                                if client.call("GET", "/api/user/self")["quota"] == after + 500000:
                                    break
                            except (OSError, RuntimeError):
                                pass
                            time.sleep(.25)
                        else:
                            self.fail("Persisted refund did not recover after restart")
                        with closing(sqlite3.connect(Path(directory) / "review.db")) as db:
                            self.assertEqual(db.execute("SELECT status FROM billing_refunds WHERE id='restart-refund'").fetchone()[0], "done")
                        if restart == 0:
                            process.terminate()
                            process.wait(timeout=20)
                    self.assert_knowledge_workflow(client, key, user_id, Path(directory) / "server.log")
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
