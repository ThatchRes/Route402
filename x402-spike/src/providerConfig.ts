// The quote providers the routing agent buys from: OUR stablecoin rail and the company's OWN bank. No third-party rails.
// Each has its own named CDP wallet, so each is a separate payee.
// The wallet derives these addresses itself (same names), so it never trusts an address a provider reports.
import "./config.js";
import { CdpClient } from "@coinbase/cdp-sdk";
import { getAddress } from "viem";

export const PROVIDERS = [
  { id: "stablecoin", label: "Our stablecoin rail", port: Number(process.env.PROVIDER_STABLECOIN_PORT ?? 8411), account: "provider-stablecoin-rail" },
  { id: "bank", label: "Your bank (via bank connection)", port: Number(process.env.PROVIDER_BANK_PORT ?? 8413), account: "provider-bank-partner" },
] as const;
export type ProviderId = (typeof PROVIDERS)[number]["id"];
export const providerUrl = (id: string) => `http://localhost:${PROVIDERS.find((p) => p.id === id)!.port}/v1/quote`;

export async function providerAddresses(): Promise<Record<string, `0x${string}`>> {
  const cdp = new CdpClient();
  const out: Record<string, `0x${string}`> = {};
  for (const p of PROVIDERS) out[p.id] = getAddress((await cdp.evm.getOrCreateAccount({ name: p.account })).address);
  return out;
}
