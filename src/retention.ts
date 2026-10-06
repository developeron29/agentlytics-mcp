import { DAY_MS } from "./env";

// Raw events are kept for 400 days: enough for the 90-day dashboard range, its comparison period and
// year-over-year checks. Hourly rollups and spikes are kept indefinitely.
export const EVENT_RETENTION_MS = 400 * DAY_MS;
const DELETE_BATCH = 5000;

// Deletes one site's expired raw events in bounded batches; returns how many were removed.
export async function pruneEvents(db: D1Database, siteId: number, now: number, maxBatches = 20): Promise<number> {
  let removed = 0;
  for (let i = 0; i < maxBatches; i++) {
    const r = await db
      .prepare("DELETE FROM events WHERE id IN (SELECT id FROM events WHERE site_id = ? AND type IN ('pageview', 'event') AND ts < ? LIMIT ?)")
      .bind(siteId, now - EVENT_RETENTION_MS, DELETE_BATCH)
      .run();
    removed += r.meta.changes;
    if (r.meta.changes < DELETE_BATCH) break;
  }
  return removed;
}
