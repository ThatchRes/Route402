export type RoutingPolicy = "balanced" | "cheapest" | "fastest" | "lowest_risk";
const terms: [RoutingPolicy, RegExp][] = [
  ["balanced", /\b(?:balanced|balance (?:speed and (?:cost|savings)|(?:cost|savings) and speed)|both (?:speed and (?:cost|savings)|(?:cost|savings) and speed))\b/i],
  ["lowest_risk", /\b(?:lowest risk|lower risk|low risk|safest|safer)\b/i],
  ["cheapest", /\b(?:cheapest|cheaper|cheap|least expensive|lowest (?:cost|fees?)|lower (?:cost|fees?)|save (?:me |us )?money|prioriti[sz]e savings?)\b/i],
  ["fastest", /\b(?:fastest|faster|quickest|quicker|urgent|asap|prioriti[sz]e speed|speed matters more)\b/i],
];

/** A constrained intent parser for ordinary routing preferences; it never grants payment authority. */
export function routingPolicy(text: string): RoutingPolicy | undefined {
  if (/\b(?:not|never|avoid|don't|do not)\b/i.test(text)) return;
  return terms.find(([, pattern]) => pattern.test(text))?.[0];
}
export function isRoutingPreferenceTurn(text: string) {
  const policy = routingPolicy(text); if (!policy) return false;
  const pattern = terms.find(([p]) => p === policy)![1];
  const rest = text.toLowerCase().replace(/’/g, "'").replace(pattern, " ").replace(/[,.!?;:]/g, " ").trim();
  // Restrict standalone preference turns to conversational filler. Questions about a policy and
  // unrelated uses of "cheapest" cannot silently edit an existing payment.
  return !rest || rest.split(/\s+/).every((word) => /^(?:i|we|i'd|we'd|would|rather|like|prefer|want|please|use|go|with|the|one|option|route|instead|actually|can|could|you|do|to|choose|pick|for|this|payment|transfer|it|that|make|a|an|let's|what|how|about|as|possible)$/.test(word));
}
export function resolveRoutingPolicy(text: string, previous?: string): RoutingPolicy {
  return routingPolicy(text) ?? (terms.some(([p]) => p === previous) ? previous as RoutingPolicy : "balanced");
}
export const routingObjective = (policy?: string): "balanced" | "cheapest" | "fastest" =>
  policy === "fastest" ? "fastest" : policy === "cheapest" || policy === "lowest_risk" ? "cheapest" : "balanced";
