// Cindy Livia — paid x402 data services for humans and AI agents.
// Netlify Edge port of ../server.py — same x402 V2 challenge format and
// on-chain payment verification logic, extended with agent-focused checks.
//
// Endpoints:
// - GET /x402/base-wallet-report?address=0x... ($0.01)
// - GET /x402/agent-reward-proof?tx=0x...&to=0x... ($0.05)
// - GET /x402/base-token-snapshot?address=0x... ($0.05)
//
// Payment model (x402, direct-transfer proof):
// - Unpaid request -> HTTP 402 with a V2-style challenge (body +
//   PAYMENT-REQUIRED header). accepts[0] is priced per endpoint, in USDC
//   0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 on eip155:8453, payTo =
//   0x2DfA330D38450b7755e38475aEE5426465E5b832.
// - Buyer pays payTo directly on Base, then retries with header
//   X-Payment-Tx: <txHash>. The server verifies the transfer on-chain via
//   public Base RPC (receipt status, USDC Transfer log to payTo, amount,
//   recency, one-time redemption) before serving the result.
//
// These are pay-per-use data services. They do not accept deposits, stakes,
// pooled funds, or offer investment returns or promised rewards.
//
// Zero external dependencies (Deno built-ins only).
//
// LIMITATION: the anti-replay redeemed-tx store is an in-memory Set. Edge
// isolates are ephemeral and multiple isolates may run at once, so the set
// resets on cold start / scale-out — a payment tx could in theory be redeemed
// again by a fresh isolate inside its ~4h age window. Accepted trade-off at
// these micro prices; revisit with a durable store if volume rises.

const PAY_TO = "0x2DfA330D38450b7755e38475aEE5426465E5b832";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const PRICE_ATOMIC = 10000; // 0.01 USDC
const PRICE_CENTS = 1;
const PREMIUM_PRICE_ATOMIC = 50000; // 0.05 USDC
const PREMIUM_PRICE_CENTS = 5;
const NETWORK = "eip155:8453";
const RPCS = ["https://mainnet.base.org", "https://base-rpc.publicnode.com"];
const TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const MAX_TX_AGE_BLOCKS = 7200; // ~4h on Base (2s blocks)

const DESCRIPTION =
  "Base wallet report: live ETH + USDC balances and transaction count for any " +
  "Base address. Method: GET. Send query ?address=0x... Price $0.01 USDC on Base; " +
  "pay the payTo in this 402 challenge, then retry with header X-Payment-Tx: <txHash>.";

const REWARD_PROOF_DESCRIPTION =
  "Agent reward proof check: independently verify a claimed Base payment or reward. " +
  "Method: GET. Send ?tx=0x... for the transaction to inspect and optionally ?to=0x... " +
  "for the expected recipient. Returns confirmation status, every ERC20 transfer decoded, " +
  "and totals to the expected recipient. Price $0.05 USDC on Base. Pay with a SEPARATE " +
  "payment transaction to the payTo in this 402 challenge, then retry with header " +
  "X-Payment-Tx: <paymentTxHash>.";

const TOKEN_SNAPSHOT_DESCRIPTION =
  "Base token snapshot for agent due diligence: ERC20 name, symbol, decimals, total supply, " +
  "contract code size, EIP-1967 proxy indicators, and owner() when exposed. Method: GET. " +
  "Send query ?address=0x... Price $0.05 USDC on Base; pay the payTo in this 402 challenge, " +
  "then retry with header X-Payment-Tx: <txHash>. This is factual chain data, not a safety guarantee.";

interface ServiceDef {
  id: string;
  name: string;
  path: string;
  priceAtomic: number;
  priceCents: number;
  description: string;
}

const WALLET_SERVICE: ServiceDef = {
  id: "base-wallet-report",
  name: "Base Wallet Report",
  path: "/x402/base-wallet-report",
  priceAtomic: PRICE_ATOMIC,
  priceCents: PRICE_CENTS,
  description: DESCRIPTION,
};

const REWARD_PROOF_SERVICE: ServiceDef = {
  id: "agent-reward-proof",
  name: "Agent Reward Proof Check",
  path: "/x402/agent-reward-proof",
  priceAtomic: PREMIUM_PRICE_ATOMIC,
  priceCents: PREMIUM_PRICE_CENTS,
  description: REWARD_PROOF_DESCRIPTION,
};

