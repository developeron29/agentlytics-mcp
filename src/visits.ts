import { SOURCE_SQL } from "./rollup";
import type { Window } from "./queries";
import { countryCode, countryName } from "./geo";

// Questions about a site's visits, for the owner's agent. Everything is built from a fixed set of columns with bound values,
// so a caller can filter and group but never send SQL. No IP address, user agent or other identifying data is stored, so none can be returned.

const DIMENSIONS = {
  country: "COALESCE(country, 'XX')",
  browser: "COALESCE(browser, 'Unknown')",
  os: "COALESCE(os, 'Unknown')",
  source: SOURCE_SQL,
  referrer: "COALESCE(referrer_host, '(none)')",
  page: "path",
  event: "name",
  day: "strftime('%Y-%m-%d', ts / 1000, 'unixepoch')",
  hour: "strftime('%Y-%m-%dT%H:00Z', ts / 1000, 'unixepoch')",
} as const;

export type Dimension = keyof typeof DIMENSIONS;
export const DIMENSION_NAMES = Object.keys(DIMENSIONS) as Dimension[];

export interface VisitFilters {
  type?: "pageview" | "event" | "any";
  country?: string;
  browser?: string;
  os?: string;
  source?: string;
  referrer?: string;
  page?: string; // exact path, or a prefix when it ends with *
  event?: string;
}

const text = (v: unknown, max = 200) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined);

export function readFilters(args: Record<string, unknown>): VisitFilters {
  const type = args.type === "event" || args.type === "any" ? args.type : args.type === "pageview" ? "pageview" : undefined;
  return { type, country: text(args.country), browser: text(args.browser), os: text(args.os), source: text(args.source), referrer: text(args.referrer), page: text(args.page, 512), event: text(args.event, 100) };
}

// WHERE clause (after the site and time window) plus its bound values.
function where(f: VisitFilters, groupBy?: Dimension): { sql: string; binds: (string | number)[] } {
  const parts: string[] = [];
  const binds: (string | number)[] = [];
  const type = f.type ?? (f.event || groupBy === "event" ? "event" : "pageview");
  if (type !== "any") {
    parts.push("type = ?");
    binds.push(type);
  }
  if (f.country) {
    const code = countryCode(f.country);
    if (!code) throw new Error(`unknown country "${f.country}": use an ISO code like US or a name like United States`);
    parts.push("COALESCE(country, 'XX') = ?");
    binds.push(code);
  }
  if (f.browser) {
    parts.push(`${DIMENSIONS.browser} = ? COLLATE NOCASE`);
    binds.push(f.browser);
  }
  if (f.os) {
    parts.push(`${DIMENSIONS.os} = ? COLLATE NOCASE`);
    binds.push(f.os);
  }
  if (f.source) {
    parts.push(`${DIMENSIONS.source} = ? COLLATE NOCASE`);
    binds.push(f.source);
  }
  if (f.referrer) {
    parts.push(`${DIMENSIONS.referrer} = ? COLLATE NOCASE`);
    binds.push(f.referrer);
  }
  if (f.page) {
    if (f.page.endsWith("*")) {
      parts.push("path LIKE ? ESCAPE '\\'");
      binds.push(f.page.slice(0, -1).replace(/[\\%_]/g, "\\$&") + "%");
    } else {
      parts.push("path = ?");
      binds.push(f.page);
    }
  }
  if (f.event) {
    parts.push("name = ?");
    binds.push(f.event);
  }
  return { sql: parts.length ? ` AND ${parts.join(" AND ")}` : "", binds };
}

export function readDimension(v: unknown): Dimension | undefined {
  if (v === undefined || v === null || v === "" || v === "none") return undefined;
  if (typeof v === "string" && v in DIMENSIONS) return v as Dimension;
  throw new Error(`group_by must be one of: ${DIMENSION_NAMES.join(", ")}`);
}

// Counts for the filters, optionally grouped by one dimension. Time dimensions come back oldest first, the rest biggest first.
export async function queryVisits(db: D1Database, siteId: number, w: Window, f: VisitFilters, groupBy: Dimension | undefined, limit: number) {
  const { sql, binds } = where(f, groupBy);
  const base = `FROM events WHERE site_id = ? AND ts >= ? AND ts < ?${sql}`;
  const args = [siteId, w.from, w.to, ...binds];
  const total = (await db.prepare(`SELECT COUNT(*) AS count, COUNT(DISTINCT visitor_hash) AS visitors ${base}`).bind(...args).first<{ count: number; visitors: number }>())!;
  const out: Record<string, unknown> = {
    from: new Date(w.from).toISOString(),
    to: new Date(w.to).toISOString(),
    filters: Object.fromEntries(Object.entries({ ...f, type: f.type ?? (f.event || groupBy === "event" ? "event" : "pageview") }).filter(([, v]) => v !== undefined)),
    total,
  };
  if (groupBy) {
    const time = groupBy === "day" || groupBy === "hour";
    const { results } = await db
      .prepare(`SELECT ${DIMENSIONS[groupBy]} AS dim, COUNT(*) AS count, COUNT(DISTINCT visitor_hash) AS visitors ${base} GROUP BY dim ORDER BY ${time ? "dim ASC" : "count DESC"} LIMIT ?`)
      .bind(...args, time ? 2000 : limit)
      .all<{ dim: string | null; count: number; visitors: number }>();
    out.group_by = groupBy;
    out.groups = results.map((r) => ({ name: r.dim ?? "(none)", ...(groupBy === "country" ? { country: countryName(r.dim ?? "XX") } : {}), count: r.count, visitors: r.visitors }));
  }
  return out;
}

// Individual recent visits, newest first. `visitor` is a short prefix of a hash that changes every day, so it only tells you
// which rows within one day came from the same browser.
export async function recentVisits(db: D1Database, siteId: number, w: Window, f: VisitFilters, limit: number) {
  const { sql, binds } = where({ ...f, type: f.type ?? "any" });
  const { results } = await db
    .prepare(
      `SELECT ts, type, name, path, referrer_host, utm_source, utm_medium, utm_campaign, country, browser, os, props_json, substr(visitor_hash, 1, 8) AS visitor
       FROM events WHERE site_id = ? AND ts >= ? AND ts < ?${sql} ORDER BY ts DESC LIMIT ?`,
    )
    .bind(siteId, w.from, w.to, ...binds, limit)
    .all<{ ts: number; type: string; name: string | null; path: string; referrer_host: string | null; utm_source: string | null; utm_medium: string | null; utm_campaign: string | null; country: string | null; browser: string | null; os: string | null; props_json: string | null; visitor: string }>();
  return results.map((r) => ({
    time: new Date(r.ts).toISOString(),
    type: r.type,
    ...(r.name ? { event: r.name } : {}),
    path: r.path,
    source: r.utm_source ?? r.referrer_host ?? "(direct)",
    ...(r.utm_medium ? { utm_medium: r.utm_medium } : {}),
    ...(r.utm_campaign ? { utm_campaign: r.utm_campaign } : {}),
    country: r.country ? { code: r.country, name: countryName(r.country) } : { code: "XX", name: "Unknown" },
    browser: r.browser ?? "Unknown",
    os: r.os ?? "Unknown",
    ...(r.props_json ? { props: safeJson(r.props_json) } : {}),
    visitor: r.visitor,
  }));
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
