import type { Priced } from "./optimizer.js";

export interface ScoredPlan {
  children: Priced[]; moneyCostMinor: bigint; timeCostMinor: bigint; scoreMinor: bigint;
  feeMinor: bigint; savingsMinor: bigint; arrivalUtc: string;
}
type Objective = "balanced" | "cheapest" | "fastest";
const cmp = (a: bigint, b: bigint) => a < b ? -1 : a > b ? 1 : 0;
export function comparePlans(a: ScoredPlan, b: ScoredPlan, objective: Objective) {
  const money = cmp(a.moneyCostMinor, b.moneyCostMinor), arrival = a.arrivalUtc.localeCompare(b.arrivalUtc);
  return (objective === "fastest" ? arrival || money : objective === "cheapest" ? money || arrival : cmp(a.scoreMinor, b.scoreMinor) || arrival || money)
    || a.children.length - b.children.length;
}

/** Search every available route, retaining exact capacity boundaries as well as interior split samples.
 * The supported plan size remains three legs. This is a bounded search, not a global optimality certificate.
 */
export function searchAllocations(o: {
  routeIds: string[]; total: bigint; allowSplit: boolean;
  price: (routeId: string, amount: bigint) => Priced;
  feasible: (children: Priced[], complete: boolean) => boolean;
  score: (children: Priced[]) => ScoredPlan;
}) {
  const objectives: Objective[] = ["balanced", "cheapest", "fastest"];
  const best: Partial<Record<Objective, ScoredPlan>> = {}, singles: Partial<Record<Objective, ScoredPlan>> = {};
  const seen = new Set<string>(); let evaluated = 0;
  const consider = (kids: Priced[]) => {
    const key = kids.map((k) => `${k.routeId}=${k.amount}`).sort().join("|");
    if (seen.has(key)) return false; seen.add(key); evaluated++;
    if (!o.feasible(kids, true)) return false;
    const plan = o.score(kids);
    for (const objective of objectives) {
      if (!best[objective] || comparePlans(plan, best[objective]!, objective) < 0) best[objective] = plan;
      if (kids.length === 1 && (!singles[objective] || comparePlans(plan, singles[objective]!, objective) < 0)) singles[objective] = plan;
    }
    return true;
  };
  for (const id of o.routeIds) consider([o.price(id, o.total)]);
  // A quote may be invalid below its fixed fees. Such amounts are below the upper capacity bound,
  // and are still rejected by the final feasibility check.
  const maxFor = (id: string, upper: bigint, prefix: Priced[]) => {
    let low = 0n, high = upper;
    while (low < high) {
      const mid = (low + high + 1n) / 2n, kid = o.price(id, mid);
      if ((!kid.quote && kid.reason?.includes("fees exceed")) || o.feasible([...prefix, kid], false)) low = mid;
      else high = mid - 1n;
    }
    return low;
  };
  const pair = (a: string, b: string, total: bigint, prefix: Priced[]) => {
    if (total < 2n) return;
    const capA = maxFor(a, total - 1n, prefix), capB = maxFor(b, total - 1n, prefix);
    const low = total - capB > 1n ? total - capB : 1n, high = capA < total ? capA : total - 1n;
    if (low > high) return;
    const at = (amount: bigint) => [...prefix, o.price(a, amount), o.price(b, total - amount)];
    const seeds = new Set<bigint>([low, high]);
    for (let i = 1n; i < 10n; i++) { const n = total * i / 10n; if (n >= low && n <= high) seeds.add(n); }
    const feasible: bigint[] = [];
    for (const n of seeds) {
      const kids = at(n); if (o.feasible(kids, true)) feasible.push(n); consider(kids);
    }
    // Mixed duration/issuer constraints can bind inside the nominal interval. Locate that boundary
    // to a single minor unit instead of leaving a 10% gap of unused cheap liquidity.
    if (feasible.length) {
      const sorted = feasible.sort((x, y) => cmp(x, y));
      for (const [target, seed] of [[low, sorted[0]], [high, sorted.at(-1)!]]) {
        let good = seed, bad = target;
        while (good > bad ? good - bad > 1n : bad - good > 1n) {
          const n = (good + bad) / 2n;
          if (o.feasible(at(n), true)) good = n; else bad = n;
        }
        consider(at(good)); consider(at(target));
      }
    }
  };
  if (o.allowSplit) {
    for (let i = 0; i < o.routeIds.length; i++) for (let j = i + 1; j < o.routeIds.length; j++) pair(o.routeIds[i], o.routeIds[j], o.total, []);
    for (let i = 0; i < o.routeIds.length; i++) {
      const first = o.routeIds[i], cap = maxFor(first, o.total - 2n, []);
      const seeds = new Set([cap, o.total / 3n, o.total / 5n, o.total * 2n / 5n, o.total * 3n / 5n]);
      for (const amount of seeds) {
        if (amount <= 0n || amount >= o.total - 1n) continue;
        const prefix = [o.price(first, amount)]; if (!o.feasible(prefix, false)) continue;
        for (let j = 0; j < o.routeIds.length; j++) for (let k = j + 1; k < o.routeIds.length; k++)
          if (j !== i && k !== i) pair(o.routeIds[j], o.routeIds[k], o.total - amount, prefix);
      }
    }
  }
  return { best, singles, evaluated };
}
