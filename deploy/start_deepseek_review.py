"""Start an isolated loopback review instance backed by real DeepSeek calls."""
import argparse
import json
import os
from pathlib import Path
import secrets
import subprocess
import time
import urllib.request

from configure import Client, configure


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--binary", type=Path, required=True)
    parser.add_argument("--key-file", type=Path, required=True)
    parser.add_argument("--port", type=int, default=65162)
    parser.add_argument("--access-file", type=Path, default=Path(__file__).with_name("deepseek-preview.local.json"))
    args = parser.parse_args()
    root = Path(__file__).resolve().parent
    access_file = args.access_file.resolve()
    if access_file.parent != root or not access_file.name.endswith(".local.json"):
        raise ValueError("Access file must be a .local.json file in deploy")
    if access_file.exists():
        raise RuntimeError("Preview access file already exists; do not overwrite existing review")
    api_key = json.loads(args.key_file.read_text(encoding="utf-8-sig"))["api_key"]
    if not api_key or not 1024 <= args.port <= 65535:
        raise ValueError("Missing key or invalid port")
    work = root.parent.parent / "zsxg_token-env" / "data" / ("deepseek-review-" + secrets.token_hex(6))
    work.mkdir(parents=True, exist_ok=False)
    env = os.environ.copy()
    env.update({"PORT": str(args.port), "LISTEN_ADDRESS": "127.0.0.1", "SQLITE_PATH": str(work / "review.db"),
                "SQL_DSN": "", "LOG_SQL_DSN": "", "REDIS_CONN_STRING": "", "SESSION_SECRET": secrets.token_hex(32),
                "SESSION_COOKIE_SECURE": "false", "BATCH_UPDATE_ENABLED": "false", "MEMORY_CACHE_ENABLED": "false"})
    base = f"http://127.0.0.1:{args.port}"
    with (work / "server.log").open("w", encoding="utf-8") as log:
        process = subprocess.Popen([str(args.binary.resolve()), "--log-dir", str(work)], cwd=work, env=env, stdout=log, stderr=log)
        try:
            for _ in range(120):
                if process.poll() is not None:
                    raise RuntimeError("Gateway exited before startup")
                try:
                    urllib.request.urlopen(base + "/api/status", timeout=1).close()
                    break
                except OSError:
                    time.sleep(.25)
            else:
                raise RuntimeError("Gateway did not start")
            client = Client(base, "")
            password = "Review!" + secrets.token_hex(16)
            client.call("POST", "/api/setup", {"username": "review", "password": password, "confirmPassword": password})
            client.token = client.call("POST", "/api/user/login", {"username": "review", "password": password})["access_token"]
            config = json.loads((root / "deepseek.example.json").read_text(encoding="utf-8-sig"))
            config["gateway_url"] = base
            os.environ["UPSTREAM_API_KEY"] = api_key
            configure(client, config)
            client.call("POST", "/api/token/", {"name": "review-limited", "remain_quota": 10000, "unlimited_quota": False,
                        "expired_time": -1, "group": "default", "model_limits_enabled": True, "model_limits": "deepseek-flash"})
            token = client.call("GET", "/api/token/?page_size=100")["items"][0]
            app_token = client.call("POST", f'/api/token/{token["id"]}/key')["key"]
            access = {"url": base + "/research", "username": "review", "password": password, "api_token": app_token,
                      "data_directory": str(work), "note": "Real DeepSeek requests incur charges; token has 10000 temporary quota."}
            with access_file.open("x", encoding="utf-8") as handle:
                json.dump(access, handle, ensure_ascii=False, indent=2)
            os.environ.pop("UPSTREAM_API_KEY", None)
            process.wait()
        finally:
            if process.poll() is None:
                process.terminate()
                process.wait(timeout=20)


if __name__ == "__main__":
    main()
