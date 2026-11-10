"""Configure existing New API endpoints; no direct database writes or secret output."""
import argparse
import json
import math
import os
from pathlib import Path
import urllib.error
import urllib.parse
import urllib.request


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise RuntimeError("Redirect refused; check the configured URL")


def validate_url(value):
    if not isinstance(value, str) or not value or any(char.isspace() for char in value):
        raise ValueError("URLs must be non-empty strings without whitespace")
    parsed = urllib.parse.urlsplit(value)
    if parsed.username is not None or parsed.password is not None or parsed.query or parsed.fragment:
        raise ValueError("URLs must not contain credentials, query strings or fragments")
    if not parsed.hostname or parsed.scheme not in ("http", "https"):
        raise ValueError("An absolute HTTP(S) URL is required")
    if parsed.port is not None and parsed.port == 0:
        raise ValueError("URL port must be between 1 and 65535")
    if parsed.scheme != "https" and parsed.hostname not in ("localhost", "127.0.0.1", "::1"):
        raise ValueError("Non-loopback services require HTTPS")
    return value.rstrip("/")


class Client:
    def __init__(self, base, token):
        self.base = validate_url(base)
        self.token = token
        self.opener = urllib.request.build_opener(NoRedirect())

    def call(self, method, path, payload=None):
        data = None if payload is None else json.dumps(payload).encode()
        req = urllib.request.Request(self.base + path, data=data, method=method,
            headers={"Authorization": "Bearer " + self.token, "Content-Type": "application/json"})
        try:
            with self.opener.open(req, timeout=30) as response:
                result = json.load(response)
        except urllib.error.HTTPError as exc:
            raise RuntimeError(f"{method} {path.split('?')[0]} failed: HTTP {exc.code}") from None
        except (urllib.error.URLError, ValueError):
            raise RuntimeError(f"{method} {path.split('?')[0]} failed: connection or response error") from None
        if result.get("success") is not True:
            # Server messages can echo submitted credentials. Do not print them.
            raise RuntimeError(f"{method} {path.split('?')[0]} rejected; inspect the dashboard")
        return result.get("data")


def validate_config(config):
    if not isinstance(config, dict):
        raise ValueError("Configuration must be a JSON object")
    validate_url(config["gateway_url"])
    channel = config["channel"]
    if not isinstance(channel, dict):
        raise ValueError("channel must be an object")
    validate_url(channel["base_url"])
    if urllib.parse.urlsplit(channel["base_url"]).path.rstrip("/").endswith("/v1"):
        raise ValueError("Channel base_url must omit the /v1 suffix")
    models = channel["models"]
    if not isinstance(models, list) or not models or any(not isinstance(m, str) or not m.strip() or m != m.strip() or "," in m for m in models) or len(set(models)) != len(models):
        raise ValueError("models must be a non-empty list of unique model names")
    for key in ("name", "group", "api_key_env"):
        if not isinstance(channel.get(key), str) or not channel[key].strip():
            raise ValueError("Channel name, group and api_key_env are required strings")
    mapping = channel.get("model_mapping", {})
    if not isinstance(mapping, dict) or any(not isinstance(v, str) or not v.strip() or v != v.strip() for v in mapping.values()):
        raise ValueError("model_mapping must map public model names to non-empty upstream model names")
    if set(mapping) - set(models):
        raise ValueError("Model mapping keys must be public model names")
    prices = config["temporary_prices_usd_per_million"]
    if not isinstance(prices, dict):
        raise ValueError("Temporary prices must be an object")
    for key in ("input", "output"):
        value = prices[key]
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not 0 < value <= 10000 or not math.isfinite(value):
            raise ValueError("Temporary prices must be finite positive USD per million tokens")
    payment = config.get("payment", {})
    if not isinstance(payment, dict) or type(payment.get("enabled", False)) is not bool:
        raise ValueError("payment must be an object with a boolean enabled value")
    if payment.get("enabled"):
        validate_url(payment["gateway_url"])
        validate_url(payment["public_url"])
        if not isinstance(payment.get("merchant_id"), str) or not payment["merchant_id"].strip():
            raise ValueError("Enabled payment requires a merchant ID and methods")
        methods = payment.get("methods")
        if not isinstance(methods, list) or not methods or any(not isinstance(method, dict) or any(not isinstance(method.get(k), str) or not method[k].strip() for k in ("name", "type")) for method in methods):
            raise ValueError("Payment methods must contain name and type strings")
        if not isinstance(payment.get("key_env"), str) or not payment["key_env"].strip():
            raise ValueError("Enabled payment requires key_env")
        rate = payment["cny_per_usd"]
        if isinstance(rate, bool) or not isinstance(rate, (int, float)) or not math.isfinite(rate) or rate <= 0:
            raise ValueError("cny_per_usd must be positive")
        if type(payment["min_topup"]) is not int or payment["min_topup"] < 1:
            raise ValueError("min_topup must be a positive integer")