const TOKEN_SNAPSHOT_SERVICE: ServiceDef = {
  id: "base-token-snapshot",
  name: "Base Token Snapshot",
  path: "/x402/base-token-snapshot",
  priceAtomic: PREMIUM_PRICE_ATOMIC,
  priceCents: PREMIUM_PRICE_CENTS,
  description: TOKEN_SNAPSHOT_DESCRIPTION,
};

const SERVICES: ServiceDef[] = [
  WALLET_SERVICE,
  REWARD_PROOF_SERVICE,
  TOKEN_SNAPSHOT_SERVICE,
];

function x402Block(service: ServiceDef) {
  return {
    x402Version: 2,
    scheme: "exact",
    network: NETWORK,
    amount: String(service.priceAtomic),
    asset: USDC,
    payTo: PAY_TO,
    paymentHeader: "X-Payment-Tx",
  };
}

const OPENAPI = {
  openapi: "3.1.0",
  info: {
    title: "Cindy Livia Agent Services",
    version: "1.1.0",
    description:
      "Pay-per-use Base chain data services for humans and AI agents. No deposits, stakes, pooled funds, or promised rewards.",
  },
  paths: {
    "/x402/base-wallet-report": {
      get: {
        summary: "Live Base wallet report (ETH + USDC balances, tx count)",
        operationId: "baseWalletReport",
        parameters: [{
          name: "address",
          in: "query",
          required: true,
          description:
            "The Base address to report on (0x-prefixed, 20-byte hex).",
          schema: { type: "string", pattern: "^0x[0-9a-fA-F]{40}$" },
        }],
        responses: {
          "200": { description: "Wallet report JSON (after x402 payment)." },
          "402": {
            description:
              "x402 payment challenge: pay accepts[0], then retry with header 'X-Payment-Tx: <txHash>'.",
          },
        },
        "x-x402": x402Block(WALLET_SERVICE),
      },
    },
    "/x402/agent-reward-proof": {
      get: {
        summary: "Verify a Base transaction and decode its ERC20 transfers",
        operationId: "agentRewardProof",
        parameters: [
          {
            name: "tx",
            in: "query",
            required: true,
            description: "The Base transaction hash to inspect.",
            schema: { type: "string", pattern: "^0x[0-9a-fA-F]{64}$" },
          },
          {
            name: "to",
            in: "query",
            required: false,
            description:
              "Optional expected recipient address; totals to this recipient are highlighted.",
            schema: { type: "string", pattern: "^0x[0-9a-fA-F]{40}$" },
          },
        ],
        responses: {
          "200": { description: "Reward/payment proof JSON (after x402 payment)." },
          "402": {
            description:
              "x402 payment challenge: pay accepts[0] with a separate payment tx, then retry with header 'X-Payment-Tx: <paymentTxHash>'.",
          },
        },
        "x-x402": x402Block(REWARD_PROOF_SERVICE),
      },
    },
    "/x402/base-token-snapshot": {
      get: {
        summary: "Base ERC20 token snapshot and contract indicators",
        operationId: "baseTokenSnapshot",
        parameters: [{
          name: "address",
          in: "query",
          required: true,
          description: "The Base token contract address (0x-prefixed, 20-byte hex).",
          schema: { type: "string", pattern: "^0x[0-9a-fA-F]{40}$" },
        }],
        responses: {
          "200": { description: "Token snapshot JSON (after x402 payment)." },
          "402": {
            description:
              "x402 payment challenge: pay accepts[0], then retry with header 'X-Payment-Tx: <txHash>'.",
          },
        },
        "x-x402": x402Block(TOKEN_SNAPSHOT_SERVICE),
      },
    },
  },
};

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
  minAmountAtomic: number = PRICE_ATOMIC,
): Promise<[boolean, string]> {
  // Checks a Base tx paid >= minAmountAtomic USDC to PAY_TO.
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
      if (amount >= BigInt(minAmountAtomic)) {
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

function isAddress(value: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(value);
}

function isTxHash(value: string): boolean {
  return /^0x[0-9a-fA-F]{64}$/.test(value);
}

function topicToAddress(topic: string): string {
  return "0x" + topic.slice(-40).toLowerCase();
}

function storageToAddress(value: unknown): string | null {
  if (typeof value !== "string" || !value.startsWith("0x")) return null;
  const address = "0x" + value.slice(-40).toLowerCase();
  return address === "0x0000000000000000000000000000000000000000"
    ? null
    : address;
}

function formatUnits(value: bigint, decimals: number): string {
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString().padStart(decimals + 1, "0");
  const whole = decimals === 0 ? digits : digits.slice(0, -decimals);
  const fraction = decimals === 0
    ? ""
    : digits.slice(-decimals).replace(/0+$/, "");
  return (negative ? "-" : "") + whole + (fraction ? "." + fraction : "");
}

function bytesFromHex(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function decodeAbiString(data: unknown): string | null {
  if (typeof data !== "string" || !data.startsWith("0x") || data === "0x") {
    return null;
  }
  try {
    const hex = data.slice(2);
    if (hex.length < 128) {
      const bytes = bytesFromHex(data).filter((b) => b !== 0);
      const text = new TextDecoder().decode(bytes).trim();
      return text || null;
    }
    const offset = Number(BigInt("0x" + hex.slice(0, 64)));
    const lengthPos = offset * 2;
    const length = Number(
      BigInt("0x" + hex.slice(lengthPos, lengthPos + 64)),
    );
    const bytes = bytesFromHex(
      "0x" + hex.slice(lengthPos + 64, lengthPos + 64 + length * 2),
    );
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

async function ethCall(to: string, data: string): Promise<unknown> {
  return await rpc("eth_call", [{ to, data }, "latest"]);
}

async function optionalEthCall(to: string, data: string): Promise<unknown> {
  try {
    const out = await ethCall(to, data);
    return out === "0x" ? null : out;
  } catch {
    return null;
  }
}

async function optionalRpc(method: string, params: unknown[]): Promise<unknown> {
  try {
    return await rpc(method, params);
  } catch {
    return null;
  }
}

const tokenMetadataCache = new Map<
  string,
  { address: string; symbol: string | null; decimals: number | null }
>();

async function tokenMetadata(address: string) {
  const key = address.toLowerCase();
  const cached = tokenMetadataCache.get(key);
  if (cached) return cached;
  const [symbolRaw, decimalsRaw] = await Promise.all([
    optionalEthCall(key, "0x95d89b41"),
    optionalEthCall(key, "0x313ce567"),
  ]);
  const metadata = {
    address: key,
    symbol: decodeAbiString(symbolRaw),
    decimals: typeof decimalsRaw === "string" ? Number(BigInt(decimalsRaw)) : null,
  };
  tokenMetadataCache.set(key, metadata);
  return metadata;
}

async function rewardProof(subjectTx: string, expectedTo: string) {
  const receipt = await rpc("eth_getTransactionReceipt", [subjectTx]);
  const tx = await rpc("eth_getTransactionByHash", [subjectTx]);
  const expected = expectedTo ? expectedTo.toLowerCase() : null;
  if (!receipt || !tx) {
    return {
      service: REWARD_PROOF_SERVICE.id,
      subject_tx: subjectTx,
      chain: "Base mainnet (eip155:8453)",
      verified: false,
      reason: "subject transaction not found / not mined yet",
      expected_recipient: expected,
      served_by: "Cindy Livia — Agent Reward Proof Check (x402)",
      served_at_unix: Math.floor(Date.now() / 1000),
    };
  }

  const latest = BigInt(await rpc("eth_blockNumber", []));
  const block = BigInt(receipt.blockNumber);
  const logs = receipt.logs ?? [];
  const transfers = [];
  for (const log of logs.slice(0, 100)) {
    const topics: string[] = log.topics ?? [];
    if (
      topics.length < 3 || topics[0].toLowerCase() !== TRANSFER_TOPIC ||
      !log.address
    ) continue;
    const meta = await tokenMetadata(log.address);
    const amount = log.data && log.data !== "0x" ? BigInt(log.data) : 0n;
    transfers.push({
      token: meta.address,
      token_symbol: meta.symbol,
      token_decimals: meta.decimals,
      from: topicToAddress(topics[1]),
      to: topicToAddress(topics[2]),
      amount_atomic: amount.toString(),
      amount: meta.decimals === null ? null : formatUnits(amount, meta.decimals),
      log_index: log.logIndex ? Number(BigInt(log.logIndex)) : null,
    });
  }

  const totalsMap = new Map<string, {
    token: string;
    token_symbol: string | null;
    token_decimals: number | null;
    to: string;
    amount_atomic: string;
    amount: string | null;
  }>();
  for (const transfer of transfers) {
    const key = transfer.token + "|" + transfer.to;
    const existing = totalsMap.get(key);
    const sum = BigInt(existing?.amount_atomic ?? "0") + BigInt(transfer.amount_atomic);
    totalsMap.set(key, {
      token: transfer.token,
      token_symbol: transfer.token_symbol,
      token_decimals: transfer.token_decimals,
      to: transfer.to,
      amount_atomic: sum.toString(),
      amount: transfer.token_decimals === null
        ? null
        : formatUnits(sum, transfer.token_decimals),
    });
  }
  const totals = [...totalsMap.values()];
  const recipientTotals = expected
    ? totals.filter((t) => t.to === expected)
    : [];
  const nativeValue = BigInt(tx.value ?? "0x0");
  const nativeTransfer = nativeValue > 0n
    ? {
      token: "ETH",
      from: String(tx.from ?? "").toLowerCase() || null,
      to: String(tx.to ?? "").toLowerCase() || null,
      amount_atomic: nativeValue.toString(),
      amount: formatUnits(nativeValue, 18),
    }
    : null;
  const nativeMatches = Boolean(
    expected && nativeTransfer && nativeTransfer.to === expected,
  );
  const succeeded = receipt.status === "0x1";

  return {
    service: REWARD_PROOF_SERVICE.id,
    subject_tx: subjectTx,
    chain: "Base mainnet (eip155:8453)",
    block: Number(block),
    confirmations: Number(latest - block + 1n),
    status: succeeded ? "success" : "reverted",
    verified: succeeded && (!expected || recipientTotals.length > 0 || nativeMatches),
    verification_basis: expected
      ? "Confirmed transaction contains at least one transfer to the expected recipient."
      : "Transaction is confirmed on Base; no expected recipient was supplied.",
    expected_recipient: expected,
    from: tx.from ?? null,
    to: tx.to ?? null,
    native_transfer: nativeTransfer,
    erc20_transfers: transfers,
    totals_by_token_and_recipient: totals,
    totals_to_expected_recipient: recipientTotals,
    transfer_count: transfers.length,
    logs_truncated: logs.length > 100,
    served_by: "Cindy Livia — Agent Reward Proof Check (x402)",
    served_at_unix: Math.floor(Date.now() / 1000),
  };
}

async function tokenSnapshot(address: string) {
  const [
    nameRaw,
    symbolRaw,
    decimalsRaw,
    supplyRaw,
    ownerRaw,
    codeRaw,
    implementationRaw,
    adminRaw,
  ] = await Promise.all([
    optionalEthCall(address, "0x06fdde03"),
    optionalEthCall(address, "0x95d89b41"),
    optionalEthCall(address, "0x313ce567"),
    optionalEthCall(address, "0x18160ddd"),
    optionalEthCall(address, "0x8da5cb5b"),
    optionalRpc("eth_getCode", [address, "latest"]),
    optionalRpc("eth_getStorageAt", [
      address,
      "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc",
      "latest",
    ]),
    optionalRpc("eth_getStorageAt", [
      address,
      "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103",
      "latest",
    ]),
  ]);
  const decimals = typeof decimalsRaw === "string"
    ? Number(BigInt(decimalsRaw))
    : null;
  const supply = typeof supplyRaw === "string" ? BigInt(supplyRaw) : null;
  const code = typeof codeRaw === "string" ? codeRaw : "0x";
  const implementation = storageToAddress(implementationRaw);
  const admin = storageToAddress(adminRaw);
  const owner = storageToAddress(ownerRaw);
  const warnings = [
    "Factual chain data only; this snapshot is not a safety guarantee or investment advice.",
  ];
  if (implementation) {
    warnings.push(
      "EIP-1967 proxy implementation detected; inspect the implementation contract as well as the token address.",
    );
  }
  if (!owner) {
    warnings.push("owner() was not exposed or returned the zero address.");
  }
  return {
    service: TOKEN_SNAPSHOT_SERVICE.id,
    address,
    chain: "Base mainnet (eip155:8453)",
    name: decodeAbiString(nameRaw),
    symbol: decodeAbiString(symbolRaw),
    decimals,
    total_supply_atomic: supply === null ? null : supply.toString(),
    total_supply: supply === null || decimals === null
      ? null
      : formatUnits(supply, decimals),
    is_contract: code !== "0x",
    code_size_bytes: code === "0x" ? 0 : (code.length - 2) / 2,
    owner,
    proxy: {
      is_eip1967_proxy: implementation !== null,
      implementation,
      admin,
    },
    warnings,
    served_by: "Cindy Livia — Base Token Snapshot (x402)",
    served_at_unix: Math.floor(Date.now() / 1000),
  };
}

function challenge(
  resourceUrl: string,
  service: ServiceDef = WALLET_SERVICE,
) {
  return {
    x402Version: 2,
    error: "Payment required",
    resource: {
      url: resourceUrl,
      description: service.description,
      mimeType: "application/json",
    },
    accepts: [{
      scheme: "exact",
      network: NETWORK,
      amount: String(service.priceAtomic),
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

function llmsTxt(origin: string): string {
  const lines = [
    "# Cindy Livia Agent Services",
    "",
    "Pay-per-use Base chain data services for humans and AI agents. Payment is x402: " +
    "call an endpoint, receive HTTP 402 with an `accepts[0]` challenge, pay that USDC " +
    "amount on Base (eip155:8453) to the challenge payTo, then retry the same URL with " +
    "header `X-Payment-Tx: <txHash>`. No deposits, stakes, pooled funds, or promised rewards.",
    "",
    "## Services",
    "",
  ];
  for (const s of SERVICES) {
    lines.push(
      `### ${s.name}`,
      `- Endpoint: GET ${origin}${s.path}`,
      `- Price: $${(s.priceCents / 100).toFixed(2)} USDC on Base (atomic amount ${s.priceAtomic})`,
      `- Description: ${s.description}`,
      "",
    );
  }
  lines.push(
    "## Machine-readable discovery",
    `- OpenAPI: ${origin}/openapi.json`,
    `- x402 index: ${origin}/.well-known/x402.json`,
    `- Health: ${origin}/health`,
    "",
  );
  return lines.join("\n");
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

function paymentRequired(
  resourceUrl: string,
  service: ServiceDef = WALLET_SERVICE,
  errorOverride?: string,
): Response {
  const ch = challenge(resourceUrl, service);
  if (errorOverride) ch.error = errorOverride;
  return sendJson(402, ch, {
    "payment-required": b64EncodeJson(ch),
    "x402-price": String(service.priceCents),
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
      service: "cindy-livia-agent-services",
      payTo: PAY_TO,
      services: SERVICES.map((s) => ({
        id: s.id,
        path: s.path,
        price_cents: s.priceCents,
      })),
    });
  }
  if (u.pathname === "/") {
    return sendJson(200, {
      service: "Cindy Livia Agent Services",
      by: "Cindy Livia",
      payTo: PAY_TO,
      model: "Pay per use. No deposits, stakes, pooled funds, or promised rewards.",
      endpoints: SERVICES.map((s) => ({
        path: s.path,
        price: `$${(s.priceCents / 100).toFixed(2)} USDC on Base (x402)`,
        description: s.description,
      })),
    });
  }
  if (u.pathname === "/api/services") {
    return sendJson(200, {
      services: SERVICES.map((s) => ({
        id: s.id,
        name: s.name,
        path: s.path,
        price_cents: s.priceCents,
        currency: "USDC",
        network: NETWORK,
        payTo: PAY_TO,
        description: s.description,
      })),
    });
  }
  if (u.pathname === "/llms.txt") {
    return new Response(llmsTxt(u.origin), {
      status: 200,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }
  if (u.pathname === "/openapi.json") {
    return sendJson(200, { ...OPENAPI, servers: [{ url: u.origin }] });
  }
  if (u.pathname === "/.well-known/x402.json") {
    return sendJson(200, {
      x402Version: 2,
      resources: SERVICES.map((s) => ({
        url: u.origin + s.path,
        type: "http",
        method: "GET",
        description: s.description,
        accepts: challenge(s.path, s).accepts,
        proof:
          "Pay accepts[0] by a direct USDC transfer to payTo on Base, " +
          "then retry with header 'X-Payment-Tx: <txHash>'.",
      })),
    });
  }
  if (u.pathname === "/x402/base-wallet-report") {
    // Paywall BEFORE request validation: an unpaid request always gets the
    // 402 challenge, even without ?address= (discovery tools like x402scan
    // probe the bare URL and require a 402 there).
    const txhash = req.headers.get("x-payment-tx");
    if (!txhash) {
      return paymentRequired(WALLET_SERVICE.path, WALLET_SERVICE);
    }
    const address = u.searchParams.get("address") ?? "";
    if (!address) {
      return paymentRequired(
        WALLET_SERVICE.path,
        WALLET_SERVICE,
        "Payment proof received, but the request is missing ?address=0x... — resend with the address to get the report.",
      );
    }
    if (!isAddress(address)) {
      return sendJson(400, {
        error: "address must be a 0x-prefixed 20-byte hex address",
      });
    }
    const [ok, reason] = await verifyPayment(
      txhash.trim(),
      WALLET_SERVICE.priceAtomic,
    );
    if (!ok) {
      return paymentRequired(
        WALLET_SERVICE.path,
        WALLET_SERVICE,
        `Payment not accepted: ${reason}`,
      );
    }
    try {
      return sendJson(200, await walletReport(address));
    } catch (e) {
      return sendJson(502, { error: `report failed: ${e}` });
    }
  }
  if (u.pathname === "/x402/agent-reward-proof") {
    const service = REWARD_PROOF_SERVICE;
    const txhash = req.headers.get("x-payment-tx");
    if (!txhash) {
      return paymentRequired(service.path, service);
    }
    const subjectTx = u.searchParams.get("tx") ?? u.searchParams.get("txhash") ?? "";
    if (!subjectTx) {
      return paymentRequired(
        service.path,
        service,
        "Payment proof received, but the request is missing ?tx=0x... for the transaction to inspect — resend with the subject transaction hash.",
      );
    }
    if (!isTxHash(subjectTx)) {
      return sendJson(400, {
        error: "tx must be a 0x-prefixed 32-byte transaction hash",
      });
    }
    const expectedTo = u.searchParams.get("to") ?? "";
    if (expectedTo && !isAddress(expectedTo)) {
      return sendJson(400, {
        error: "to must be a 0x-prefixed 20-byte hex address",
      });
    }
    const [ok, reason] = await verifyPayment(txhash.trim(), service.priceAtomic);
    if (!ok) {
      return paymentRequired(
        service.path,
        service,
        `Payment not accepted: ${reason}`,
      );
    }
    try {
      return sendJson(200, await rewardProof(subjectTx, expectedTo));
    } catch (e) {
      return sendJson(502, { error: `reward proof failed: ${e}` });
    }
  }
  if (u.pathname === "/x402/base-token-snapshot") {
    const service = TOKEN_SNAPSHOT_SERVICE;
    const txhash = req.headers.get("x-payment-tx");
    if (!txhash) {
      return paymentRequired(service.path, service);
    }
    const address = u.searchParams.get("address") ?? "";
    if (!address) {
      return paymentRequired(
        service.path,
        service,
        "Payment proof received, but the request is missing ?address=0x... — resend with the token address to get the snapshot.",
      );
    }
    if (!isAddress(address)) {
      return sendJson(400, {
        error: "address must be a 0x-prefixed 20-byte hex address",
      });
    }
    const [ok, reason] = await verifyPayment(txhash.trim(), service.priceAtomic);
    if (!ok) {
      return paymentRequired(
        service.path,
        service,
        `Payment not accepted: ${reason}`,
      );
    }
    try {
      return sendJson(200, await tokenSnapshot(address));
    } catch (e) {
      return sendJson(502, { error: `token snapshot failed: ${e}` });
    }
  }
  return sendJson(404, { error: "not found" });
}


export default handler;
export const config = { path: "/*" };
