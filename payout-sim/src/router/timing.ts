// One clock for calculator, quote providers and dispatcher. A frozen clock is explicit and only for demos/tests.
export function planningNow(): string {
  const value = process.env.DEMO_NOW_UTC ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(value))) throw new Error("DEMO_NOW_UTC must be a valid timestamp");
  return new Date(value).toISOString();
}

export function latestStart(arrival: (start: Date) => Date, now: Date, deadline: Date, bufferMinutes = 0): string | null {
  const fits = (start: number) => arrival(new Date(start)).getTime() + bufferMinutes * 60_000 <= deadline.getTime();
  if (!fits(now.getTime())) return null;
  let low = now.getTime(), high = deadline.getTime();
  while (high - low > 1000) { const middle = Math.floor((low + high) / 2); if (fits(middle)) low = middle; else high = middle; }
  return new Date(low).toISOString();
}
