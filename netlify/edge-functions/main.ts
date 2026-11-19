// Cindy Livia — paid x402 data services for humans and AI agents.
//
// *** LIVE DEPLOYMENT — facilitator switch, deployed 2026-11-19. ***
// Adds discovery extensions (extensions.bazaar in every 402) and a standard
// x402 payment path that settles through a configurable facilitator,
// alongside the legacy direct-transfer proof path (unchanged). The default
// facilitator is the KEYLESS PayAI Facilitator (free tier, no account/API
// key); the Coinbase CDP Facilitator remains available as an alternative
// config (X402_FACILITATOR_URL + X402_FACILITATOR_AUTH=cdp + CDP_API_KEY_ID /
// CDP_API_KEY_SECRET). Audited pre-deploy: diff vs previous live = payment
// plumbing only, suites 103/103 PASS (see bazaar-test + live-switch report).
//
// Netlify Edge port of ../server.py — same x402 V2 challenge format and
// on-chain payment verification logic, extended with agent-focused checks.
//
// Endpoints:
// - GET /x402/base-wallet-report?address=0x... ($0.01)
// - GET /x402/agent-reward-proof?tx=0x...&to=0x... ($0.05)
// - GET /x402/base-token-snapshot?address=0x... ($0.05)
// - GET /x402/erc20-balance?token=0x...&address=0x... ($0.003)
// - GET /x402/tx-receipt?tx=0x... ($0.003)
// - GET /x402/ens-resolve?name=vitalik.eth | ?address=0x... ($0.003)
// - GET /x402/gas-estimate ($0.002)
// - GET /x402/contract-info?address=0x... ($0.005)
//
// Granular on-chain read suite (Hunt C P1, prepared 2026-11-19): five
// small single-purpose reads priced in the proven $0.002–0.005 band,
// following the exact same challenge/gate flow as the original three.
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
const MICRO_PRICE_ATOMIC = 3000; // 0.003 USDC (granular read suite)
const MICRO_PRICE_CENTS = 0.3;
const GAS_PRICE_ATOMIC = 2000; // 0.002 USDC (gas-estimate)
const GAS_PRICE_CENTS = 0.2;
const INFO_PRICE_ATOMIC = 5000; // 0.005 USDC (contract-info)
const INFO_PRICE_CENTS = 0.5;
const NETWORK = "eip155:8453";
const RPCS = ["https://mainnet.base.org", "https://base-rpc.publicnode.com"];
const TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const MAX_TX_AGE_BLOCKS = 7200; // ~4h on Base (2s blocks)

// Bazaar-facing descriptions. Hard limit: the CDP Facilitator rejects verify
// and settle requests whose resource description exceeds 500 characters, so
// every description below is kept under that (asserted in test-bazaar.ts).
const DESCRIPTION =
  "Live Base wallet report: ETH balance, USDC balance, and transaction count " +
  "for any Base address, read from chain at request time. Use it for a quick " +
  "factual balance check before sending funds or during counterparty due " +
  "diligence. GET /x402/base-wallet-report?address=0x... - price $0.01 USDC " +
  "on Base mainnet, paid per call with x402.";

const REWARD_PROOF_DESCRIPTION =
  "Agent reward proof check: independently verify a Base transaction and " +
  "decode every ERC20 transfer in it, with totals per recipient. Use it to " +
  "confirm that a claimed payment or reward on Base actually happened and " +
  "reached the expected recipient. GET /x402/agent-reward-proof?tx=0x... " +
  "with optional &to=0x... - price $0.05 USDC on Base mainnet, paid per " +
  "call with x402.";

const TOKEN_SNAPSHOT_DESCRIPTION =
  "Base token snapshot for due diligence: ERC20 name, symbol, decimals, " +
  "total supply, contract code size, EIP-1967 proxy indicators, and owner() " +
  "when exposed, for any token contract on Base. GET " +
  "/x402/base-token-snapshot?address=0x... - price $0.05 USDC on Base " +
  "mainnet, paid per call with x402. Factual chain data only, not a safety " +
  "guarantee.";

const ERC20_BALANCE_DESCRIPTION =
  "ERC20 balance check on Base: the balance, symbol, and decimals of any " +
  "ERC20 token for any wallet address, read from chain at request time. " +
  "Use it for granular balance lookups before a transfer or for agent " +
  "bookkeeping. GET /x402/erc20-balance?token=0x...&address=0x... - " +
  "price $0.003 USDC on Base mainnet, paid per call with x402.";

const TX_RECEIPT_DESCRIPTION =
  "Base transaction receipt summary: confirmation status, block, " +
  "confirmations, gas used, effective gas price and total fee, native " +
  "value, ERC20 transfer count, and the contracts that emitted logs, " +
  "decoded from the on-chain receipt. Use it to confirm what a Base " +
  "transaction actually did. GET /x402/tx-receipt?tx=0x... - price " +
  "$0.003 USDC on Base mainnet, paid per call with x402.";

const ENS_RESOLVE_DESCRIPTION =
  "ENS resolution: forward-resolve an ENS name to its Ethereum address, " +
  "or reverse-resolve an address to its primary ENS name, read live from " +
  "the ENS registry and public resolvers on Ethereum mainnet. Use it to " +
  "turn a human-readable name into a verified address. GET " +
  "/x402/ens-resolve?name=vitalik.eth or ?address=0x... - price $0.003 " +
  "USDC on Base mainnet, paid per call with x402.";

const GAS_ESTIMATE_DESCRIPTION =
  "Base gas estimate: the current gas price and base fee on Base, plus " +
  "the estimated cost of a native ETH transfer (21,000 gas) and a " +
  "typical ERC20 transfer at request time. Use it to budget transaction " +
  "costs before sending on Base. GET /x402/gas-estimate - price $0.002 " +
  "USDC on Base mainnet, paid per call with x402.";

const CONTRACT_INFO_DESCRIPTION =
  "Base contract info for any address: is-contract check, bytecode size " +
  "and Keccak-256 code hash, ERC20 metadata when the contract exposes " +
  "it, owner() when available, and proxy detection across the EIP-1967 " +
  "implementation, admin, and beacon slots. GET " +
  "/x402/contract-info?address=0x... - price $0.005 USDC on Base " +
  "mainnet, paid per call with x402. Factual chain data only.";

interface ServiceDef {
  id: string;
  name: string;
  path: string;
  priceAtomic: number;
  priceCents: number;
  description: string;
  // Bazaar discovery metadata (spec: coinbase/x402 specs/extensions/bazaar).
  tags: string[];
  exampleQueryParams: Record<string, string>;
  queryParamSchemas: Record<string, unknown>;
  requiredQueryParams: string[];
  outputExample: Record<string, unknown>;
}

const ADDRESS_SCHEMA = {
  type: "string",
  pattern: "^0x[0-9a-fA-F]{40}$",
};
const TX_SCHEMA = { type: "string", pattern: "^0x[0-9a-fA-F]{64}$" };
// A real Base transaction, reused as the reward-proof discovery example.
const EXAMPLE_TX =
  "0xd9ec1c0c64c9b13427fe682d3629686e64ddc985aaa8f5ffd924893593099d5b";

