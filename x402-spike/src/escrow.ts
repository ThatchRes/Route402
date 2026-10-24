// Release-on-delivery escrow service (testnet). The router calls it when an approved stablecoin payment carries a
// delivery condition: lock at approval, release when receiving confirms delivery, refund after the deadline.
//   ESCROW_CHAIN=base-sepolia : Route402Escrow on Base Sepolia, Circle test USDC, signed by a CDP server account.
//   ESCROW_CHAIN=local        : an in-process test chain (ganache) with a local test token. Clearly labelled "local
//                               test chain"; used for offline demos and tests. Nothing here touches real money.
// The amount locked is a representative 0.01 test USDC per payment (capped), like the x402 settlement proof; the full
// invoice amount stays simulated. Usage: npm run escrow
import "dotenv/config";
import express from "express";
import { createHash, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createPublicClient, createWalletClient, custom, encodeFunctionData, getAddress, http, keccak256, parseUnits,
  serializeTransaction, toHex, type Address, type Hex } from "viem";
import { baseSepolia } from "viem/chains";
import { INTERNAL_TOKEN, RPC, USDC } from "./config.js";

const ART = JSON.parse(readFileSync(new URL("../contracts/artifacts.json", import.meta.url), "utf8"));
const MODE = (process.env.ESCROW_CHAIN ?? "local") as "local" | "base-sepolia";
const PORT = Number(process.env.ESCROW_PORT ?? 8416);
const LOCK_USDC = process.env.ESCROW_LOCK_USDC ?? "0.01";
if (Number(LOCK_USDC) > 0.05) throw new Error("ESCROW_LOCK_USDC above 0.05 is refused in demo mode");
const FILE = "data/escrow.json";
const ERC20 = [
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "s", type: "address" }, { name: "a", type: "uint256" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "o", type: "address" }], outputs: [{ type: "uint256" }] },
] as const;
const ESCROW = ART.Route402Escrow.abi;

// Simulate first, so a refused action returns the contract's reason (e.g. "before deadline") instead of a bare revert.
async function preflight(pub: any, account: Address, to: Address, data: Hex) {
  try { await pub.call({ account, to, data }); }
  catch (e: any) {
    const m = String(e?.cause?.reason ?? e?.details ?? e?.shortMessage ?? e?.message ?? e);
    const reason = m.match(/reverted(?: with reason string)?:?\s*'?([^'\n]+)'?/i)?.[1] ?? m.match(/revert ([^\n]+)/i)?.[1] ?? m;
    throw new Error(`refused by the escrow contract: ${reason.trim().slice(0, 160)}`);
  }
}

interface Chain { label: string; explorer: (tx: string) => string | null; payer: Address; escrow: Address | null; usdc: Address;
  public: any; send: (to: Address | null, data: Hex) => Promise<{ hash: Hex; contract?: Address }>; advance?: (s: number) => Promise<void> }

async function localChain(): Promise<Chain> {
  const ganache = (await import("ganache")).default;
  const provider: any = ganache.provider({ wallet: { totalAccounts: 2, deterministic: true }, chain: { chainId: 1337 }, miner: { defaultTransactionGasLimit: "estimate" }, logging: { quiet: true } });
  const [payer] = (await provider.request({ method: "eth_accounts", params: [] })).map((a: string) => getAddress(a));
  const pub = createPublicClient({ transport: custom(provider) });
  const wallet = createWalletClient({ account: payer, transport: custom(provider) });
  const send = async (to: Address | null, data: Hex) => {
    await provider.request({ method: "evm_mine", params: [] });   // a local chain only mines on demand: bring its clock to now
    if (to) await preflight(pub, payer, to, data);
    const hash = await wallet.sendTransaction({ account: payer, chain: null, to: to ?? undefined, data } as any);
    const r = await pub.waitForTransactionReceipt({ hash });
    if (r.status !== "success") throw new Error(`transaction reverted (${hash})`);
    return { hash, contract: r.contractAddress ? getAddress(r.contractAddress) : undefined };
  };
  const usdc = (await send(null, ART.TestUSDC.bytecode)).contract!;
  await send(usdc, encodeFunctionData({ abi: ART.TestUSDC.abi, functionName: "mint", args: [payer, parseUnits("100", 6)] }));
  const escrow = (await send(null, (ART.Route402Escrow.bytecode + usdc.slice(2).toLowerCase().padStart(64, "0")) as Hex)).contract!;
  return { label: "local test chain (ganache)", explorer: () => null, payer, escrow, usdc, public: pub, send,
    advance: async (s) => { await provider.request({ method: "evm_increaseTime", params: [s] }); await provider.request({ method: "evm_mine", params: [] }); } };
}

