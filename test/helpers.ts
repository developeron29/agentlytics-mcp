import { env } from "cloudflare:workers";

export const db = (env as unknown as { DB: D1Database }).DB;

// Fixed clock: Wednesday 2026-09-16 12:30 UTC
export const NOW = Date.UTC(2026, 8, 16, 12, 30);
export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;

export async function resetDb() {
  await db.batch(["spikes", "annotations", "funnels", "campaigns", "rollup_hourly", "events"].map((t) => db.prepare(`DELETE FROM ${t}`)));
}

interface Hit {
  ts: number;
  path?: string;
  source?: string; // stored as referrer_host
  type?: "pageview" | "event";
  name?: string;
  visitor?: string;
  country?: string;
  browser?: string;
  os?: string;
}

let seq = 0;
export async function insertHits(siteId: number, hits: Hit[]) {
  const stmt = db.prepare(
    `INSERT INTO events (site_id, ts, type, name, path, referrer_host, visitor_hash, country, browser, os) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (let i = 0; i < hits.length; i += 50) {
    await db.batch(
      hits.slice(i, i + 50).map((h) =>
        stmt.bind(siteId, h.ts, h.type ?? "pageview", h.name ?? null, h.path ?? "/", h.source ?? null, h.visitor ?? `v${seq++}`, h.country ?? null, h.browser ?? null, h.os ?? null),
      ),
    );
  }
}

// `count` pageviews spread inside the hour starting at `hour`.
export function hourOfHits(hour: number, count: number, extra: Omit<Hit, "ts"> = {}): Hit[] {
  return Array.from({ length: count }, (_, i) => ({ ts: hour + 1000 + i, ...extra }));
}

// Steady 12 pageviews/hour from google for the last `lookback` complete hours and the same hours 1-4 weeks earlier.
export async function seedSteadyTraffic(siteId: number, now: number, lookback: number) {
  const hourNow = Math.floor(now / HOUR) * HOUR;
  for (let i = 1; i <= lookback; i++) {
    for (const weeksBack of [0, 1, 2, 3, 4]) {
      await insertHits(siteId, hourOfHits(hourNow - i * HOUR - weeksBack * 7 * DAY, 12, { source: "google.com", path: "/" }));
    }
  }
}