def configure(client, config):
    validate_config(config)
    channel = config["channel"]
    upstream_key = os.environ.get(channel["api_key_env"], "")
    payment = config.get("payment", {})
    payment_key = os.environ.get(payment.get("key_env", ""), "")
    if not upstream_key or (payment.get("enabled") and not payment_key):
        raise ValueError("Required secret environment variable is missing")
    # Preflight all remote checks before writing anything.
    options = client.call("GET", "/api/option/")
    if payment.get("enabled"):
        option_map = {entry["key"]: entry["value"] for entry in options}
        if option_map.get("payment_setting.compliance_confirmed") != "true" or option_map.get("payment_setting.compliance_terms_version") != "v1":
            raise ValueError("Confirm the existing payment statement in the dashboard before enabling payment")
    channels = []
    page = 1
    while True:
        data = client.call("GET", f"/api/channel/?p={page}&page_size=100")
        channels.extend(data["items"])
        if len(channels) >= data["total"]:
            break
        if not data["items"]:
            raise RuntimeError("Incomplete channel list")
        page += 1
    matches = [item for item in channels if item["name"] == channel["name"]]
    if len(matches) > 1:
        raise ValueError("Duplicate channel names; resolve them in the dashboard")
    if matches:
        existing = matches[0]
        expected = {"base_url": channel["base_url"].rstrip("/"), "models": ",".join(channel["models"]), "group": channel["group"], "type": 1}
        if any(existing.get(k) != v for k, v in expected.items()) or json.loads(existing.get("model_mapping") or "{}") != channel.get("model_mapping", {}):
            raise ValueError("Existing channel differs; review/edit it in the dashboard instead of overwriting")
    query = urllib.parse.urlencode([("model", name) for name in channel["models"]])
    snapshot = client.call("GET", "/api/option/model_pricing?" + query)
    entries = {item["model_name"]: item for item in snapshot["entries"]}
    prices = config["temporary_prices_usd_per_million"]
    expr = f'tier("temporary", p * {prices["input"]} + c * {prices["output"]})'
    changes = []
    for name in channel["models"]:
        entry = entries.get(name, {})
        configured = entry.get("configured", {})
        # Preserve all explicit administrator overrides, including free prices.
        if configured:
            continue
        changes.append({"model_name": name, "expected_version": entry.get("version", snapshot["empty_version"]),
            "pricing": {"billing_setting.billing_mode": "tiered_expr", "billing_setting.billing_expr": expr}})
    if changes:
        client.call("PATCH", "/api/option/model_pricing", {"changes": changes})
    if not matches:
        client.call("POST", "/api/channel/", {"mode": "single", "channel": {
            "type": 1, "name": channel["name"], "key": upstream_key,
            "base_url": channel["base_url"].rstrip("/"), "models": ",".join(channel["models"]),
            "model_mapping": json.dumps(channel.get("model_mapping", {})),
            "group": channel["group"], "status": 1, "priority": 0, "weight": 1,
            "remark": "Temporary review pricing; replace before production"}})
    values = {"SystemName": "芯光智数", "Logo": "/xinguang-logo.svg"}
    if payment.get("enabled"):
        values.update({"PayAddress": payment["gateway_url"].rstrip("/"), "EpayId": payment["merchant_id"],
            "EpayKey": payment_key, "ServerAddress": payment["public_url"].rstrip("/"),
            "CustomCallbackAddress": payment["public_url"].rstrip("/"), "Price": str(payment["cny_per_usd"]),
            "MinTopUp": str(payment["min_topup"]), "PayMethods": json.dumps(payment["methods"])})
    for key, value in values.items():
        client.call("PUT", "/api/option/", {"key": key, "value": value})
    return {"channel": "preserved" if matches else "created", "prices_initialized": len(changes),
        "payment": "configured" if payment.get("enabled") else "unchanged"}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("config", type=Path)
    parser.add_argument("--apply", action="store_true", help="Apply through existing authenticated APIs")
    args = parser.parse_args()
    try:
        config = json.loads(args.config.read_text(encoding="utf-8-sig"))
        validate_config(config)
        if not args.apply:
            print(json.dumps({"valid": True, "mode": "dry-run", "models": config["channel"]["models"],
                "temporary_prices": config["temporary_prices_usd_per_million"], "payment_enabled": config.get("payment", {}).get("enabled", False)}, ensure_ascii=False))
            return
        token = os.environ.get("GATEWAY_ACCESS_TOKEN")
        if not token:
            raise ValueError("GATEWAY_ACCESS_TOKEN is required (root dashboard personal access token)")
        print(json.dumps(configure(Client(config["gateway_url"], token), config), ensure_ascii=False))
    except (ValueError, KeyError, OSError, RuntimeError) as exc:
        parser.exit(1, f"Configuration failed: {exc}\n")


if __name__ == "__main__":
    main()
