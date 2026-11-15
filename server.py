#!/usr/bin/env python3
"""Cindy Livia — Base Wallet Report: a paid x402 data service.

GET /x402/base-wallet-report?address=0x...  -> live Base mainnet report
(ETH balance, USDC balance, tx count) for any address.

Payment model (x402, direct-transfer proof):
- Unpaid request -> HTTP 402 with a V2-style challenge (body + PAYMENT-REQUIRED
  header): accepts[0] = exact 10000 atomic USDC (=$0.01) on eip155:8453,
  asset = USDC 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913,
  payTo = 0x2DfA330D38450b7755e38475aEE5426465E5b832.
- Buyer pays payTo directly on Base, then retries with header
  X-Payment-Tx: <txHash>. The server verifies the transfer on-chain via
  public Base RPC (receipt status, USDC Transfer log to payTo, amount,
  recency, one-time redemption) before serving the report.

Stdlib only. RPC goes through the environment proxy with a browser UA
(Base public RPCs reject the python-urllib default UA).
"""
import base64
import json
import os
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

PORT = int(os.environ.get("PORT", "8402"))
HOST = os.environ.get("HOST", "127.0.0.1")
PAY_TO = "0x2DfA330D38450b7755e38475aEE5426465E5b832"
USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
PRICE_ATOMIC = 10000  # 0.01 USDC
PRICE_CENTS = 1
NETWORK = "eip155:8453"
RPCS = ["https://mainnet.base.org", "https://base-rpc.publicnode.com"]
TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"
MAX_TX_AGE_BLOCKS = 7200  # ~4h on Base (2s blocks)
HERE = os.path.dirname(os.path.abspath(__file__))
REDEEMED_FILE = os.path.join(HERE, "redeemed.json")
_lock = threading.Lock()

DESCRIPTION = (
    "Base wallet report: live ETH + USDC balances and transaction count for any "
    "Base address. Method: GET. Send query ?address=0x... Price $0.01 USDC on Base; "
    "pay the payTo in this 402 challenge, then retry with header X-Payment-Tx: <txHash>."
)

UA = {"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
                    "(KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36",
      "Content-Type": "application/json"}


def rpc(method, params):
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method,
                       "params": params}).encode()
    last = None
    for url in RPCS:
        try:
            req = urllib.request.Request(url, data=body, headers=UA)
            with urllib.request.urlopen(req, timeout=20) as r:
                out = json.loads(r.read())
            if "error" in out:
                raise RuntimeError(str(out["error"]))
            return out["result"]
        except Exception as e:  # try next RPC
            last = e
    raise RuntimeError(f"all RPCs failed: {last}")


def load_redeemed():
    try:
        with open(REDEEMED_FILE) as f:
            return set(json.load(f))
    except Exception:
        return set()


def save_redeemed(s):
    tmp = REDEEMED_FILE + ".tmp"
    with open(tmp, "w") as f:
        json.dump(sorted(s), f)
    os.replace(tmp, REDEEMED_FILE)


def verify_payment(txhash):
    """Return (ok, reason). Checks a Base tx paid >= PRICE_ATOMIC USDC to PAY_TO."""
    if not (isinstance(txhash, str) and txhash.startswith("0x") and len(txhash) == 66):
        return False, "malformed tx hash"
    with _lock:
        redeemed = load_redeemed()
        if txhash.lower() in redeemed:
            return False, "tx already redeemed"
    try:
        receipt = rpc("eth_getTransactionReceipt", [txhash])
    except Exception as e:
        return False, f"receipt lookup failed: {e}"
    if not receipt:
        return False, "tx not found / not mined yet"
    if receipt.get("status") != "0x1":
        return False, "tx reverted"
    try:
        latest = int(rpc("eth_blockNumber", []), 16)
        tx_block = int(receipt["blockNumber"], 16)
    except Exception as e:
        return False, f"block check failed: {e}"
    if latest - tx_block > MAX_TX_AGE_BLOCKS:
        return False, "tx too old"
    payto_topic = "0x" + "0" * 24 + PAY_TO[2:].lower()
    for log in receipt.get("logs", []):
        if log.get("address", "").lower() != USDC.lower():
            continue
        topics = log.get("topics", [])
        if len(topics) >= 3 and topics[0].lower() == TRANSFER_TOPIC \
                and topics[2].lower() == payto_topic:
            if int(log["data"], 16) >= PRICE_ATOMIC:
                with _lock:
                    redeemed = load_redeemed()
                    redeemed.add(txhash.lower())
                    save_redeemed(redeemed)
                return True, "ok"
    return False, "no USDC transfer to payTo >= price in this tx"