const WALLET_SERVICE: ServiceDef = {
  id: "base-wallet-report",
  name: "Base Wallet Report",
  path: "/x402/base-wallet-report",
  priceAtomic: PRICE_ATOMIC,
  priceCents: PRICE_CENTS,
  description: DESCRIPTION,
  tags: ["base", "wallet", "balances", "usdc", "onchain-data"],
  exampleQueryParams: { address: PAY_TO },
  queryParamSchemas: { address: ADDRESS_SCHEMA },
  requiredQueryParams: ["address"],
  outputExample: {
    address: PAY_TO,
    chain: "Base mainnet (eip155:8453)",
    block: 30123456,
    eth_balance: 0.001,
    eth_balance_wei: "1000000000000000",
    usdc_balance: 12.5,
    usdc_balance_atomic: "12500000",
    tx_count: 42,
    served_by: "Cindy Livia — Base Wallet Report (x402)",
    served_at_unix: 1763539200,
  },
};

const REWARD_PROOF_SERVICE: ServiceDef = {
  id: "agent-reward-proof",
  name: "Agent Reward Proof Check",
  path: "/x402/agent-reward-proof",
  priceAtomic: PREMIUM_PRICE_ATOMIC,
  priceCents: PREMIUM_PRICE_CENTS,
  description: REWARD_PROOF_DESCRIPTION,
  tags: ["base", "payments", "verification", "erc20", "proof"],
  exampleQueryParams: { tx: EXAMPLE_TX, to: PAY_TO },
  queryParamSchemas: { tx: TX_SCHEMA, to: ADDRESS_SCHEMA },
  requiredQueryParams: ["tx"],
  outputExample: {
    service: "agent-reward-proof",
    subject_tx: EXAMPLE_TX,
    chain: "Base mainnet (eip155:8453)",
    block: 30123456,
    confirmations: 128,
    status: "success",
    verified: true,
    expected_recipient: PAY_TO,
    erc20_transfers: [],
    totals_to_expected_recipient: [],
    transfer_count: 0,
    served_by: "Cindy Livia — Agent Reward Proof Check (x402)",
    served_at_unix: 1763539200,
  },
};

const TOKEN_SNAPSHOT_SERVICE: ServiceDef = {
  id: "base-token-snapshot",
  name: "Base Token Snapshot",
  path: "/x402/base-token-snapshot",
  priceAtomic: PREMIUM_PRICE_ATOMIC,
  priceCents: PREMIUM_PRICE_CENTS,
  description: TOKEN_SNAPSHOT_DESCRIPTION,
  tags: ["base", "erc20", "token", "due-diligence", "contracts"],
  exampleQueryParams: { address: USDC },
  queryParamSchemas: { address: ADDRESS_SCHEMA },
  requiredQueryParams: ["address"],
  outputExample: {
    service: "base-token-snapshot",
    address: USDC,
    chain: "Base mainnet (eip155:8453)",
    name: "USD Coin",
    symbol: "USDC",
    decimals: 6,
    total_supply_atomic: "10000000000000",
    total_supply: "10000000",
    is_contract: true,
    code_size_bytes: 2200,
    owner: null,
    proxy: { is_eip1967_proxy: true, implementation: null, admin: null },
    warnings: [
      "Factual chain data only; this snapshot is not a safety guarantee or investment advice.",
    ],
    served_by: "Cindy Livia — Base Token Snapshot (x402)",
    served_at_unix: 1763539200,
  },
};

const ERC20_BALANCE_SERVICE: ServiceDef = {
  id: "erc20-balance",
  name: "ERC20 Balance (Base)",
  path: "/x402/erc20-balance",
  priceAtomic: MICRO_PRICE_ATOMIC,
  priceCents: MICRO_PRICE_CENTS,
  description: ERC20_BALANCE_DESCRIPTION,
  tags: ["base", "erc20", "balance", "onchain-data"],
  exampleQueryParams: { token: USDC, address: PAY_TO },
  queryParamSchemas: { token: ADDRESS_SCHEMA, address: ADDRESS_SCHEMA },
  requiredQueryParams: ["token", "address"],
  outputExample: {
    service: "erc20-balance",
    chain: "Base mainnet (eip155:8453)",
    block: 30123456,
    token: USDC,
    token_symbol: "USDC",
    token_decimals: 6,
    address: PAY_TO,
    balance_atomic: "12500000",
    balance: "12.5",
    served_by: "Cindy Livia — ERC20 Balance (x402)",
    served_at_unix: 1763539200,
  },
};

const TX_RECEIPT_SERVICE: ServiceDef = {
  id: "tx-receipt",
  name: "Base TX Receipt Summary",
  path: "/x402/tx-receipt",
  priceAtomic: MICRO_PRICE_ATOMIC,
  priceCents: MICRO_PRICE_CENTS,
  description: TX_RECEIPT_DESCRIPTION,
  tags: ["base", "transactions", "receipts", "gas", "onchain-data"],
  exampleQueryParams: { tx: EXAMPLE_TX },
  queryParamSchemas: { tx: TX_SCHEMA },
  requiredQueryParams: ["tx"],
  outputExample: {
    service: "tx-receipt",
    subject_tx: EXAMPLE_TX,
    chain: "Base mainnet (eip155:8453)",
    found: true,
    block: 30123456,
    confirmations: 128,
    status: "success",
    from: PAY_TO,
    to: USDC,
    value_eth: "0",
    gas_used: 52000,
    transaction_fee_eth: "0.00000026",
    erc20_transfer_count: 1,
    log_count: 1,
    served_by: "Cindy Livia — Base TX Receipt (x402)",
    served_at_unix: 1763539200,
  },
};

const ENS_NAME_SCHEMA = {
  type: "string",
  pattern: "^[a-z0-9-]+(\\.[a-z0-9-]+)+$",
};
const EXAMPLE_ENS_ADDRESS = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";

const ENS_RESOLVE_SERVICE: ServiceDef = {
  id: "ens-resolve",
  name: "ENS Resolve",
  path: "/x402/ens-resolve",
  priceAtomic: MICRO_PRICE_ATOMIC,
  priceCents: MICRO_PRICE_CENTS,
  description: ENS_RESOLVE_DESCRIPTION,
  tags: ["ethereum", "ens", "identity", "onchain-data"],
  exampleQueryParams: { name: "vitalik.eth" },
  queryParamSchemas: { name: ENS_NAME_SCHEMA, address: ADDRESS_SCHEMA },
  requiredQueryParams: [],
  outputExample: {
    service: "ens-resolve",
    chain: "Ethereum mainnet (ENS)",
    name: "vitalik.eth",
    address: EXAMPLE_ENS_ADDRESS.toLowerCase(),
    primary_name: "vitalik.eth",
    served_by: "Cindy Livia — ENS Resolve (x402)",
    served_at_unix: 1763539200,
  },
};

const GAS_ESTIMATE_SERVICE: ServiceDef = {
  id: "gas-estimate",
  name: "Base Gas Estimate",
  path: "/x402/gas-estimate",
  priceAtomic: GAS_PRICE_ATOMIC,
  priceCents: GAS_PRICE_CENTS,
  description: GAS_ESTIMATE_DESCRIPTION,
  tags: ["base", "gas", "fees", "onchain-data"],
  exampleQueryParams: {},
  queryParamSchemas: {},
  requiredQueryParams: [],
  outputExample: {
    service: "gas-estimate",
    chain: "Base mainnet (eip155:8453)",
    block: 30123456,
    gas_price_wei: "5000000",
    gas_price_gwei: "0.005",
    native_transfer: {
      gas_units: 21000,
      cost_wei: "105000000000",
      cost_eth: "0.000000105",
    },
    erc20_transfer: {
      gas_units: 50000,
      cost_wei: "250000000000",
      cost_eth: "0.00000025",
      estimate_source: "eth_estimateGas (USDC transfer)",
    },
    served_by: "Cindy Livia — Base Gas Estimate (x402)",
    served_at_unix: 1763539200,
  },
};

