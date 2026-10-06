import { HOUR_MS, SITE_ID } from "./env";

export const SOURCE_SQL = "COALESCE(utm_source, referrer_host, '(direct)')";
// Only the OS is stored, so iPads count as Mobile (their user agent says iOS).
export const DEVICE_SQL = "CASE WHEN os IS NULL THEN 'Unknown' WHEN os IN ('iOS', 'Android') THEN 'Mobile' ELSE 'Desktop' END";

const floorHour = (ms: number) => Math.floor(ms / HOUR_MS) * HOUR_MS;

// Rebuilds hourly aggregates for [fromMs, toMs). Idempotent, so the cron can safely recompute a trailing window.
// Rows whose numbers didn't change aren't rewritten: D1 bills every written row, and most of the window is unchanged.
export async function rollup(db: D1Database, fromMs: number, toMs: number): Promise<void> {
  const from = floorHour(fromMs);
  const to = floorHour(toMs) + HOUR_MS;
  const select = (metric: string, dim: string, where: string) =>
    db
      .prepare(
        `INSERT INTO rollup_hourly (site_id, hour, metric, dim, value, visitors)
         SELECT site_id, (ts / ${HOUR_MS}) * ${HOUR_MS} AS hour, '${metric}', ${dim}, COUNT(*), COUNT(DISTINCT visitor_hash)
         FROM events WHERE site_id = ${SITE_ID} AND ${where} AND ts >= ? AND ts < ?
         GROUP BY site_id, hour, ${dim}
         ON CONFLICT (site_id, hour, metric, dim) DO UPDATE SET value = excluded.value, visitors = excluded.visitors
         WHERE value != excluded.value OR visitors != excluded.visitors`,
      )
      .bind(from, to);
  await db.batch([
    select("total", "''", "type = 'pageview'"),
    select("source", SOURCE_SQL, "type = 'pageview'"),
    select("page", "path", "type = 'pageview'"),
    select("event", "name", "type = 'event'"),
  ]);
}
