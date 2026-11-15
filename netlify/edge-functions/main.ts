// Cindy Livia — Base Wallet Report: a paid x402 data service.
// Cloudflare Workers port of ../server.py (via the Deno TypeScript port) (Python stdlib) — same endpoints,
// same x402 V2 challenge format, same on-chain payment verification logic.
//
// GET /x402/base-wallet-report?address=0x...  -> live Base mainnet report
// (ETH balance, USDC balance, tx count) for any address.
//
// Payment model (x402, direct-transfer proof):
// - Unpaid request -> HTTP 402 with a V2-style challenge (body + PAYMENT-REQUIRED
//   header): accepts[0] = exact 10000 atomic USDC (=$0.01) on eip155:8453,
//   asset = USDC 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913,
//   payTo = 0x2DfA330D38450b7755e38475aEE5426465E5b832.
// - Buyer pays payTo directly on Base, then retries with header
//   X-Payment-Tx: <txHash>. The server verifies the transfer on-chain via
//   public Base RPC (receipt status, USDC Transfer log to payTo, amount,
//   recency, one-time redemption) before serving the report.
//
// Zero external dependencies (Deno built-ins only).
//
// LIMITATION vs the Python version: the anti-replay redeemed-tx store is an
// in-memory Set (the Python version persists redeemed.json on disk). On
// Cloudflare Workers, isolates are ephemeral and multiple isolates may run at once,
// so the set resets on cold start / scale-out — a payment tx could in theory
// be redeemed again by a fresh isolate inside its ~4h age window. Accepted
// trade-off at a $0.01 price point; revisit with a KV store if price rises.

const PAY_TO = "0x2DfA330D38450b7755e38475aEE5426465E5b832";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const PRICE_ATOMIC = 10000; // 0.01 USDC
const PRICE_CENTS = 1;
const NETWORK = "eip155:8453";
const RPCS = ["https://mainnet.base.org", "https://base-rpc.publicnode.com"];
const TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const MAX_TX_AGE_BLOCKS = 7200; // ~4h on Base (2s blocks)

const DESCRIPTION =
  "Base wallet report: live ETH + USDC balances and transaction count for any " +
  "Base address. Method: GET. Send query ?address=0x... Price $0.01 USDC on Base; " +
  "pay the payTo in this 402 challenge, then retry with header X-Payment-Tx: <txHash>.";

const UA = {
  "User-Agent":
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36",
  "Content-Type": "application/json",
};

// In-memory anti-replay store (see limitation note in the header comment).
const redeemed = new Set<string>();

// deno-lint-ignore no-explicit-any
async function rpc(method: string, params: unknown[]): Promise<any> {
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });
  let last: unknown = null;
  for (const url of RPCS) {
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: UA,
        body,
        signal: AbortSignal.timeout(20000),
      });
      const out = await r.json();
      if (out && typeof out === "object" && "error" in out) {
        throw new Error(JSON.stringify(out.error));
      }
      return out.result;
    } catch (e) {
      last = e; // try next RPC
    }
  }
  throw new Error(`all RPCs failed: ${last}`);
}

async function verifyPayment(
  txhash: unknown,
): Promise<[boolean, string]> {
  // Checks a Base tx paid >= PRICE_ATOMIC USDC to PAY_TO.
  if (
    !(typeof txhash === "string" && txhash.startsWith("0x") &&
      txhash.length === 66)
  ) {
    return [false, "malformed tx hash"];
  }
  const key = txhash.toLowerCase();
  if (redeemed.has(key)) {
    return [false, "tx already redeemed"];
  }
  let receipt;
  try {
    receipt = await rpc("eth_getTransactionReceipt", [txhash]);
  } catch (e) {
    return [false, `receipt lookup failed: ${e}`];
  }
  if (!receipt) {
    return [false, "tx not found / not mined yet"];
  }
  if (receipt.status !== "0x1") {
    return [false, "tx reverted"];
  }
  try {
    const latest = Number(BigInt(await rpc("eth_blockNumber", [])));
    const txBlock = Number(BigInt(receipt.blockNumber));
    if (latest - txBlock > MAX_TX_AGE_BLOCKS) {
      return [false, "tx too old"];
    }
  } catch (e) {
    return [false, `block check failed: ${e}`];
  }
  const paytoTopic = "0x" + "0".repeat(24) + PAY_TO.slice(2).toLowerCase();
  for (const log of receipt.logs ?? []) {
    if ((log.address ?? "").toLowerCase() !== USDC.toLowerCase()) continue;
    const topics: string[] = log.topics ?? [];
    if (
      topics.length >= 3 &&
      topics[0].toLowerCase() === TRANSFER_TOPIC &&
      topics[2].toLowerCase() === paytoTopic
    ) {
      const amount = log.data && log.data !== "0x" ? BigInt(log.data) : 0n;
      if (amount >= BigInt(PRICE_ATOMIC)) {
        redeemed.add(key);
        return [true, "ok"];
      }
    }
  }
  return [false, "no USDC transfer to payTo >= price in this tx"];
}

