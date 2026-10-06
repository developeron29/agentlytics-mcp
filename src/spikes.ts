import { DAY_MS, HOUR_MS } from "./env";
import type { Window } from "./queries";

const WEEK_MS = 7 * DAY_MS;
const Z_THRESHOLD = 4;
const MIN_LIFT = 10; // absolute pageviews/hour above baseline, so tiny sites don't produce noise

export interface Cause {
  kind: "source" | "page" | "event";
  name: string;
  lift: number; // extra pageviews (or event count) over baseline during the spike
  lift_pct: number | null; // null when the baseline was zero (brand-new source/page/event)
  share_of_spike: number; // 0..1, fraction of the spike's excess traffic this explains
}

export interface Annotation {
  ts: number;
  kind: string;
  label: string;
}

export interface SpikeRow {
  id: number;
  start_ts: number;
  end_ts: number;
  magnitude: number;
  causes: Cause[];
  annotations: Annotation[];
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

// Same hour-of-week over the previous 4 weeks; for young sites, same hour-of-day over the previous 7 days.
function baselineOffsets(hour: number, siteStart: number): number[] {
  const weeks = [1, 2, 3, 4].map((k) => k * WEEK_MS).filter((o) => hour - o >= siteStart);
  if (weeks.length >= 2) return weeks;
  return [1, 2, 3, 4, 5, 6, 7].map((k) => k * DAY_MS).filter((o) => hour - o >= siteStart);
}

interface Window2 extends Window {
  excess: number;
  offsets: number[];
}

export async function detectSpikes(db: D1Database, siteId: number, siteStart: number, now: number, lookbackHours = 72) {
  const end = Math.floor(now / HOUR_MS) * HOUR_MS; // only complete hours
  const start = end - lookbackHours * HOUR_MS;
  const { results } = await db
    .prepare("SELECT hour, value FROM rollup_hourly WHERE site_id = ? AND metric = 'total' AND hour >= ? AND hour < ?")
    .bind(siteId, start - 4 * WEEK_MS, end)
    .all<{ hour: number; value: number }>();
  const series = new Map(results.map((r) => [r.hour, r.value]));

  const windows: Window2[] = [];
  for (let h = start; h < end; h += HOUR_MS) {
    const offsets = baselineOffsets(h, siteStart);
    if (offsets.length < 2) continue;
    const base = offsets.map((o) => series.get(h - o) ?? 0);
    const m = median(base);
    const mad = median(base.map((v) => Math.abs(v - m)));
    const scale = Math.max(1.4826 * mad, Math.sqrt(m) + 1);
    const x = series.get(h) ?? 0;
    if ((x - m) / scale < Z_THRESHOLD || x - m < Math.max(MIN_LIFT, 0.5 * m)) continue;
    const last = windows[windows.length - 1];
    if (last && last.to === h) {
      last.to = h + HOUR_MS;
      last.excess += x - m;
    } else {
      windows.push({ from: h, to: h + HOUR_MS, excess: x - m, offsets });
    }
  }

  const keep: number[] = [];
  for (const w of windows) {
    const { causes, annotations } = await attribute(db, siteId, w);
    keep.push(w.from);
    await db
      .prepare(
        `INSERT INTO spikes (site_id, start_ts, end_ts, magnitude, top_causes_json) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(site_id, start_ts) DO UPDATE SET end_ts = excluded.end_ts, magnitude = excluded.magnitude, top_causes_json = excluded.top_causes_json`,
      )
      .bind(siteId, w.from, w.to, w.excess, JSON.stringify({ causes, annotations }))
      .run();
  }
  // Drop spikes in the lookback range that no longer qualify.
  const stale = await db
    .prepare("SELECT start_ts FROM spikes WHERE site_id = ? AND start_ts >= ? AND start_ts < ?")
    .bind(siteId, start, end)
    .all<{ start_ts: number }>();
  for (const s of stale.results) {
    if (!keep.includes(s.start_ts)) await db.prepare("DELETE FROM spikes WHERE site_id = ? AND start_ts = ?").bind(siteId, s.start_ts).run();
  }
  return windows.length;
}

async function dimTotals(db: D1Database, siteId: number, from: number, to: number) {
  const { results } = await db
    .prepare(
      `SELECT metric, dim, SUM(value) AS value FROM rollup_hourly
       WHERE site_id = ? AND metric IN ('source', 'page', 'event') AND hour >= ? AND hour < ? GROUP BY metric, dim`,
    )
    .bind(siteId, from, to)
    .all<{ metric: Cause["kind"]; dim: string; value: number }>();
  return new Map(results.map((r) => [`${r.metric}\u0000${r.dim}`, r.value]));
}

async function attribute(db: D1Database, siteId: number, w: Window2) {
  const during = await dimTotals(db, siteId, w.from, w.to);
  const before = await Promise.all(w.offsets.map((o) => dimTotals(db, siteId, w.from - o, w.to - o)));

  const causes: Cause[] = [];
  for (const [key, value] of during) {
    const base = median(before.map((m) => m.get(key) ?? 0));
    const lift = value - base;
    if (lift < 3 || lift < 0.05 * w.excess) continue;
    const [kind, name] = key.split("\u0000") as [Cause["kind"], string];
    causes.push({
      kind,
      name,
      lift: Math.round(lift),
      lift_pct: base > 0 ? Math.round((lift / base) * 100) : null,
      share_of_spike: Math.min(1, Math.round((lift / w.excess) * 100) / 100),
    });
  }
  const perKind = (k: Cause["kind"]) => causes.filter((c) => c.kind === k).sort((a, b) => b.lift - a.lift).slice(0, 5);
  const top = [...perKind("source"), ...perKind("page"), ...perKind("event")].sort((a, b) => b.share_of_spike - a.share_of_spike);

  const ann = await db
    .prepare("SELECT ts, kind, label FROM annotations WHERE site_id = ? AND ts >= ? AND ts < ? ORDER BY ts")
    .bind(siteId, w.from - DAY_MS, w.to)
    .all<Annotation>();
  return { causes: top, annotations: ann.results };
}

type Stored = { id: number; start_ts: number; end_ts: number; magnitude: number; top_causes_json: string };

function toSpike(r: Stored): SpikeRow {
  const parsed = JSON.parse(r.top_causes_json) as { causes: Cause[]; annotations: Annotation[] };
  return { id: r.id, start_ts: r.start_ts, end_ts: r.end_ts, magnitude: Math.round(r.magnitude), ...parsed };
}

export async function listSpikes(db: D1Database, siteId: number, w: Window, limit = 10): Promise<SpikeRow[]> {
  const { results } = await db
    .prepare(
      `SELECT id, start_ts, end_ts, magnitude, top_causes_json FROM spikes
       WHERE site_id = ? AND start_ts >= ? AND start_ts < ? ORDER BY magnitude DESC LIMIT ?`,
    )
    .bind(siteId, w.from, w.to, limit)
    .all<Stored>();
  return results.map(toSpike);
}

export async function getSpike(db: D1Database, siteId: number, id: number): Promise<SpikeRow | null> {
  const r = await db
    .prepare("SELECT id, start_ts, end_ts, magnitude, top_causes_json FROM spikes WHERE site_id = ? AND id = ?")
    .bind(siteId, id)
    .first<Stored>();
  return r ? toSpike(r) : null;
}
