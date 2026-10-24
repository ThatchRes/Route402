import type { Request, Response, NextFunction } from "express";

export function browserSecurity(req: Request, res: Response, next: NextFunction) {
  if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress ?? "")) return res.status(403).json({ error: "local only" });
  const host = req.get("host"), port = req.socket.localPort;
  if (!["localhost", "127.0.0.1", "[::1]"].some((h) => host === `${h}:${port}`)) return res.status(403).json({ error: "invalid local host" });
  res.set({ "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY", "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'" });
  const origin = req.get("origin");
  if ((origin && origin !== `${req.protocol}://${host}`) || req.get("sec-fetch-site") === "cross-site" || req.get("sec-fetch-site") === "same-site")
    return res.status(403).json({ error: "cross-origin requests are not allowed" });
  if (req.path.startsWith("/ui") || req.baseUrl === "/ui") {
    res.set("Cache-Control", "no-store");
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method) && !req.is("application/json")) return res.status(415).json({ error: "application/json is required" });
  }
  next();
}

export function browserRateLimit(limit: number) {
  const hits = new Map<string, { start: number; count: number }>();
  return (req: Request, res: Response, next: NextFunction) => {
    const key = req.socket.remoteAddress ?? "local", now = Date.now(), row = hits.get(key);
    const current = row && now - row.start < 60_000 ? row : { start: now, count: 0 };
    hits.set(key, current);
    if (++current.count > limit) { res.set("Retry-After", "60"); return res.status(429).json({ error: "Too many requests; try again in a minute" }); }
    next();
  };
}