async function baseSepoliaChain(): Promise<Chain> {
  const { CdpClient } = await import("@coinbase/cdp-sdk");
  const cdp = new CdpClient();
  const account = await cdp.evm.getOrCreateAccount({ name: process.env.ESCROW_ACCOUNT ?? "route402-company" });
  const payer = getAddress(account.address);
  const pub = createPublicClient({ chain: baseSepolia, transport: http(RPC) });
  const saved = existsSync(FILE) ? JSON.parse(readFileSync(FILE, "utf8")) : {};
  const escrow = process.env.ESCROW_CONTRACT ? getAddress(process.env.ESCROW_CONTRACT) : saved.contract ? getAddress(saved.contract) : null;
  const send = async (to: Address | null, data: Hex) => {
    if (to) await preflight(pub, payer, to, data);
    let transaction: any;
    if (to) transaction = { to, data };
    else {   // contract creation: a serialized transaction without `to`
      const [nonce, fees, gas] = await Promise.all([pub.getTransactionCount({ address: payer }), pub.estimateFeesPerGas(), pub.estimateGas({ account: payer, data })]);
      transaction = serializeTransaction({ chainId: baseSepolia.id, type: "eip1559", nonce, data, gas: (gas * 12n) / 10n, maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas });
    }
    const { transactionHash: hash } = await cdp.evm.sendTransaction({ address: payer, transaction, network: "base-sepolia" });
    const r = await pub.waitForTransactionReceipt({ hash, timeout: 120_000 });
    if (r.status !== "success") throw new Error(`transaction reverted (${hash})`);
    return { hash, contract: r.contractAddress ? getAddress(r.contractAddress) : undefined };
  };
  return { label: "Base Sepolia testnet", explorer: (tx) => `https://sepolia.basescan.org/tx/${tx}`, payer, escrow, usdc: USDC, public: pub, send };
}

const chain = MODE === "base-sepolia" ? await baseSepoliaChain() : await localChain();

// Deploy mode: npm run escrow -- --deploy   (Base Sepolia; prints the address and saves it to data/escrow.json)
if (process.argv.includes("--deploy")) {
  if (MODE !== "base-sepolia") { console.log("local mode deploys automatically at startup"); process.exit(0); }
  const r = await chain.send(null, (ART.Route402Escrow.bytecode + USDC.slice(2).toLowerCase().padStart(64, "0")) as Hex);
  mkdirSync("data", { recursive: true }); writeFileSync(FILE, JSON.stringify({ contract: r.contract, tx: r.hash, at: new Date().toISOString() }, null, 2));
  console.log(`Route402Escrow deployed at ${r.contract}\n  tx ${chain.explorer(r.hash)}\n  saved to ${FILE}`);
  process.exit(0);
}

const idOf = (requestId: string) => keccak256(toHex(`route402:${requestId}`));
const sha = (s: string) => `0x${createHash("sha256").update(s).digest("hex")}` as Hex;
const atomic = parseUnits(LOCK_USDC, 6);
const STATES = ["None", "Locked", "Released", "Refunded"];

async function readLock(requestId: string) {
  const l: any = await chain.public.readContract({ address: chain.escrow!, abi: ESCROW, functionName: "locks", args: [idOf(requestId)] });
  return { payer: l[0], payee: l[1], releaser: l[2], amountUsdc: Number(l[3]) / 1e6, deadline: new Date(Number(l[4]) * 1000).toISOString(), state: STATES[Number(l[5])], conditionHash: l[6] };
}

