#!/usr/bin/env node
// Stoa swap indexer for Robinhood Chain (community project, not affiliated with Stoa).
// Node 18+, no dependencies.   Run:  node indexer.js
//
// What it does
//   1. Scans the Stoa router for its swap event (one per swap) in 5M-block chunks.
//   2. Fetches each new transaction's receipt and decodes: trader, token in/out, amounts,
//      fee + referrer (FeeNotified), and which venues (pools) the swap touched.
//   3. Prices each swap in USD from one leg (USDG = $1; ETH/WETH legs use the median
//      ETH/USDG price of the 3 nearest ETH<->USDG swaps in the same dataset).
//   4. Writes docs/data.json and docs/data.js (the page reads data.js).
//
// It aborts without writing if any RPC chunk fails, so an outage can never publish an undercount.

const fs = require("fs");
const path = require("path");

const RPC = process.env.RPC_URL || "https://rpc.mainnet.chain.robinhood.com";
const START_BLOCK = Number(process.env.START_BLOCK || 114_000_000); // first Stoa log is at block 114,378,637
const CHUNK = 5_000_000; // public RPC rejects eth_getLogs ranges above 10M blocks
const OUT_DIR = path.join(__dirname, "docs");

// ---- on-chain constants (found by reading real Stoa swap receipts) ----
const ROUTER = "0x2f2804fad735a38015650f32f95ad5e08d6b3ee5"; // every Stoa swap tx is sent to this address
const FEE_CONTRACT = "0x76c30317bb8c0bc47e2ac5d83b329fe9f386f4e7"; // emits FeeNotified
// Router swap event. topics: [sig, sender, recipient, ?]; data words:
//   0 tokenIn, 1 tokenOut, 2 amountIn, 3 amountOut, 4..6 not used here (0 address = native ETH)
const SWAP_TOPIC = "0x2bbce25631e8fa58085b7ea5929726c3acdf2df8d6b1f099eb32fb7425a4f6da";
// FeeNotified(address indexed from, address indexed token, uint256 amount, address indexed referrer, uint256 toReferrer)
const FEE_TOPIC = "0xfc354255eea0fec672c0256537b36b6196c22f820143d92bb0f523b7d847860b";
const ZERO = "0x0000000000000000000000000000000000000000";
const USDG = "0x5fc5360d0400a0fd4f2af552add042d716f1d168";
const WETH = "0x0bd7d308f8e1639fab988df18a8011f41eacad73";

// Venue detection: a swap "touches" a venue when the receipt holds one of these pool events.
const V3_SWAP = "0xc42079f9"; // first 4 bytes of the V3-style pool Swap topic
const V4_SWAP = "0x40e9cecb"; // first 4 bytes of the v4-style Swap topic
// Add venues you identify on Blockscout: emitter address (lowercase) -> label. Any log from these counts.
const VENUE_LABELS = {
  // "0xe5e702641ea86f4ae6cc3cdaed2b886f976be044": "name it here",
  // "0x987e330f00b79864a07fe81dfac344d0078abcc0": "name it here",
  // "0xa5cc0d059ac8171743ec36bf436c20e7d899ad19": "name it here",
};

// Optional: wallets to leave out of every number (e.g. team test wallets). Lowercase addresses.
const EXCLUDE_TRADERS = [];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const short = (a) => a.slice(0, 6) + "…" + a.slice(-4);
const lower = (s) => s.toLowerCase();

async function rpc(method, params, tries = 5) {
  let lastErr = "unknown";
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(RPC, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
      const j = await r.json();
      if (!j.error) return j.result;
      lastErr = j.error.message;
    } catch (e) {
      lastErr = e.message;
    }
    await sleep(1000 * (i + 1));
  }
  throw new Error(`${method} failed: ${lastErr}`);
}

const hex = (n) => "0x" + n.toString(16);
const words = (data) => (data.length > 2 ? data.slice(2).match(/.{64}/g) : []);
const wordAddr = (w) => "0x" + w.slice(24).toLowerCase();
const topicAddr = (t) => "0x" + t.slice(26).toLowerCase();