const CONTRACT_INFO_SERVICE: ServiceDef = {
  id: "contract-info",
  name: "Base Contract Info",
  path: "/x402/contract-info",
  priceAtomic: INFO_PRICE_ATOMIC,
  priceCents: INFO_PRICE_CENTS,
  description: CONTRACT_INFO_DESCRIPTION,
  tags: ["base", "contracts", "proxy", "erc20", "due-diligence"],
  exampleQueryParams: { address: USDC },
  queryParamSchemas: { address: ADDRESS_SCHEMA },
  requiredQueryParams: ["address"],
  outputExample: {
    service: "contract-info",
    address: USDC,
    chain: "Base mainnet (eip155:8453)",
    is_contract: true,
    code_size_bytes: 2200,
    code_hash: "0x9f8b2f2b6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f",
    is_erc20: true,
    name: "USD Coin",
    symbol: "USDC",
    decimals: 6,
    owner: null,
    proxy: {
      is_proxy: true,
      implementation: null,
      admin: null,
      beacon: null,
      beacon_implementation: null,
    },
    served_by: "Cindy Livia — Base Contract Info (x402)",
    served_at_unix: 1763539200,
  },
};

const SERVICES: ServiceDef[] = [
  WALLET_SERVICE,
  REWARD_PROOF_SERVICE,
  TOKEN_SNAPSHOT_SERVICE,
  ERC20_BALANCE_SERVICE,
  TX_RECEIPT_SERVICE,
  ENS_RESOLVE_SERVICE,
  GAS_ESTIMATE_SERVICE,
  CONTRACT_INFO_SERVICE,
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
    version: "1.2.0",
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
    "/x402/erc20-balance": {
      get: {
        summary: "ERC20 token balance + symbol + decimals for an address on Base",
        operationId: "erc20Balance",
        parameters: [
          {
            name: "token",
            in: "query",
            required: true,
            description: "The ERC20 token contract address on Base.",
            schema: { type: "string", pattern: "^0x[0-9a-fA-F]{40}$" },
          },
          {
            name: "address",
            in: "query",
            required: true,
            description: "The wallet address whose balance is read.",
            schema: { type: "string", pattern: "^0x[0-9a-fA-F]{40}$" },
          },
        ],
        responses: {
          "200": { description: "Balance JSON (after x402 payment)." },
          "402": {
            description:
              "x402 payment challenge: pay accepts[0], then retry with header 'X-Payment-Tx: <txHash>'.",
          },
        },
        "x-x402": x402Block(ERC20_BALANCE_SERVICE),
      },
    },
    "/x402/tx-receipt": {
      get: {
        summary: "Decoded Base transaction receipt summary",
        operationId: "txReceipt",
        parameters: [{
          name: "tx",
          in: "query",
          required: true,
          description: "The Base transaction hash to summarize.",
          schema: { type: "string", pattern: "^0x[0-9a-fA-F]{64}$" },
        }],
        responses: {
          "200": { description: "Receipt summary JSON (after x402 payment)." },
          "402": {
            description:
              "x402 payment challenge: pay accepts[0], then retry with header 'X-Payment-Tx: <txHash>'.",
          },
        },
        "x-x402": x402Block(TX_RECEIPT_SERVICE),
      },
    },
    "/x402/ens-resolve": {
      get: {
        summary: "Resolve an ENS name to an address, or an address to its primary ENS name",
        operationId: "ensResolve",
        parameters: [
          {
            name: "name",
            in: "query",
            required: false,
            description: "ENS name to forward-resolve (e.g. vitalik.eth).",
            schema: { type: "string", pattern: "^[a-z0-9-]+(\\.[a-z0-9-]+)+$" },
          },
          {
            name: "address",
            in: "query",
            required: false,
            description: "Address to reverse-resolve (used when name is absent).",
            schema: { type: "string", pattern: "^0x[0-9a-fA-F]{40}$" },
          },
        ],
        responses: {
          "200": { description: "Resolution JSON (after x402 payment)." },
          "402": {
            description:
              "x402 payment challenge: pay accepts[0], then retry with header 'X-Payment-Tx: <txHash>'.",
          },
        },
        "x-x402": x402Block(ENS_RESOLVE_SERVICE),
      },
    },
    "/x402/gas-estimate": {
      get: {
        summary: "Current Base gas price + estimated transfer costs",
        operationId: "gasEstimate",
        parameters: [],
        responses: {
          "200": { description: "Gas estimate JSON (after x402 payment)." },
          "402": {
            description:
              "x402 payment challenge: pay accepts[0], then retry with header 'X-Payment-Tx: <txHash>'.",
          },
        },
        "x-x402": x402Block(GAS_ESTIMATE_SERVICE),
      },
    },
    "/x402/contract-info": {
      get: {
        summary: "Contract info: is-contract, code size/hash, ERC20 metadata, proxy detection",
        operationId: "contractInfo",
        parameters: [{
          name: "address",
          in: "query",
          required: true,
          description: "The Base address to inspect (contract or EOA).",
          schema: { type: "string", pattern: "^0x[0-9a-fA-F]{40}$" },
        }],
        responses: {
          "200": { description: "Contract info JSON (after x402 payment)." },
          "402": {
            description:
              "x402 payment challenge: pay accepts[0], then retry with header 'X-Payment-Tx: <txHash>'.",
          },
        },
        "x-x402": x402Block(CONTRACT_INFO_SERVICE),
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

function priceLabel(service: ServiceDef): string {
  // Exact USD label from the atomic USDC amount (6 decimals): 10000 ->
  // "$0.01", 3000 -> "$0.003". Identical output to the old cents-based
  // formatting for the $0.01 / $0.05 services.
  return "$" + formatUnits(BigInt(service.priceAtomic), 6);
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

// --- Keccak-256 (pure TS; Web Crypto offers SHA3, not Keccak) -----------
// Original Keccak padding (domain byte 0x01), NOT FIPS SHA3 (0x06).
// Needed for ENS namehash and contract code hashes.
const KECCAK_RC: bigint[] = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an,
  0x8000000080008000n, 0x000000000000808bn, 0x0000000080000001n,
  0x8000000080008081n, 0x8000000000008009n, 0x000000000000008an,
  0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n,
  0x8000000000008003n, 0x8000000000008002n, 0x8000000000000080n,
  0x000000000000800an, 0x800000008000000an, 0x8000000080008081n,
  0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];
// Rotation offsets r[x + 5*y] (Keccak spec, Table 2).
const KECCAK_ROT: number[] = [
  0, 1, 62, 28, 27,
  36, 44, 6, 55, 20,
  3, 10, 43, 25, 39,
  41, 45, 15, 21, 8,
  18, 2, 61, 56, 14,
];
const MASK64 = (1n << 64n) - 1n;

function rotl64(x: bigint, n: number): bigint {
  if (n === 0) return x;
  const b = BigInt(n);
  return ((x << b) | (x >> (64n - b))) & MASK64;
}

function keccakF1600(a: bigint[]): void {
  for (let round = 0; round < 24; round++) {
    const c: bigint[] = new Array(5);
    for (let x = 0; x < 5; x++) {
      c[x] = a[x] ^ a[x + 5] ^ a[x + 10] ^ a[x + 15] ^ a[x + 20];
    }
    for (let x = 0; x < 5; x++) {
      const d = c[(x + 4) % 5] ^ rotl64(c[(x + 1) % 5], 1);
      for (let y = 0; y < 5; y++) a[x + 5 * y] ^= d;
    }
    const b: bigint[] = new Array(25).fill(0n);
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) {
        b[y + 5 * ((2 * x + 3 * y) % 5)] =
          rotl64(a[x + 5 * y], KECCAK_ROT[x + 5 * y]);
      }
    }
    for (let y = 0; y < 5; y++) {
      for (let x = 0; x < 5; x++) {
        a[x + 5 * y] = b[x + 5 * y] ^
          ((~b[((x + 1) % 5) + 5 * y] & MASK64) & b[((x + 2) % 5) + 5 * y]);
      }
    }
    a[0] ^= KECCAK_RC[round];
  }
}

function keccak256(data: Uint8Array): Uint8Array {
  const rate = 136; // 1088-bit rate for Keccak-256
  const state: bigint[] = new Array(25).fill(0n);
  const padded = new Uint8Array(
    data.length + (rate - (data.length % rate)),
  );
  padded.set(data);
  padded[data.length] = 0x01;
  padded[padded.length - 1] |= 0x80;
  for (let off = 0; off < padded.length; off += rate) {
    for (let i = 0; i < rate / 8; i++) {
      let lane = 0n;
      for (let j = 7; j >= 0; j--) {
        lane = (lane << 8n) | BigInt(padded[off + i * 8 + j]);
      }
      state[i] ^= lane;
    }
    keccakF1600(state);
  }
  const out = new Uint8Array(32);
  for (let i = 0; i < 4; i++) {
    let lane = state[i];
    for (let j = 0; j < 8; j++) {
      out[i * 8 + j] = Number(lane & 0xffn);
      lane >>= 8n;
    }
  }
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

function keccak256Hex(hex: string): string {
  return "0x" + bytesToHex(keccak256(bytesFromHex(hex)));
}

function namehash(name: string): string {
  let node: Uint8Array = new Uint8Array(32);
  if (name !== "") {
    const labels = name.split(".");
    for (let i = labels.length - 1; i >= 0; i--) {
      const labelHash = keccak256(new TextEncoder().encode(labels[i]));
      const buf = new Uint8Array(64);
      buf.set(node, 0);
      buf.set(labelHash, 32);
      node = keccak256(buf);
    }
  }
  return "0x" + bytesToHex(node);
}

// --- ENS (Ethereum mainnet reads; payment still settles on Base) --------
const ENS_REGISTRY = "0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e";
const ETH_RPCS = [
  "https://ethereum-rpc.publicnode.com",
  "https://eth.drpc.org",
  "https://eth-mainnet.public.blastapi.io",
];

// deno-lint-ignore no-explicit-any
async function rpcEth(method: string, params: unknown[]): Promise<any> {
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });
  let last: unknown = null;
  for (const url of ETH_RPCS) {
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
  throw new Error(`all Ethereum RPCs failed: ${last}`);
}

async function optionalEnsCall(to: string, data: string): Promise<unknown> {
  try {
    const out = await rpcEth("eth_call", [{ to, data }, "latest"]);
    return out === "0x" ? null : out;
  } catch {
    return null;
  }
}

async function ensResolverAddress(node: string): Promise<string | null> {
  const out = await optionalEnsCall(
    ENS_REGISTRY,
    "0x0178b8bf" + node.slice(2), // resolver(bytes32)
  );
  return storageToAddress(out);
}

async function ensForwardResolve(
  name: string,
): Promise<{ address: string | null; resolver: string | null }> {
  const node = namehash(name);
  const resolver = await ensResolverAddress(node);
  if (!resolver) return { address: null, resolver: null };
  const out = await optionalEnsCall(
    resolver,
    "0x3b3b57de" + node.slice(2), // addr(bytes32)
  );
  return { address: storageToAddress(out), resolver };
}

async function ensReverseName(address: string): Promise<string | null> {
  const node = namehash(address.toLowerCase().slice(2) + ".addr.reverse");
  const resolver = await ensResolverAddress(node);
  if (!resolver) return null;
  const out = await optionalEnsCall(
    resolver,
    "0x691f3431" + node.slice(2), // name(bytes32)
  );
  const name = decodeAbiString(out);
  return name && name.length > 0 ? name : null;
}

const ENS_NAME_RE =
  /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

function isEnsName(value: string): boolean {
  return value.length <= 253 && ENS_NAME_RE.test(value);
}

// --- Granular read suite builders ----------------------------------------

async function erc20Balance(token: string, address: string) {
  const meta = await tokenMetadata(token);
  const data = "0x70a08231" + "0".repeat(24) + address.slice(2).toLowerCase();
  const [balRaw, blockRaw] = await Promise.all([
    optionalEthCall(token, data),
    optionalRpc("eth_blockNumber", []),
  ]);
  const balance = typeof balRaw === "string" ? BigInt(balRaw) : null;
  const warnings: string[] = [];
  if (balance === null) {
    warnings.push(
      "balanceOf() did not return a value — the token address may not be an ERC-20 contract.",
    );
  }
  if (meta.decimals === null) {
    warnings.push("decimals() was not exposed; balance is reported atomic-only.");
  }
  return {
    service: ERC20_BALANCE_SERVICE.id,
    chain: "Base mainnet (eip155:8453)",
    block: typeof blockRaw === "string" ? Number(BigInt(blockRaw)) : null,
    token: token.toLowerCase(),
    token_symbol: meta.symbol,
    token_decimals: meta.decimals,
    address,
    balance_atomic: balance === null ? null : balance.toString(),
    balance: balance === null || meta.decimals === null
      ? null
      : formatUnits(balance, meta.decimals),
    warnings,
    served_by: "Cindy Livia — ERC20 Balance (x402)",
    served_at_unix: Math.floor(Date.now() / 1000),
  };
}

async function txReceiptSummary(subjectTx: string) {
  const receipt = await rpc("eth_getTransactionReceipt", [subjectTx]);
  const tx = await rpc("eth_getTransactionByHash", [subjectTx]);
  if (!receipt || !tx) {
    return {
      service: TX_RECEIPT_SERVICE.id,
      subject_tx: subjectTx,
      chain: "Base mainnet (eip155:8453)",
      found: false,
      reason: "transaction not found / not mined yet",
      served_by: "Cindy Livia — Base TX Receipt (x402)",
      served_at_unix: Math.floor(Date.now() / 1000),
    };
  }
  const latest = BigInt(await rpc("eth_blockNumber", []));
  const block = BigInt(receipt.blockNumber);
  const gasUsed = BigInt(receipt.gasUsed ?? "0x0");
  const effPrice = BigInt(receipt.effectiveGasPrice ?? "0x0");
  const fee = gasUsed * effPrice;
  const logs = receipt.logs ?? [];
  let erc20Transfers = 0;
  const emitters = new Set<string>();
  for (const log of logs) {
    if (log.address) emitters.add(String(log.address).toLowerCase());
    const topics: string[] = log.topics ?? [];
    if (
      topics.length >= 3 && topics[0].toLowerCase() === TRANSFER_TOPIC
    ) {
      erc20Transfers++;
    }
  }
  const value = BigInt(tx.value ?? "0x0");
  const input = typeof tx.input === "string" ? tx.input : "0x";
  return {
    service: TX_RECEIPT_SERVICE.id,
    subject_tx: subjectTx,
    chain: "Base mainnet (eip155:8453)",
    found: true,
    block: Number(block),
    confirmations: Number(latest - block + 1n),
    status: receipt.status === "0x1" ? "success" : "reverted",
    from: tx.from ?? null,
    to: tx.to ?? null,
    is_contract_creation: tx.to == null,
    contract_created: receipt.contractAddress ?? null,
    value_wei: value.toString(),
    value_eth: formatUnits(value, 18),
    gas_used: Number(gasUsed),
    effective_gas_price_wei: effPrice.toString(),
    effective_gas_price_gwei: formatUnits(effPrice, 9),
    transaction_fee_wei: fee.toString(),
    transaction_fee_eth: formatUnits(fee, 18),
    erc20_transfer_count: erc20Transfers,
    log_count: logs.length,
    log_emitter_count: emitters.size,
    log_emitters: [...emitters].slice(0, 25),
    method_id: input.length >= 10 ? input.slice(0, 10) : null,
    calldata_bytes: (input.length - 2) / 2,
    served_by: "Cindy Livia — Base TX Receipt (x402)",
    served_at_unix: Math.floor(Date.now() / 1000),
  };
}

async function ensResolve(name: string, address: string) {
  const base = {
    service: ENS_RESOLVE_SERVICE.id,
    chain: "Ethereum mainnet (ENS)",
    served_by: "Cindy Livia — ENS Resolve (x402)",
    served_at_unix: Math.floor(Date.now() / 1000),
  };
  if (name) {
    const { address: resolved, resolver } = await ensForwardResolve(name);
    const primaryName = resolved ? await ensReverseName(resolved) : null;
    return {
      ...base,
      name,
      address: resolved,
      resolver,
      primary_name: primaryName,
      note: resolved
        ? null
        : "No resolver or no address record set for this name.",
    };
  }
  const addr = address.toLowerCase();
  const foundName = await ensReverseName(addr);
  let verified: boolean | null = null;
  if (foundName) {
    const fwd = await ensForwardResolve(foundName);
    verified = fwd.address === addr;
  }
  return {
    ...base,
    address: addr,
    name: foundName,
    verified,
    note: foundName ? null : "No reverse record set for this address.",
  };
}

async function gasEstimate() {
  const transferData = "0xa9059cbb" +
    "0".repeat(24) + PAY_TO.slice(2).toLowerCase() +
    "0".repeat(64); // transfer(PAY_TO, 0) — zero-amount, estimates cleanly
  const [gasPriceRaw, blockRaw, estimateRaw] = await Promise.all([
    rpc("eth_gasPrice", []),
    rpc("eth_getBlockByNumber", ["latest", false]),
    optionalRpc("eth_estimateGas", [{
      from: PAY_TO,
      to: USDC,
      data: transferData,
    }]),
  ]);
  const gasPrice = BigInt(gasPriceRaw);
  const baseFee = blockRaw?.baseFeePerGas
    ? BigInt(blockRaw.baseFeePerGas)
    : null;
  const erc20Units = typeof estimateRaw === "string"
    ? BigInt(estimateRaw)
    : 65000n;
  const cost = (units: bigint) => {
    const wei = units * gasPrice;
    return {
      gas_units: Number(units),
      cost_wei: wei.toString(),
      cost_eth: formatUnits(wei, 18),
    };
  };
  return {
    service: GAS_ESTIMATE_SERVICE.id,
    chain: "Base mainnet (eip155:8453)",
    block: blockRaw?.number ? Number(BigInt(blockRaw.number)) : null,
    gas_price_wei: gasPrice.toString(),
    gas_price_gwei: formatUnits(gasPrice, 9),
    base_fee_wei: baseFee === null ? null : baseFee.toString(),
    base_fee_gwei: baseFee === null ? null : formatUnits(baseFee, 9),
    native_transfer: cost(21000n),
    erc20_transfer: {
      ...cost(erc20Units),
      estimate_source: typeof estimateRaw === "string"
        ? "eth_estimateGas (USDC transfer)"
        : "reference value (eth_estimateGas unavailable)",
    },
    served_by: "Cindy Livia — Base Gas Estimate (x402)",
    served_at_unix: Math.floor(Date.now() / 1000),
  };
}

const EIP1967_IMPL_SLOT =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const EIP1967_ADMIN_SLOT =
  "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";
const EIP1967_BEACON_SLOT =
  "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50";

async function contractInfo(address: string) {
  const [
    codeRaw,
    nameRaw,
    symbolRaw,
    decimalsRaw,
    supplyRaw,
    ownerRaw,
    implRaw,
    adminRaw,
    beaconRaw,
  ] = await Promise.all([
    optionalRpc("eth_getCode", [address, "latest"]),
    optionalEthCall(address, "0x06fdde03"),
    optionalEthCall(address, "0x95d89b41"),
    optionalEthCall(address, "0x313ce567"),
    optionalEthCall(address, "0x18160ddd"),
    optionalEthCall(address, "0x8da5cb5b"),
    optionalRpc("eth_getStorageAt", [address, EIP1967_IMPL_SLOT, "latest"]),
    optionalRpc("eth_getStorageAt", [address, EIP1967_ADMIN_SLOT, "latest"]),
    optionalRpc("eth_getStorageAt", [address, EIP1967_BEACON_SLOT, "latest"]),
  ]);
  const code = typeof codeRaw === "string" ? codeRaw : "0x";
  const isContract = code !== "0x";
  const decimals = typeof decimalsRaw === "string"
    ? Number(BigInt(decimalsRaw))
    : null;
  const supply = typeof supplyRaw === "string" ? BigInt(supplyRaw) : null;
  const name = decodeAbiString(nameRaw);
  const symbol = decodeAbiString(symbolRaw);
  const isErc20 = isContract && symbol !== null && decimals !== null &&
    supply !== null;
  const implementation = storageToAddress(implRaw);
  const admin = storageToAddress(adminRaw);
  const beacon = storageToAddress(beaconRaw);
  let beaconImplementation: string | null = null;
  if (beacon) {
    const out = await optionalEthCall(beacon, "0x5c60da1b"); // implementation()
    beaconImplementation = storageToAddress(out);
  }
  const warnings = [
    "Factual chain data only; this info is not a safety guarantee or investment advice.",
  ];
  if (!isContract) {
    warnings.push(
      "Address holds no bytecode — it is not a contract (EOA or not yet deployed).",
    );
  }
  if (implementation || beacon) {
    warnings.push(
      "Proxy detected; inspect the implementation contract as well as this address.",
    );
  }
  return {
    service: CONTRACT_INFO_SERVICE.id,
    address,
    chain: "Base mainnet (eip155:8453)",
    is_contract: isContract,
    code_size_bytes: isContract ? (code.length - 2) / 2 : 0,
    code_hash: isContract ? keccak256Hex(code) : null,
    is_erc20: isErc20,
    name,
    symbol,
    decimals,
    total_supply_atomic: supply === null ? null : supply.toString(),
    total_supply: supply === null || decimals === null
      ? null
      : formatUnits(supply, decimals),
    owner: storageToAddress(ownerRaw),
    proxy: {
      is_proxy: implementation !== null || beacon !== null,
      implementation,
      admin,
      beacon,
      beacon_implementation: beaconImplementation,
    },
    warnings,
    served_by: "Cindy Livia — Base Contract Info (x402)",
    served_at_unix: Math.floor(Date.now() / 1000),
  };
}

// --- Facilitator + discovery (LIVE) -------------------------------------
//
// Mechanism (x402 spec; Coinbase CDP docs "Get discovered"; PayAI docs):
// - Every 402 declares extensions.bazaar (info + schema) and resource
//   service metadata (serviceName, tags). That alone passes CDP's free
//   /x402/validate endpoint, but does NOT list the resource.
// - Listing happens only when a payment SETTLES through a facilitator that
//   runs a discovery catalog: the buyer echoes resource + extensions.bazaar
//   in the PaymentPayload, the facilitator validates info against schema,
//   catalogs the resource, and (CDP) reports the outcome in an
//   EXTENSION-RESPONSES header (bazaar.status). PayAI runs its own catalog
//   (GET /discovery/resources on the facilitator origin).
// - Facilitator auth differs by provider:
//   * CDP Facilitator: CDP API key ID + secret (JWT) — needs a Coinbase
//     CDP account. Without keys, cdp mode refuses cleanly (see
//     facilitatorGate).
//   * PayAI Facilitator: KEYLESS free tier — no account, no API key. Each
//     payTo starts with 1,000 free credits; a Base mainnet exact/EIP-3009
//     settlement costs 1.56 credits (~$0.00156) per /pricing on
//     2026-11-18, Base Sepolia settlements are free (0 credits). An
//     optional paid tier authenticates with an API key id + secret sent
//     as HTTP Basic.
//   * OpenFacilitator (pay.openfacilitator.io): also keyless; kept as a
//     fallback URL option.
//
// Facilitator selection via env:
// - X402_FACILITATOR_URL — facilitator base URL.
//   Default in this deployment: PayAI (keyless). Set to the CDP URL to
//   use the Coinbase CDP Facilitator instead.
// - X402_FACILITATOR_AUTH — "cdp" | "basic" | "none".
//   Default: "cdp" when the URL is the CDP one, otherwise "none".
//   "basic" uses FACILITATOR_API_KEY_ID / FACILITATOR_API_KEY_SECRET.

const CDP_FACILITATOR_URL = "https://api.cdp.coinbase.com/platform/v2/x402";
const PAYAI_FACILITATOR_URL = "https://facilitator.payai.network";

function facilitatorUrl(): string {
  return envGet("X402_FACILITATOR_URL") ?? PAYAI_FACILITATOR_URL;
}

function facilitatorAuthMode(): "cdp" | "basic" | "none" {
  const m = envGet("X402_FACILITATOR_AUTH");
  if (m === "cdp" || m === "basic" || m === "none") return m;
  return facilitatorUrl() === CDP_FACILITATOR_URL ? "cdp" : "none";
}

function facilitatorLabel(): string {
  const u = facilitatorUrl();
  if (u === CDP_FACILITATOR_URL) return "CDP Facilitator";
  if (u === PAYAI_FACILITATOR_URL) return "PayAI Facilitator (keyless)";
  return `facilitator at ${u}`;
}
const SERVICE_NAME = "Cindy Livia Agent Services";

// deno-lint-ignore no-explicit-any
function envGet(name: string): string | undefined {
  // deno-lint-ignore no-explicit-any
  const g = globalThis as any;
  try {
    if (typeof g.Deno?.env?.get === "function") {
      return g.Deno.env.get(name) ?? undefined;
    }
  } catch { /* not Deno */ }
  try {
    if (typeof g.process?.env?.[name] === "string") return g.process.env[name];
  } catch { /* not Node */ }
  return undefined;
}

function bazaarExtension(service: ServiceDef) {
  return {
    info: {
      input: {
        type: "http",
        method: "GET",
        queryParams: service.exampleQueryParams,
      },
      output: { type: "json", example: service.outputExample },
    },
    schema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        input: {
          type: "object",
          properties: {
            type: { type: "string", const: "http" },
            method: { type: "string", enum: ["GET", "HEAD", "DELETE"] },
            queryParams: {
              type: "object",
              properties: service.queryParamSchemas,
              required: service.requiredQueryParams,
            },
            headers: {
              type: "object",
              additionalProperties: { type: "string" },
            },
          },
          required: ["type", "method"],
          additionalProperties: false,
        },
        output: {
          type: "object",
          properties: {
            type: { type: "string" },
            example: { type: "object" },
          },
          required: ["type"],
        },
      },
      required: ["input"],
    },
  };
}

