// Funds the escrow's company account on Base Sepolia from the CDP faucet: test ETH (gas) and test USDC.
// Usage: npm run escrow:faucet
import "./config.js";
import { CdpClient } from "@coinbase/cdp-sdk";
const cdp = new CdpClient();
const account = await cdp.evm.getOrCreateAccount({ name: process.env.ESCROW_ACCOUNT ?? "route402-company" });
for (const token of ["eth", "usdc"] as const) {
  const { transactionHash } = await cdp.evm.requestFaucet({ address: account.address, network: "base-sepolia", token });
  console.log(`requested test ${token.toUpperCase()} for ${account.address}: https://sepolia.basescan.org/tx/${transactionHash}`);
}
