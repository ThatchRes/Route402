import "./config.js";
import { CdpX402Client } from "@coinbase/cdp-sdk/x402";
const { evmAddress } = await new CdpX402Client({ environment: "development" }).getAddresses();
console.log(`Buyer (payer) wallet on Base Sepolia: ${evmAddress}`);
