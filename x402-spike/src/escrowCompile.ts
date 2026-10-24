// Compiles contracts/*.sol with solc-js and writes contracts/artifacts.json (ABI + bytecode).
// The artifact is committed, so running the escrow does not need a compiler. Usage: npm run escrow:compile
import { readFileSync, writeFileSync } from "node:fs";
import solc from "solc";

const files = ["Route402Escrow.sol", "TestUSDC.sol"];
const input = {
  language: "Solidity",
  sources: Object.fromEntries(files.map((f) => [f, { content: readFileSync(`contracts/${f}`, "utf8") }])),
  settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: "paris", outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } } },
};
const out = JSON.parse(solc.compile(JSON.stringify(input)));
const errors = (out.errors ?? []).filter((e: any) => e.severity === "error");
if (errors.length) { console.error(errors.map((e: any) => e.formattedMessage).join("\n")); process.exit(1); }
const art: Record<string, { abi: unknown; bytecode: string }> = {};
for (const f of files) for (const [name, c] of Object.entries<any>(out.contracts[f])) art[name] = { abi: c.abi, bytecode: `0x${c.evm.bytecode.object}` };
writeFileSync("contracts/artifacts.json", JSON.stringify({ compiler: solc.version(), ...art }, null, 2));
console.log(`compiled ${Object.keys(art).join(", ")} with solc ${solc.version()}`);