const app = express();
app.use(express.json({ limit: "32kb" }));
app.use((req, res, next) => {   // internal service: router only
  const want = Buffer.from(`Bearer ${INTERNAL_TOKEN()}`), got = Buffer.from(req.headers.authorization ?? "");
  if (want.length !== got.length || !timingSafeEqual(want, got)) return res.status(401).json({ error: "unauthorized" });
  next();
});
const fail = (res: express.Response, e: any) => res.status(502).json({ error: String(e?.shortMessage ?? e?.message ?? e).slice(0, 300) });

app.get("/escrow/status", async (_req, res) => {
  try {
    const bal = await chain.public.readContract({ address: chain.usdc, abi: ERC20, functionName: "balanceOf", args: [chain.payer] });
    res.json({ chain: chain.label, mode: MODE, contract: chain.escrow, token: chain.usdc, payer: chain.payer, payerUsdc: Number(bal) / 1e6, lockUsdc: LOCK_USDC,
      ready: !!chain.escrow, note: chain.escrow ? undefined : "no escrow contract: run npm run escrow -- --deploy" });
  } catch (e) { fail(res, e); }
});

// Lock: approve the escrow for the amount, then lock it for the supplier until the deadline.
app.post("/escrow/lock", async (req, res) => {
  try {
    if (!chain.escrow) return res.status(503).json({ error: "no escrow contract: run npm run escrow -- --deploy" });
    const { requestId, payee, deadlineUtc, condition } = req.body ?? {};
    if (!requestId || !payee || !deadlineUtc) return res.status(400).json({ error: "requestId, payee, deadlineUtc required" });
    const deadline = BigInt(Math.floor(Date.parse(deadlineUtc) / 1000));
    const approve = await chain.send(chain.usdc, encodeFunctionData({ abi: ERC20, functionName: "approve", args: [chain.escrow, atomic] }));
    const lock = await chain.send(chain.escrow, encodeFunctionData({ abi: ESCROW, functionName: "lock",
      args: [idOf(requestId), getAddress(payee), chain.payer, atomic, deadline, sha(JSON.stringify(condition ?? {}))] }));
    res.json({ chain: chain.label, contract: chain.escrow, lockId: idOf(requestId), amountUsdc: Number(LOCK_USDC), approveTx: approve.hash, lockTx: lock.hash,
      explorer: chain.explorer(lock.hash), onChain: await readLock(requestId) });
  } catch (e) { fail(res, e); }
});

app.post("/escrow/release", async (req, res) => {
  try {
    const { requestId, evidence } = req.body ?? {};
    const r = await chain.send(chain.escrow!, encodeFunctionData({ abi: ESCROW, functionName: "release", args: [idOf(requestId), sha(String(evidence ?? ""))] }));
    res.json({ releaseTx: r.hash, explorer: chain.explorer(r.hash), onChain: await readLock(requestId) });
  } catch (e) { fail(res, e); }
});

app.post("/escrow/refund", async (req, res) => {
  try {
    const r = await chain.send(chain.escrow!, encodeFunctionData({ abi: ESCROW, functionName: "refund", args: [idOf(req.body?.requestId)] }));
    res.json({ refundTx: r.hash, explorer: chain.explorer(r.hash), onChain: await readLock(req.body.requestId) });
  } catch (e) { fail(res, e); }
});

app.get("/escrow/:requestId", async (req, res) => { try { res.json(await readLock(String(req.params.requestId))); } catch (e) { fail(res, e); } });

// Local test chain only: move time forward (to show a refund after the deadline)
app.post("/escrow/_advance", async (req, res) => {
  if (!chain.advance) return res.status(404).json({ error: "only on the local test chain" });
  await chain.advance(Number(req.body?.seconds ?? 0)); res.json({ ok: true });
});

app.listen(PORT, "127.0.0.1", () => console.log(`escrow on :${PORT} (${chain.label}; contract ${chain.escrow ?? "not deployed"}; payer ${chain.payer})`));
