import "dotenv/config";
import { parseUnits, getAddress } from "viem";

// Testnet only. There is deliberately no mainnet option in this spike.
export const NETWORK = "eip155:84532" as const;                       // Base Sepolia
export const USDC = getAddress("0x036CbD53842c5426634e7929541eC2318f3dCF7e"); // Base Sepolia USDC
export const USDC_DECIMALS = 6;
export const EXPLORER = "https://sepolia.basescan.org/tx/";

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing ${name} in .env`);
  return v;
}

export const PER_PAYMENT_USDC = process.env.PER_PAYMENT_USDC ?? "0.01";
export const PER_PAYMENT_ATOMIC = parseUnits(PER_PAYMENT_USDC, USDC_DECIMALS);           // 10000n for 0.01
export const TOTAL_CAP_ATOMIC = parseUnits(process.env.TOTAL_SPEND_CAP_USDC ?? "0.25", USDC_DECIMALS);
export const REQUIRED_CONFIRMATIONS = BigInt(process.env.REQUIRED_CONFIRMATIONS ?? "3");
export const SELLER_URL = process.env.SELLER_URL ?? "http://localhost:8402";
export const RPC = process.env.BASE_SEPOLIA_RPC ?? "https://sepolia.base.org";
export const INTERNAL_TOKEN = () => req("X402_INTERNAL_TOKEN");
export const PAY_TO = () => getAddress(req("X402_PAY_TO"));

if (PER_PAYMENT_ATOMIC > parseUnits("0.05", USDC_DECIMALS)) {
  throw new Error("PER_PAYMENT_USDC above 0.05 is refused in demo mode");
}
if (TOTAL_CAP_ATOMIC > parseUnits("1", USDC_DECIMALS)) throw new Error("TOTAL_SPEND_CAP_USDC above 1 is refused in demo mode");

// ---- Pay-per-call services (x402 used as designed: an agent pays a small price per API request) ----
export const CALL_PRICE_USDC = process.env.CALL_PRICE_USDC ?? "0.001";
export const CALL_PRICE_ATOMIC = parseUnits(CALL_PRICE_USDC, USDC_DECIMALS);           // 1000n for 0.001
export const CALL_CAP_ATOMIC = parseUnits(process.env.AGENT_CALL_CAP_USDC ?? "0.25", USDC_DECIMALS);
export const WALLET_PORT = Number(process.env.AGENT_WALLET_PORT ?? 8405);
export const ROUTER_URL = process.env.ROUTER_URL ?? "http://localhost:8404";
export const ROUTER_TOKEN = () => req("ROUTER_TOKEN");
if (CALL_PRICE_ATOMIC > parseUnits("0.01", USDC_DECIMALS)) throw new Error("CALL_PRICE_USDC above 0.01 is refused in demo mode");
if (CALL_CAP_ATOMIC > parseUnits("0.5", USDC_DECIMALS)) throw new Error("AGENT_CALL_CAP_USDC above 0.5 is refused in demo mode");
