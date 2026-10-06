import { DAY_MS, HOUR_MS } from "./env";
import { DEVICE_SQL, SOURCE_SQL } from "./rollup";

export interface Clause {
  sql: string;
  binds: (string | number)[];
}
// Extra conditions appended to a query's WHERE (after site, type and time).
export type Scope = (w: Window) => Clause;

export interface Window {
  from: number;
  to: number;
}

export async function timeseries(db: D1Database, siteId: number, w: Window, granularity: "hour" | "day", scope?: Scope) {
  const extra = scope?.(w);
  const bucket = granularity === "day" ? DAY_MS : HOUR_MS;
  const { results } = await db
    .prepare(
      `SELECT (ts / ${bucket}) * ${bucket} AS bucket, COUNT(*) AS pageviews, COUNT(DISTINCT visitor_hash) AS visitors
       FROM events WHERE site_id = ? AND type = 'pageview' AND ts >= ? AND ts < ?${extra?.sql ?? ""}
       GROUP BY bucket ORDER BY bucket`,
    )
    .bind(siteId, w.from, w.to, ...(extra?.binds ?? []))
    .all<{ bucket: number; pageviews: number; visitors: number }>();
  return results.map((r) => ({ ...r, time: new Date(r.bucket).toISOString() }));
}

// Pageviews per bucket per source, for the traffic chart's bar labels and hover breakdown.
export async function sourceSeries(db: D1Database, siteId: number, w: Window, granularity: "hour" | "day", scope?: Scope) {
  const extra = scope?.(w);
  const bucket = granularity === "day" ? DAY_MS : HOUR_MS;
  const { results } = await db
    .prepare(
      `SELECT (ts / ${bucket}) * ${bucket} AS bucket, ${SOURCE_SQL} AS dim, COUNT(*) AS count
       FROM events WHERE site_id = ? AND type = 'pageview' AND ts >= ? AND ts < ?${extra?.sql ?? ""}
       GROUP BY bucket, dim ORDER BY bucket, count DESC`,
    )
    .bind(siteId, w.from, w.to, ...(extra?.binds ?? []))
    .all<{ bucket: number; dim: string; count: number }>();
  const by = new Map<number, { name: string; count: number }[]>();
  for (const r of results) {
    const list = by.get(r.bucket) ?? [];
    list.push({ name: r.dim, count: r.count });
    by.set(r.bucket, list);
  }
  return by;
}

async function top(db: D1Database, siteId: number, w: Window, expr: string, type: string, limit: number, scope?: Scope) {
  const extra = scope?.(w);
  const { results } = await db
    .prepare(
      // Alias must not be "name": GROUP BY would bind to the events.name column instead.
      `SELECT ${expr} AS dim, COUNT(*) AS count, COUNT(DISTINCT visitor_hash) AS visitors
       FROM events WHERE site_id = ? AND type = ? AND ts >= ? AND ts < ?${extra?.sql ?? ""}
       GROUP BY dim ORDER BY count DESC LIMIT ?`,
    )
    .bind(siteId, type, w.from, w.to, ...(extra?.binds ?? []), limit)
    .all<{ dim: string; count: number; visitors: number }>();
  return results.map(({ dim, count, visitors }) => ({ name: dim, count, visitors }));
}

export const topSources = (db: D1Database, id: number, w: Window, limit = 10, scope?: Scope) => top(db, id, w, SOURCE_SQL, "pageview", limit, scope);
export const topPages = (db: D1Database, id: number, w: Window, limit = 10, scope?: Scope) => top(db, id, w, "path", "pageview", limit, scope);
export const topCountries = (db: D1Database, id: number, w: Window, limit = 10, scope?: Scope) => top(db, id, w, "COALESCE(country, 'XX')", "pageview", limit, scope);
export const topBrowsers = (db: D1Database, id: number, w: Window, limit = 10, scope?: Scope) => top(db, id, w, "COALESCE(browser, 'Unknown')", "pageview", limit, scope);
export const topSystems = (db: D1Database, id: number, w: Window, limit = 10, scope?: Scope) => top(db, id, w, "COALESCE(os, 'Unknown')", "pageview", limit, scope);
export const topDevices = (db: D1Database, id: number, w: Window, limit = 10, scope?: Scope) => top(db, id, w, DEVICE_SQL, "pageview", limit, scope);

// Only visits that carry the tag; untagged traffic would otherwise be the biggest row.
const tagged = (col: string, scope?: Scope): Scope => (w) => {
  const s = scope?.(w);
  return { sql: ` AND ${col} IS NOT NULL${s?.sql ?? ""}`, binds: s?.binds ?? [] };
};
export const topCampaigns = (db: D1Database, id: number, w: Window, limit = 10, scope?: Scope) => top(db, id, w, "utm_campaign", "pageview", limit, tagged("utm_campaign", scope));
export const topMediums = (db: D1Database, id: number, w: Window, limit = 10, scope?: Scope) => top(db, id, w, "utm_medium", "pageview", limit, tagged("utm_medium", scope));
export const topEvents = (db: D1Database, id: number, w: Window, limit = 10, scope?: Scope) => top(db, id, w, "name", "event", limit, scope);

async function totals(db: D1Database, siteId: number, w: Window, scope?: Scope) {
  const extra = scope?.(w);
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS pageviews, COUNT(DISTINCT visitor_hash) AS visitors
       FROM events WHERE site_id = ? AND type = 'pageview' AND ts >= ? AND ts < ?${extra?.sql ?? ""}`,
    )
    .bind(siteId, w.from, w.to, ...(extra?.binds ?? []))
    .first<{ pageviews: number; visitors: number }>();
  return row!;
}

export async function overview(db: D1Database, siteId: number, w: Window, scopes?: { pageviews: Scope; events: Scope }) {
  const span = w.to - w.from;
  const prev = { from: w.from - span, to: w.from };
  const [cur, before, sources, pages, events] = await Promise.all([
    totals(db, siteId, w, scopes?.pageviews),
    totals(db, siteId, prev, scopes?.pageviews),
    topSources(db, siteId, w, 5, scopes?.pageviews),
    topPages(db, siteId, w, 5, scopes?.pageviews),
    topEvents(db, siteId, w, 5, scopes?.events),
  ]);
  const pct = (a: number, b: number) => (b === 0 ? null : Math.round(((a - b) / b) * 1000) / 10);
  return {
    from: new Date(w.from).toISOString(),
    to: new Date(w.to).toISOString(),
    pageviews: cur.pageviews,
    visitors: cur.visitors,
    vs_previous_period: {
      pageviews_pct: pct(cur.pageviews, before.pageviews),
      visitors_pct: pct(cur.visitors, before.visitors),
      previous_pageviews: before.pageviews,
      previous_visitors: before.visitors,
    },
    top_sources: sources,
    top_pages: pages,
    top_events: events,
  };
}
