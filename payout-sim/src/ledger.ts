// Append-only double-entry ledger. Every entry balances PER ASSET (USD, USDC and CAD never mix).
// Conversions are two linked balanced legs, one in each asset, referencing the rate and quote.
export interface Line { asset: string; account: string; amountMinor: string }   // +credit to account / -debit
export interface Entry {
  entryId: string; transferId: string; ledger: "scenario" | "testnet"; kind: string;
  lines: Line[]; refs: Record<string, string>; provenance: "simulated" | "testnet"; at: string;
}

export function assertBalanced(lines: Line[]) {
  const sums = new Map<string, bigint>();
  for (const l of lines) sums.set(l.asset, (sums.get(l.asset) ?? 0n) + BigInt(l.amountMinor));
  for (const [asset, s] of sums) if (s !== 0n) throw new Error(`unbalanced entry: ${asset} sums to ${s}`);
}

export function line(asset: string, account: string, amount: bigint): Line {
  return { asset, account, amountMinor: amount.toString() };
}

/** Balance of an account in one asset, from the full entry history. */
export function balance(entries: Entry[], account: string, asset: string, ledger = "scenario"): bigint {
  return entries.filter((e) => e.ledger === ledger)
    .flatMap((e) => e.lines).filter((l) => l.account === account && l.asset === asset)
    .reduce((s, l) => s + BigInt(l.amountMinor), 0n);
}