def wallet_report(address):
    if not (address.startswith("0x") and len(address) == 42):
        raise ValueError("address must be a 0x-prefixed 20-byte hex address")
    int(address[2:], 16)  # validate hex
    padded = "0x70a08231" + "0" * 24 + address[2:].lower()
    eth = int(rpc("eth_getBalance", [address, "latest"]), 16)
    usdc = int(rpc("eth_call", [{"to": USDC, "data": padded}, "latest"]), 16)
    nonce = int(rpc("eth_getTransactionCount", [address, "latest"]), 16)
    block = int(rpc("eth_blockNumber", []), 16)
    return {
        "address": address,
        "chain": "Base mainnet (eip155:8453)",
        "block": block,
        "eth_balance": eth / 1e18,
        "eth_balance_wei": str(eth),
        "usdc_balance": usdc / 1e6,
        "usdc_balance_atomic": str(usdc),
        "tx_count": nonce,
        "served_by": "Cindy Livia — Base Wallet Report (x402)",
        "served_at_unix": int(time.time()),
    }


def challenge(resource_url):
    return {
        "x402Version": 2,
        "error": "Payment required",
        "resource": {"url": resource_url, "description": DESCRIPTION,
                     "mimeType": "application/json"},
        "accepts": [{
            "scheme": "exact",
            "network": NETWORK,
            "amount": str(PRICE_ATOMIC),
            "asset": USDC,
            "payTo": PAY_TO,
            "maxTimeoutSeconds": 600,
            "extra": {"name": "USD Coin", "version": "2"},
        }],
        "proof": "Pay accepts[0] by a direct USDC transfer to payTo on Base, "
                 "then retry this URL with header 'X-Payment-Tx: <txHash>'.",
    }


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        print("[svc]", fmt % args, flush=True)

    def _send(self, code, obj, extra_headers=None):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        for k, v in (extra_headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        u = urlparse(self.path)
        qs = parse_qs(u.query)
        if u.path == "/health":
            return self._send(200, {"ok": True, "service": "base-wallet-report",
                                    "payTo": PAY_TO, "price_cents": PRICE_CENTS})
        if u.path == "/":
            return self._send(200, {
                "service": "Base Wallet Report",
                "by": "Cindy Livia",
                "endpoint": "/x402/base-wallet-report?address=0x...",
                "price": "$0.01 USDC on Base (x402)",
                "payTo": PAY_TO,
                "description": DESCRIPTION})
        if u.path == "/api/services":
            return self._send(200, {"services": [{
                "id": "base-wallet-report", "name": "Base Wallet Report",
                "path": "/x402/base-wallet-report", "price_cents": PRICE_CENTS,
                "currency": "USDC", "network": NETWORK, "payTo": PAY_TO,
                "description": DESCRIPTION}]})
        if u.path == "/x402/base-wallet-report":
            address = (qs.get("address") or [""])[0]
            if not address:
                return self._send(400, {"error": "missing ?address=0x... query parameter"})
            txhash = self.headers.get("X-Payment-Tx")
            if not txhash:
                ch = challenge("/x402/base-wallet-report")
                b64 = base64.b64encode(json.dumps(ch).encode()).decode()
                return self._send(402, ch, {"payment-required": b64,
                                            "x402-price": str(PRICE_CENTS)})
            ok, reason = verify_payment(txhash.strip())
            if not ok:
                ch = challenge("/x402/base-wallet-report")
                ch["error"] = f"Payment not accepted: {reason}"
                b64 = base64.b64encode(json.dumps(ch).encode()).decode()
                return self._send(402, ch, {"payment-required": b64,
                                            "x402-price": str(PRICE_CENTS)})
            try:
                return self._send(200, wallet_report(address))
            except Exception as e:
                return self._send(502, {"error": f"report failed: {e}"})
        return self._send(404, {"error": "not found"})


if __name__ == "__main__":
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