function b64DecodeJson(text: string): unknown {
  const bin = atob(text);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes));
}

function b64urlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// CDP API-key JWT (EdDSA over the key's Ed25519 secret), per the CDP JWT
// recipe. NOTE: implemented; settle path exercised via facilitator /verify rehearsal 2026-11-19 — it can only run once real
// CDP API keys exist, and must be re-verified against the live CDP docs at
// that point. Returns null when no keys are configured (the gate).
async function cdpJwt(uri: string): Promise<string | null> {
  const keyId = envGet("CDP_API_KEY_ID");
  const keySecret = envGet("CDP_API_KEY_SECRET");
  if (!keyId || !keySecret) return null;
  const { createPrivateKey, sign } = await import("node:crypto");
  const raw = Uint8Array.from(atob(keySecret), (c) => c.charCodeAt(0));
  const seed = raw.length > 32 ? raw.slice(0, 32) : raw;
  const pkcs8 = new Uint8Array([
    0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70,
    0x04, 0x22, 0x04, 0x20, ...seed,
  ]);
  const key = createPrivateKey({
    key: Buffer.from(pkcs8),
    format: "der",
    type: "pkcs8",
  });
  const now = Math.floor(Date.now() / 1000);
  const enc = (o: unknown) =>
    b64urlEncode(new TextEncoder().encode(JSON.stringify(o)));
  const signingInput = `${enc({ alg: "EdDSA", typ: "JWT", kid: keyId })}.${enc({
    iss: "cdp",
    sub: keyId,
    aud: ["cdp_service"],
    nbf: now,
    exp: now + 120,
    uris: [uri],
  })}`;
  const signature = sign(null, Buffer.from(signingInput), key);
  return `${signingInput}.${b64urlEncode(new Uint8Array(signature))}`;
}

