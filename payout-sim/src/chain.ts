// Independent, read-only check of the x402 funding transaction on Base Sepolia.
import { createPublicClient, http, parseAbiItem, decodeEventLog, getAddress, type Hex } from "viem";
import { baseSepolia } from "viem/chains";

const USDC = getAddress("0x036CbD53842c5426634e7929541eC2318f3dCF7e");
const client = createPublicClient({ chain: baseSepolia, transport: http(process.env.BASE_SEPOLIA_RPC ?? "https://sepolia.base.org") });
const TRANSFER = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");

export async function verifyFunding(tx: string, payTo: string, amountAtomic: bigint) {
  try {
    const receipt = await client.getTransactionReceipt({ hash: tx as Hex });
    if (receipt.status !== "success") return { status: "MISMATCH" as const, observed: "transaction reverted" };
    const confirmations = (await client.getBlockNumber()) - receipt.blockNumber + 1n;
    const ok = receipt.logs.some((log) => {
      if (getAddress(log.address) !== USDC) return false;
      try { const ev = decodeEventLog({ abi: [TRANSFER], data: log.data, topics: log.topics });
            return getAddress(ev.args.to) === getAddress(payTo) && ev.args.value === amountAtomic; } catch { return false; }
    });
    if (!ok) return { status: "MISMATCH" as const, observed: "no matching USDC transfer to the payout provider" };
    return { status: confirmations >= 3n ? ("MATCHED" as const) : ("PENDING_CONFIRMATION" as const),
             observed: `${amountAtomic} USDC units to ${payTo}`, confirmations: Number(confirmations) };
  } catch (e) {
    return { status: "PENDING" as const, observed: `chain unreachable: ${String(e).split("\n")[0].slice(0, 60)}` };
  }
}