async function walletReport(address: string) {
  if (!(address.startsWith("0x") && address.length === 42)) {
    throw new Error("address must be a 0x-prefixed 20-byte hex address");
  }
  BigInt(address); // validate hex (throws on non-hex, like Python's int(..., 16))
  const padded = "0x70a08231" + "0".repeat(24) + address.slice(2).toLowerCase();
  const eth = BigInt(await rpc("eth_getBalance", [address, "latest"]));
  const usdc = BigInt(
    await rpc("eth_call", [{ to: USDC, data: padded }, "latest"]),
  );
  const nonce = BigInt(
    await rpc("eth_getTransactionCount", [address, "latest"]),
  );
  const block = BigInt(await rpc("eth_blockNumber", []));
  return {
    address: address,
    chain: "Base mainnet (eip155:8453)",
    block: Number(block),
    eth_balance: Number(eth) / 1e18,
    eth_balance_wei: eth.toString(),
    usdc_balance: Number(usdc) / 1e6,
    usdc_balance_atomic: usdc.toString(),
    tx_count: Number(nonce),
    served_by: "Cindy Livia — Base Wallet Report (x402)",
    served_at_unix: Math.floor(Date.now() / 1000),
  };
}

function challenge(resourceUrl: string) {
  return {
    x402Version: 2,
    error: "Payment required",
    resource: {
      url: resourceUrl,
      description: DESCRIPTION,
      mimeType: "application/json",
    },
    accepts: [{
      scheme: "exact",
      network: NETWORK,
      amount: String(PRICE_ATOMIC),
      asset: USDC,
      payTo: PAY_TO,
      maxTimeoutSeconds: 600,
      extra: { name: "USD Coin", version: "2" },
    }],
    proof:
      "Pay accepts[0] by a direct USDC transfer to payTo on Base, " +
      "then retry this URL with header 'X-Payment-Tx: <txHash>'.",
  };
}

function b64EncodeJson(obj: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(obj));
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function sendJson(
  code: number,
  obj: unknown,
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(obj), {
    status: code,
    headers: { "Content-Type": "application/json", ...extraHeaders },
  });
}

function paymentRequired(resourceUrl: string, errorOverride?: string): Response {
  const ch = challenge(resourceUrl);
  if (errorOverride) ch.error = errorOverride;
  return sendJson(402, ch, {
    "payment-required": b64EncodeJson(ch),
    "x402-price": String(PRICE_CENTS),
  });
}

async function handler(req: Request): Promise<Response> {
  const u = new URL(req.url);
  console.log("[svc]", req.method, u.pathname + u.search);
  if (req.method !== "GET") {
    return sendJson(404, { error: "not found" });
  }
  if (u.pathname === "/health") {
    return sendJson(200, {
      ok: true,
      service: "base-wallet-report",
      payTo: PAY_TO,
      price_cents: PRICE_CENTS,
    });
  }
  if (u.pathname === "/") {
    return sendJson(200, {
      service: "Base Wallet Report",
      by: "Cindy Livia",
      endpoint: "/x402/base-wallet-report?address=0x...",
      price: "$0.01 USDC on Base (x402)",
      payTo: PAY_TO,
      description: DESCRIPTION,
    });
  }
  if (u.pathname === "/api/services") {
    return sendJson(200, {
      services: [{
        id: "base-wallet-report",
        name: "Base Wallet Report",
        path: "/x402/base-wallet-report",
        price_cents: PRICE_CENTS,
        currency: "USDC",
        network: NETWORK,
        payTo: PAY_TO,
        description: DESCRIPTION,
      }],
    });
  }
  if (u.pathname === "/x402/base-wallet-report") {
    const address = u.searchParams.get("address") ?? "";
    if (!address) {
      return sendJson(400, {
        error: "missing ?address=0x... query parameter",
      });
    }
    const txhash = req.headers.get("x-payment-tx");
    if (!txhash) {
      return paymentRequired("/x402/base-wallet-report");
    }
    const [ok, reason] = await verifyPayment(txhash.trim());
    if (!ok) {
      return paymentRequired(
        "/x402/base-wallet-report",
        `Payment not accepted: ${reason}`,
      );
    }
    try {
      return sendJson(200, await walletReport(address));
    } catch (e) {
      return sendJson(502, { error: `report failed: ${e}` });
    }
  }
  return sendJson(404, { error: "not found" });
}


export default handler;
export const config = { path: "/*" };
