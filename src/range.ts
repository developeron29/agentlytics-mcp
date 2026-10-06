import { DAY_MS, HOUR_MS } from "./env";

// "24h" | "7d" | "30d" -> window ending now
export function parseRange(range: unknown, now: number, fallback = "7d"): { from: number; to: number } {
  const m = /^(\d{1,3})([hd])$/.exec(typeof range === "string" ? range : fallback) ?? /^(\d+)([hd])$/.exec(fallback)!;
  const span = Number(m[1]) * (m[2] === "h" ? HOUR_MS : DAY_MS);
  return { from: now - Math.min(span, 90 * DAY_MS), to: now };
}