interface FacilitatorOutcome {
  ok: boolean;
  reason: string;
  bazaarStatus?: string;
  paymentResponseHeader?: string;
}

// Handles the standard x402 payment path (PAYMENT-SIGNATURE header).
// Returns null when the request carries no such header (not this path).
// On success the payment is verified AND settled via the configured
// facilitator (default: keyless PayAI; CDP remains selectable) before
// content is served, and any Bazaar extension outcome is captured.
async function facilitatorGate(
  req: Request,
  resourceUrl: string,
  service: ServiceDef,
): Promise<FacilitatorOutcome | null> {
  const sigHeader = req.headers.get("payment-signature");
  if (!sigHeader) return null;
  // deno-lint-ignore no-explicit-any
  let payload: any;
  try {
    payload = b64DecodeJson(sigHeader);
  } catch {
    return { ok: false, reason: "malformed PAYMENT-SIGNATURE header" };
  }
  // Fail fast on junk before spending a facilitator call: our accepts[0] is
  // an EVM exact (EIP-3009) requirement, so a genuine client payload must
  // carry payload.authorization + payload.signature.
  // deno-lint-ignore no-explicit-any
  const inner = (payload as any)?.payload;
  if (
    !inner || typeof inner.signature !== "string" ||
    !inner.authorization || typeof inner.authorization !== "object"
  ) {
    return {
      ok: false,
      reason:
        "malformed payment payload: expected an EIP-3009 authorization " +
        "and signature in the PAYMENT-SIGNATURE payload",
    };
  }
  // Auth per configured facilitator (see facilitatorAuthMode):
  // - "cdp": CDP API-key JWT (account gate — refuses cleanly without keys)
  // - "basic": FACILITATOR_API_KEY_ID/SECRET as HTTP Basic (PayAI paid tier)
  // - "none": keyless public facilitator (PayAI free tier, OpenFacilitator)
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  const mode = facilitatorAuthMode();
  if (mode === "cdp") {
    const auth = await cdpJwt(
      "POST api.cdp.coinbase.com/platform/v2/x402/settle",
    );
    if (!auth) {
      return {
        ok: false,
        reason:
          "standard x402 payment received, but the CDP Facilitator is not " +
          "configured on this server (CDP_API_KEY_ID / CDP_API_KEY_SECRET " +
          "missing). Settling through the CDP Facilitator requires a Coinbase " +
          "CDP account API key.",
      };
    }
    headers.Authorization = `Bearer ${auth}`;
  } else if (mode === "basic") {
    const keyId = envGet("FACILITATOR_API_KEY_ID");
    const keySecret = envGet("FACILITATOR_API_KEY_SECRET");
    if (!keyId || !keySecret) {
      return {
        ok: false,
        reason:
          "facilitator auth mode 'basic' is selected but " +
          "FACILITATOR_API_KEY_ID / FACILITATOR_API_KEY_SECRET are missing " +
          "on this server",
      };
    }
    headers.Authorization = `Basic ${btoa(`${keyId}:${keySecret}`)}`;
  }
  const fUrl = facilitatorUrl();
  // Clients are expected to echo resource + extensions from the 402. Fill
  // them from our own declaration when absent so discovery can catalog.
  payload.resource = {
    url: resourceUrl,
    description: service.description,
    mimeType: "application/json",
    serviceName: SERVICE_NAME,
    tags: service.tags,
  };
  payload.extensions = {
    ...(payload.extensions ?? {}),
    bazaar: bazaarExtension(service),
  };
  const body = JSON.stringify({
    x402Version: 2,
    paymentPayload: payload,
    paymentRequirements: challenge(resourceUrl, service).accepts[0],
  });
  const readBazaarStatus = (r: Response): string | undefined => {
    const h = r.headers.get("extension-responses");
    if (!h) return undefined;
    try {
      // deno-lint-ignore no-explicit-any
      const obj = b64DecodeJson(h) as any;
      return obj?.bazaar?.status as string | undefined;
    } catch {
      return undefined;
    }
  };
  let bazaarStatus: string | undefined;
  try {
    const vr = await fetch(`${fUrl}/verify`, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(20000),
    });
    bazaarStatus = readBazaarStatus(vr);
    // deno-lint-ignore no-explicit-any
    const v = await vr.json() as any;
    if (!v?.isValid) {
      return {
        ok: false,
        reason: `facilitator verify rejected: ${v?.invalidReason ?? vr.status}`,
        bazaarStatus,
      };
    }
    const sr = await fetch(`${fUrl}/settle`, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(20000),
    });
    bazaarStatus = readBazaarStatus(sr) ?? bazaarStatus;
    // deno-lint-ignore no-explicit-any
    const s = await sr.json() as any;
    if (!s?.success) {
      return {
        ok: false,
        reason: `facilitator settle failed: ${s?.errorReason ?? sr.status}`,
        bazaarStatus,
      };
    }
    console.log(
      `[facilitator] settled ${service.path} via ${facilitatorLabel()} ` +
        `bazaar.status=${bazaarStatus ?? "n/a"}`,
    );
    return {
      ok: true,
      reason: "ok",
      bazaarStatus,
      paymentResponseHeader: b64EncodeJson(s),
    };
  } catch (e) {
    return { ok: false, reason: `facilitator call failed: ${e}`, bazaarStatus };
  }
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
      serviceName: SERVICE_NAME,
      tags: service.tags,
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
    extensions: { bazaar: bazaarExtension(service) },
    proof:
      "Standard x402: sign the accepts[0] payment (EIP-3009) and retry with " +
      "header 'PAYMENT-SIGNATURE: <base64 payload>'; settlement runs through " +
      "a standard x402 facilitator (this deployment defaults to the " +
      "keyless PayAI Facilitator; the CDP Facilitator remains supported via " +
      "server config). Legacy: pay accepts[0] by a direct USDC transfer " +
      "to payTo on Base, then retry with header 'X-Payment-Tx: <txHash>'.",
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
      `- Price: ${priceLabel(s)} USDC on Base (atomic amount ${s.priceAtomic})`,
      `- Description: ${s.description}`,
      "",
    );
  }
  lines.push(
    "## Machine-readable discovery",
    `- OpenAPI: ${origin}/openapi.json`,
    `- x402 index: ${origin}/.well-known/x402.json`,
    `- Health: ${origin}/health`,
    "- Facilitator discovery: every 402 challenge declares extensions.bazaar; " +
    "resources are cataloged after a settled payment by the settling " +
    "facilitator's discovery catalog (CDP Bazaar when settled via the CDP " +
    "Facilitator; the PayAI discovery catalog when settled via PayAI).",
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

type ParamParse =
  | { kind: "missing"; message: string }
  | { kind: "invalid"; message: string }
  | { kind: "ok"; build: () => Promise<unknown> };

// Shared paywall flow for the granular suite — step-for-step the same as
// the three original endpoint handlers above: facilitator gate first,
// legacy X-Payment-Tx second, paywall before validation, missing params
// answered with a 402, malformed params with a 400 (before any payment
// tx is redeemed), then build + serve with the settlement receipt header.
async function servePaidEndpoint(
  req: Request,
  u: URL,
  service: ServiceDef,
  failLabel: string,
  parse: () => ParamParse,
): Promise<Response> {
  const absUrl = u.href; // full request URL incl. query: strict x402 clients require resource.url === request URL
  const fac = await facilitatorGate(req, absUrl, service);
  if (fac && !fac.ok) {
    return paymentRequired(
      absUrl,
      service,
      `Payment not accepted: ${fac.reason}`,
    );
  }
  const txhash = req.headers.get("x-payment-tx");
  if (!txhash && !fac) {
    return paymentRequired(absUrl, service);
  }
  const parsed = parse();
  if (parsed.kind === "missing") {
    return paymentRequired(absUrl, service, parsed.message);
  }
  if (parsed.kind === "invalid") {
    return sendJson(400, { error: parsed.message });
  }
  if (!fac) {
    const [ok, reason] = await verifyPayment(
      (txhash as string).trim(),
      service.priceAtomic,
    );
    if (!ok) {
      return paymentRequired(
        absUrl,
        service,
        `Payment not accepted: ${reason}`,
      );
    }
  }
  try {
    const resp = sendJson(200, await parsed.build());
    if (fac?.paymentResponseHeader) {
      resp.headers.set("payment-response", fac.paymentResponseHeader);
    }
    return resp;
  } catch (e) {
    return sendJson(502, { error: `${failLabel} failed: ${e}` });
  }
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
        price: `${priceLabel(s)} USDC on Base (x402)`,
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
      resources: SERVICES.map((s) => {
        const ch = challenge(u.origin + s.path, s);
        return {
          url: u.origin + s.path,
          type: "http",
          method: "GET",
          description: s.description,
          accepts: ch.accepts,
          extensions: ch.extensions,
          proof: ch.proof,
        };
      }),
    });
  }
  if (u.pathname === "/x402/base-wallet-report") {
    // Paywall BEFORE request validation: an unpaid request always gets the
    // 402 challenge, even without ?address= (discovery tools like x402scan
    // probe the bare URL and require a 402 there; the Bazaar indexer probes
    // with the declared example input and likewise requires the 402 first).
    const absUrl = u.href; // full request URL incl. query: strict x402 clients require resource.url === request URL
    const fac = await facilitatorGate(req, absUrl, WALLET_SERVICE);
    if (fac && !fac.ok) {
      return paymentRequired(
        absUrl,
        WALLET_SERVICE,
        `Payment not accepted: ${fac.reason}`,
      );
    }
    const txhash = req.headers.get("x-payment-tx");
    if (!txhash && !fac) {
      return paymentRequired(absUrl, WALLET_SERVICE);
    }
    const address = u.searchParams.get("address") ?? "";
    if (!address) {
      return paymentRequired(
        absUrl,
        WALLET_SERVICE,
        "Payment proof received, but the request is missing ?address=0x... — resend with the address to get the report.",
      );
    }
    if (!isAddress(address)) {
      return sendJson(400, {
        error: "address must be a 0x-prefixed 20-byte hex address",
      });
    }
    if (!fac) {
      const [ok, reason] = await verifyPayment(
        (txhash as string).trim(),
        WALLET_SERVICE.priceAtomic,
      );
      if (!ok) {
        return paymentRequired(
          absUrl,
          WALLET_SERVICE,
          `Payment not accepted: ${reason}`,
        );
      }
    }
    try {
      const resp = sendJson(200, await walletReport(address));
      if (fac?.paymentResponseHeader) {
        resp.headers.set("payment-response", fac.paymentResponseHeader);
      }
      return resp;
    } catch (e) {
      return sendJson(502, { error: `report failed: ${e}` });
    }
  }
  if (u.pathname === "/x402/agent-reward-proof") {
    const service = REWARD_PROOF_SERVICE;
    const absUrl = u.href; // full request URL incl. query: strict x402 clients require resource.url === request URL
    const fac = await facilitatorGate(req, absUrl, service);
    if (fac && !fac.ok) {
      return paymentRequired(
        absUrl,
        service,
        `Payment not accepted: ${fac.reason}`,
      );
    }
    const txhash = req.headers.get("x-payment-tx");
    if (!txhash && !fac) {
      return paymentRequired(absUrl, service);
    }
    const subjectTx = u.searchParams.get("tx") ?? u.searchParams.get("txhash") ?? "";
    if (!subjectTx) {
      return paymentRequired(
        absUrl,
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
    if (!fac) {
      const [ok, reason] = await verifyPayment(
        (txhash as string).trim(),
        service.priceAtomic,
      );
      if (!ok) {
        return paymentRequired(
          absUrl,
          service,
          `Payment not accepted: ${reason}`,
        );
      }
    }
    try {
      const resp = sendJson(200, await rewardProof(subjectTx, expectedTo));
      if (fac?.paymentResponseHeader) {
        resp.headers.set("payment-response", fac.paymentResponseHeader);
      }
      return resp;
    } catch (e) {
      return sendJson(502, { error: `reward proof failed: ${e}` });
    }
  }
  if (u.pathname === "/x402/base-token-snapshot") {
    const service = TOKEN_SNAPSHOT_SERVICE;
    const absUrl = u.href; // full request URL incl. query: strict x402 clients require resource.url === request URL
    const fac = await facilitatorGate(req, absUrl, service);
    if (fac && !fac.ok) {
      return paymentRequired(
        absUrl,
        service,
        `Payment not accepted: ${fac.reason}`,
      );
    }
    const txhash = req.headers.get("x-payment-tx");
    if (!txhash && !fac) {
      return paymentRequired(absUrl, service);
    }
    const address = u.searchParams.get("address") ?? "";
    if (!address) {
      return paymentRequired(
        absUrl,
        service,
        "Payment proof received, but the request is missing ?address=0x... — resend with the token address to get the snapshot.",
      );
    }
    if (!isAddress(address)) {
      return sendJson(400, {
        error: "address must be a 0x-prefixed 20-byte hex address",
      });
    }
    if (!fac) {
      const [ok, reason] = await verifyPayment(
        (txhash as string).trim(),
        service.priceAtomic,
      );
      if (!ok) {
        return paymentRequired(
          absUrl,
          service,
          `Payment not accepted: ${reason}`,
        );
      }
    }
    try {
      const resp = sendJson(200, await tokenSnapshot(address));
      if (fac?.paymentResponseHeader) {
        resp.headers.set("payment-response", fac.paymentResponseHeader);
      }
      return resp;
    } catch (e) {
      return sendJson(502, { error: `token snapshot failed: ${e}` });
    }
  }
  if (u.pathname === "/x402/erc20-balance") {
    const service = ERC20_BALANCE_SERVICE;
    return servePaidEndpoint(req, u, service, "balance check", () => {
      const token = u.searchParams.get("token") ?? "";
      const address = u.searchParams.get("address") ?? "";
      if (!token || !address) {
        return {
          kind: "missing",
          message:
            "Payment proof received, but the request is missing ?token=0x... and/or ?address=0x... — resend with both to get the balance.",
        };
      }
      if (!isAddress(token)) {
        return {
          kind: "invalid",
          message: "token must be a 0x-prefixed 20-byte hex address",
        };
      }
      if (!isAddress(address)) {
        return {
          kind: "invalid",
          message: "address must be a 0x-prefixed 20-byte hex address",
        };
      }
      return { kind: "ok", build: () => erc20Balance(token, address) };
    });
  }
  if (u.pathname === "/x402/tx-receipt") {
    const service = TX_RECEIPT_SERVICE;
    return servePaidEndpoint(req, u, service, "receipt summary", () => {
      const subjectTx = u.searchParams.get("tx") ??
        u.searchParams.get("txhash") ?? "";
      if (!subjectTx) {
        return {
          kind: "missing",
          message:
            "Payment proof received, but the request is missing ?tx=0x... for the transaction to summarize — resend with the transaction hash.",
        };
      }
      if (!isTxHash(subjectTx)) {
        return {
          kind: "invalid",
          message: "tx must be a 0x-prefixed 32-byte transaction hash",
        };
      }
      return { kind: "ok", build: () => txReceiptSummary(subjectTx) };
    });
  }
  if (u.pathname === "/x402/ens-resolve") {
    const service = ENS_RESOLVE_SERVICE;
    return servePaidEndpoint(req, u, service, "ENS resolution", () => {
      const name = (u.searchParams.get("name") ?? "").trim().toLowerCase();
      const address = u.searchParams.get("address") ?? "";
      if (!name && !address) {
        return {
          kind: "missing",
          message:
            "Payment proof received, but the request is missing ?name=vitalik.eth or ?address=0x... — resend with one of them to resolve.",
        };
      }
      if (name && !isEnsName(name)) {
        return {
          kind: "invalid",
          message:
            "name must be a valid ENS name (dot-separated labels of letters, digits, hyphens)",
        };
      }
      if (address && !isAddress(address)) {
        return {
          kind: "invalid",
          message: "address must be a 0x-prefixed 20-byte hex address",
        };
      }
      return { kind: "ok", build: () => ensResolve(name, address) };
    });
  }
  if (u.pathname === "/x402/gas-estimate") {
    const service = GAS_ESTIMATE_SERVICE;
    return servePaidEndpoint(req, u, service, "gas estimate", () => ({
      kind: "ok",
      build: () => gasEstimate(),
    }));
  }
  if (u.pathname === "/x402/contract-info") {
    const service = CONTRACT_INFO_SERVICE;
    return servePaidEndpoint(req, u, service, "contract info", () => {
      const address = u.searchParams.get("address") ?? "";
      if (!address) {
        return {
          kind: "missing",
          message:
            "Payment proof received, but the request is missing ?address=0x... — resend with the address to inspect.",
        };
      }
      if (!isAddress(address)) {
        return {
          kind: "invalid",
          message: "address must be a 0x-prefixed 20-byte hex address",
        };
      }
      return { kind: "ok", build: () => contractInfo(address) };
    });
  }
  return sendJson(404, { error: "not found" });
}


export default handler;
export const config = { path: "/*" };
// Exported for local tests (test-granular.ts): pure functions, no I/O.
export { keccak256Hex, namehash };