// ---- token metadata ----
const tokens = { [ZERO]: { symbol: "ETH", decimals: 18 } };
async function ensureToken(a) {
  if (tokens[a]) return tokens[a];
  let decimals = 18, symbol = "?";
  try {
    const d = await rpc("eth_call", [{ to: a, data: "0x313ce567" }, "latest"]);
    if (d && d !== "0x") decimals = parseInt(d, 16);
  } catch (e) {}
  try {
    const s = await rpc("eth_call", [{ to: a, data: "0x95d89b41" }, "latest"]);
    if (s && s.length >= 130) {
      const len = parseInt(s.slice(66, 130), 16);
      symbol = Buffer.from(s.slice(130, 130 + len * 2), "hex").toString().replace(/[^\x20-\x7e]/g, "") || "?";
    }
  } catch (e) {}
  return (tokens[a] = { symbol, decimals });
}
const human = (raw, dec) => {
  // exact for the integer part, safe for very large raw values
  const s = BigInt(raw).toString().padStart(dec + 1, "0");
  return Number(s.slice(0, s.length - dec) + "." + s.slice(s.length - dec));
};

function venuesOf(logs) {
  const found = new Map();
  for (const l of logs) {
    const em = lower(l.address);
    const t4 = l.topics[0].slice(0, 10);
    let label = VENUE_LABELS[em];
    if (!label && t4 === V4_SWAP) label = "Uniswap v4";
    if (!label && t4 === V3_SWAP) label = "V3-style pool " + short(em);
    if (label) found.set(em, label);
  }
  return [...found].map(([address, label]) => ({ address, label }));
}

