import "./config.js";
import { CdpClient } from "@coinbase/cdp-sdk";
import { CdpX402Client } from "@coinbase/cdp-sdk/x402";
const { evmAddress } = await new CdpX402Client({ environment: "development" }).getAddresses();
const { transactionHash } = await new CdpClient().evm.requestFaucet({ address: evmAddress, network: "base-sepolia", token: "usdc" });
console.log(`Requested test USDC for ${evmAddress}: https://sepolia.basescan.org/tx/${transactionHash}`);
