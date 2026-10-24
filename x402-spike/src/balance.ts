import "dotenv/config";
import { createPublicClient, http, erc20Abi, formatUnits, getAddress } from "viem";
import { baseSepolia } from "viem/chains";
const c = createPublicClient({ chain: baseSepolia, transport: http(process.env.BASE_SEPOLIA_RPC) });
const addr = getAddress(process.argv[2] ?? process.env.X402_PAY_TO!);
const b = await c.readContract({ address: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", abi: erc20Abi, functionName: "balanceOf", args: [addr] });
console.log(`${addr}: ${formatUnits(b, 6)} test USDC`);
