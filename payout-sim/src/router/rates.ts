// Decimal-string rate math with BigInt (12-digit scale). Never floats.
const SCALE = 10n ** 12n;
export function toScaled(r: string): bigint {
  if (!/^\d+(\.\d+)?$/.test(r)) throw new Error(`invalid rate ${r}`);
  const [i, f = ""] = r.split(".");
  return BigInt(i) * SCALE + BigInt((f + "0".repeat(12)).slice(0, 12) || "0");
}
export function fromScaled(x: bigint, dp = 10): string {
  const i = x / SCALE, f = (x % SCALE).toString().padStart(12, "0").slice(0, dp).replace(/0+$/, "");
  return f ? `${i}.${f}` : `${i}`;
}
export const mul = (a: string, b: string) => fromScaled((toScaled(a) * toScaled(b)) / SCALE);
export const div = (a: string, b: string) => fromScaled((toScaled(a) * SCALE) / toScaled(b));
/** rate * (1 - bps/10000) */
export const lessBps = (rate: string, bps: number) => fromScaled((toScaled(rate) * BigInt(10000 * 100 - Math.round(bps * 100))) / 1000000n);
