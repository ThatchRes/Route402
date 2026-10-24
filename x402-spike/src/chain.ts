// Read-only Base Sepolia checks: the settlement must be a real USDC Transfer to the approved receiver.
import { createPublicClient, http, parseAbiItem, decodeEventLog, getAddress, type Hex } from "viem";
import { baseSepolia } from "viem/chains";
import { RPC, USDC } from "./config.js";

export const client = createPublicClient({ chain: baseSepolia, transport: http(RPC) });
export const TRANSFER = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");

export async function verifyTransfer(tx: Hex, expect: { payTo: string; amountAtomic: bigint; payer?: string }) {
  const receipt = await client.getTransactionReceipt({ hash: tx });
  if (receipt.status !== "success") return { ok: false as const, reason: "transaction reverted" };
  const head = await client.getBlockNumber();
  const confirmations = head - receipt.blockNumber + 1n;
  const match = receipt.logs.find((log) => {
    if (getAddress(log.address) !== USDC) return false;
    try {
      const ev = decodeEventLog({ abi: [TRANSFER], data: log.data, topics: log.topics });
      return getAddress(ev.args.to) === getAddress(expect.payTo) && ev.args.value === expect.amountAtomic
        && (!expect.payer || getAddress(ev.args.from) === getAddress(expect.payer));
    } catch { return false; }
  });
  if (!match) return { ok: false as const, reason: "no matching USDC transfer (token/receiver/amount/payer mismatch)" };
  return { ok: true as const, confirmations, blockNumber: receipt.blockNumber };
}
