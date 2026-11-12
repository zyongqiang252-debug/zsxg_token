"""Explicit, chargeable live check in an isolated gateway and temporary database."""
import argparse
import json
import os
from pathlib import Path
import secrets
import socket
import subprocess
import tempfile
import time
import urllib.error
import urllib.request

from configure import Client, configure


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--key-file", type=Path, required=True)
    parser.add_argument("--binary", type=Path, required=True)
    args = parser.parse_args()
    key = json.loads(args.key_file.read_text(encoding="utf-8-sig"))["api_key"]
    if not key:
        raise ValueError("API key is empty")
    with tempfile.TemporaryDirectory(prefix="deepseek-live-") as directory:
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            port = sock.getsockname()[1]
        base = f"http://127.0.0.1:{port}"
        env = os.environ.copy()
        env.update({"PORT": str(port), "LISTEN_ADDRESS": "127.0.0.1", "SQLITE_PATH": str(Path(directory) / "live.db"),
                    "SQL_DSN": "", "LOG_SQL_DSN": "", "REDIS_CONN_STRING": "", "SESSION_SECRET": secrets.token_hex(32),
                    "SESSION_COOKIE_SECURE": "false", "BATCH_UPDATE_ENABLED": "false", "MEMORY_CACHE_ENABLED": "false"})
        with open(Path(directory) / "server.log", "w", encoding="utf-8") as log:
            process = subprocess.Popen([str(args.binary.resolve()), "--log-dir", directory], cwd=directory, env=env, stdout=log, stderr=log)
            try:
                for _ in range(120):
                    if process.poll() is not None:
                        raise RuntimeError("Isolated gateway exited")
                    try:
                        urllib.request.urlopen(base + "/api/status", timeout=1).close()
                        break
                    except OSError:
                        time.sleep(.25)
                else:
                    raise RuntimeError("Isolated gateway did not start")
                client = Client(base, "")
                password = "Review!" + secrets.token_hex(16)
                client.call("POST", "/api/setup", {"username": "review", "password": password, "confirmPassword": password})
                client.token = client.call("POST", "/api/user/login", {"username": "review", "password": password})["access_token"]
                cfg = json.loads(Path(__file__).with_name("deepseek.example.json").read_text(encoding="utf-8"))
                cfg["gateway_url"] = base
                cfg["channel"].update({"models": ["xinguang-live"], "model_mapping": {"xinguang-live": "deepseek-flash"}})
                os.environ["UPSTREAM_API_KEY"] = key
                configure(client, cfg)
                client.call("POST", "/api/token/", {"name": "live-check", "remain_quota": 500000, "unlimited_quota": False,
                            "expired_time": -1, "group": "default", "model_limits_enabled": True, "model_limits": "xinguang-live"})
                token = client.call("GET", "/api/token/?page_size=100")["items"][0]
                token_key = client.call("POST", f'/api/token/{token["id"]}/key')["key"]
                for mode in ("chat", "stream", "agent", "agent-stream", "agent-context"):
                    stream = mode in ("stream", "agent-stream")
                    before = client.call("GET", "/api/user/self")["quota"]
                    token_before = client.call("GET", f'/api/token/{token["id"]}')["remain_quota"]
                    payload = {"model": "xinguang-live", "messages": [{"role": "user", "content": "Reply OK " + secrets.token_hex(8)}],
                               "max_tokens": 8, "stream": stream, "thinking": {"type": "disabled"}}
                    if stream:
                        payload["stream_options"] = {"include_usage": True}
                    route = "/v1/chat/completions"
                    if mode in ("agent", "agent-stream", "agent-context"):
                        route = "/v1/agent/chat/completions"
                        payload = {"model": "xinguang-live", "question": "营业收入如何？", "max_tokens": 64, "reasoning_effort": "none", "stream": stream,
                                   "documents": [{"id": "report", "name": "report.txt", "text": "本年度营业收入增长。"}]}
                    if mode == "agent-context":
                        payload["documents"] = []
                        payload["context"] = "Synthetic backtest: initial 100, final 110; no fees."
                    req = urllib.request.Request(base + route, data=json.dumps(payload).encode(),
                                                 headers={"Authorization": "Bearer " + token_key, "Content-Type": "application/json"})
                    with urllib.request.urlopen(req, timeout=60) as response:
                        if stream:
                            usage = None
                            stream_answer = ""
                            for raw in response:
                                line = raw.decode("utf-8").strip()
                                if line.startswith("data: ") and line != "data: [DONE]":
                                    event = json.loads(line[6:])
                                    usage = event.get("usage") or usage
                                    for choice in event.get("choices") or []:
                                        stream_answer += (choice.get("delta") or {}).get("content") or ""
                            if mode == "agent-stream" and not stream_answer:
                                raise RuntimeError("Agent stream did not return an answer")
                        else:
                            output = json.load(response)
                            usage = output.get("usage")
                            if mode in ("agent", "agent-context"):
                                answer = output["choices"][0]["message"].get("content") or ""
                                if not answer:
                                    raise RuntimeError("Agent did not return an answer")
                                print(json.dumps({"agent_answer": answer}, ensure_ascii=False), flush=True)
                    if not usage:
                        raise RuntimeError("Upstream usage is missing")
                    if usage.get("prompt_tokens_details", {}).get("cached_tokens", 0):
                        raise RuntimeError("This check requires uncached prompts; verify cache pricing separately")
                    # Temporary $1/M input, $2/M output, 500000 quota/USD;
                    # nonnegative half-quota values round away from zero.
                    twice_quota = usage["prompt_tokens"] + 2 * usage["completion_tokens"]
                    expected_quota = (twice_quota + 1) // 2
                    for _ in range(100):
                        after = client.call("GET", "/api/user/self")["quota"]
                        token_after = client.call("GET", f'/api/token/{token["id"]}')["remain_quota"]
                        if before - after == expected_quota and token_before - token_after == expected_quota:
                            break
                        time.sleep(.1)
                    print(json.dumps({"mode": mode, "usage": usage, "wallet_quota_charged": before-after,
                                      "token_quota_charged": token_before-token_after, "expected_quota": expected_quota}, ensure_ascii=False), flush=True)
                    if before-after != expected_quota or before-after != token_before-token_after:
                        raise RuntimeError("Wallet and token settlement did not match")
            finally:
                os.environ.pop("UPSTREAM_API_KEY", None)
                process.terminate()
                process.wait(timeout=20)


if __name__ == "__main__":
    try:
        main()
    except urllib.error.HTTPError as error:
        raise SystemExit(f"Live request failed with HTTP {error.code}; response omitted")