// ---- USD pricing ----
function priceRows(rows) {
  const isEth = (a) => a === ZERO || a === WETH;
  const usdgLeg = (r) => (r.tokenIn === USDG ? r.amountIn : r.tokenOut === USDG ? r.amountOut : null);
  const ethLeg = (r) => (isEth(r.tokenIn) ? r.amountIn : isEth(r.tokenOut) ? r.amountOut : null);
  const points = rows
    .filter((r) => usdgLeg(r) > 0 && ethLeg(r) > 0)
    .map((r) => ({ time: r.time, price: usdgLeg(r) / ethLeg(r) }));
  const median = (xs) => xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)];
  for (const r of rows) {
    const u = usdgLeg(r), e = ethLeg(r);
    if (u !== null) { r.usd = u; r.usdBasis = "USDG"; }
    else if (e !== null && points.length) {
      const near = [...points].sort((a, b) => Math.abs(a.time - r.time) - Math.abs(b.time - r.time)).slice(0, 3);
      r.usd = e * median(near.map((p) => p.price));
      r.usdBasis = "ETH";
    } else { r.usd = null; r.usdBasis = null; }
  }
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const prevPath = path.join(OUT_DIR, "data.json");
  const prev = fs.existsSync(prevPath) ? JSON.parse(fs.readFileSync(prevPath, "utf8")) : null;
  const prevRows = new Map((prev ? prev.swaps : []).map((r) => [r.id, r]));
  if (prev) for (const [a, m] of Object.entries(prev.tokens)) tokens[a] = m;

  const latest = parseInt(await rpc("eth_blockNumber", []), 16);
  console.log("latest block", latest);

  // 1. every router swap event
  const logs = [];
  for (let from = START_BLOCK; from <= latest; from += CHUNK) {
    const to = Math.min(from + CHUNK - 1, latest);
    const res = await rpc("eth_getLogs", [{ address: ROUTER, topics: [SWAP_TOPIC], fromBlock: hex(from), toBlock: hex(to) }]);
    logs.push(...res);
    await sleep(250);
  }
  console.log("router swap events found:", logs.length);

  // 2. decode (receipts only for transactions we have not seen before)
  const rows = [];
  const blockTime = {};
  const byTx = {};
  for (const l of logs) (byTx[l.transactionHash] ||= []).push(l);
  for (const [hash, evs] of Object.entries(byTx)) {
    const ids = evs.map((l) => `${hash}:${parseInt(l.logIndex, 16)}`);
    if (ids.every((id) => prevRows.has(id))) { ids.forEach((id) => rows.push(prevRows.get(id))); continue; }
    const rc = await rpc("eth_getTransactionReceipt", [hash]);
    if (!rc) throw new Error("no receipt for " + hash);
    const bn = rc.blockNumber;
    if (!blockTime[bn]) blockTime[bn] = parseInt((await rpc("eth_getBlockByNumber", [bn, false])).timestamp, 16);
    const fees = [];
    for (const l of rc.logs) {
      if (lower(l.address) === FEE_CONTRACT && l.topics[0] === FEE_TOPIC) {
        const token = topicAddr(l.topics[2]);
        const m = await ensureToken(token);
        const w = words(l.data);
        fees.push({
          token, referrer: topicAddr(l.topics[3]),
          amount: human("0x" + w[0], m.decimals), toReferrer: human("0x" + w[1], m.decimals),
        });
      }
    }
    const venues = venuesOf(rc.logs);
    for (const [i, l] of evs.entries()) {
      const w = words(l.data);
      const tokenIn = wordAddr(w[0]), tokenOut = wordAddr(w[1]);
      const mi = await ensureToken(tokenIn), mo = await ensureToken(tokenOut);
      rows.push({
        id: ids[i], hash, block: parseInt(bn, 16), time: blockTime[bn],
        trader: topicAddr(l.topics[1]), recipient: topicAddr(l.topics[2]),
        tokenIn, tokenOut,
        amountIn: human("0x" + w[2], mi.decimals), amountOut: human("0x" + w[3], mo.decimals),
        fees: i === 0 ? fees : [], // fee events are per transaction; attach to the first swap in it
        venues,
      });
    }
    await sleep(120);
  }

  // 3. filter, price, sort
  const kept = rows.filter((r) => !EXCLUDE_TRADERS.includes(r.trader));
  kept.sort((a, b) => a.block - b.block || a.id.localeCompare(b.id));
  priceRows(kept);

  const data = {
    generatedAt: new Date().toISOString(),
    chainId: 4663,
    router: ROUTER, feeContract: FEE_CONTRACT,
    fromBlock: START_BLOCK, indexedToBlock: latest,
    explorer: "https://robinhoodchain.blockscout.com",
    excludedTraders: EXCLUDE_TRADERS,
    tokens, swaps: kept,
  };
  fs.writeFileSync(path.join(OUT_DIR, "data.json"), JSON.stringify(data, null, 1));
  fs.writeFileSync(path.join(OUT_DIR, "data.js"), "window.STOA_DATA = " + JSON.stringify(data) + ";\n");

  // 4. console summary
  const priced = kept.filter((r) => r.usd !== null);
  const count = (xs) => xs.reduce((m, k) => ((m[k] = (m[k] || 0) + 1), m), {});
  console.log("\nswaps:", kept.length, "| distinct traders:", new Set(kept.map((r) => r.trader)).size);
  console.log("with a FeeNotified event:", kept.filter((r) => r.fees.length).length);
  console.log("priced:", priced.length, "| volume USD:", priced.reduce((a, r) => a + r.usd, 0).toFixed(2),
    "| USDG-priced:", kept.filter((r) => r.usdBasis === "USDG").length, "| ETH-priced:", kept.filter((r) => r.usdBasis === "ETH").length,
    "| unpriced:", kept.length - priced.length);
  console.log("venues:", count(kept.flatMap((r) => r.venues.map((v) => v.label))));
  console.log("swaps with no labelled venue:", kept.filter((r) => !r.venues.length).length);
  console.log("wrote docs/data.json and docs/data.js");
}

main().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
