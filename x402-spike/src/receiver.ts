import "dotenv/config";
import { CdpClient } from "@coinbase/cdp-sdk";
const a = await new CdpClient().evm.getOrCreateAccount({ name: "x402-receiver" });
console.log(`Receiver wallet (put this in .env as X402_PAY_TO): ${a.address}`);
