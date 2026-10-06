import type { Window } from "./queries";

// A funnel is an ordered list of steps. A step that starts with "/" is a page (exact path, or a prefix when it ends
// with *); anything else is a custom event name, such as one sent by agentlytics.track or a data-agentlytics-event click.
// A visitor reaches step N when they hit it at or after the moment they reached step N-1. Visitor ids rotate daily,
// so a visitor only counts through the funnel when all of their steps happen on the same UTC day.

export const MIN_STEPS = 2;
export const MAX_STEPS = 8;
export const MAX_FUNNELS = 10;

export interface FunnelRow {
  id: number;
  name: string;
  steps: string[];
  created_at: number;
}

const clean = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");

export function readSteps(input: unknown): string[] {
  const list = typeof input === "string" ? input.split("\n") : Array.isArray(input) ? input : [];
  const steps = list.map((s) => clean(s, 200)).filter(Boolean);
  if (steps.length < MIN_STEPS || steps.length > MAX_STEPS) throw new Error(`a funnel needs ${MIN_STEPS} to ${MAX_STEPS} steps`);
  steps.forEach((s, i) => {
    if (s.startsWith("/") ? s.length > 512 : s.length > 100) throw new Error(`step ${i + 1} is too long`);
    if (s === steps[i - 1]) throw new Error(`steps ${i} and ${i + 1} are the same`);
  });
  return steps;
}

function condition(step: string, a: string): { sql: string; binds: string[] } {
  if (!step.startsWith("/")) return { sql: `${a}type = 'event' AND ${a}name = ?`, binds: [step] };
  if (step.endsWith("*")) return { sql: `${a}type = 'pageview' AND ${a}path LIKE ? ESCAPE '\\'`, binds: [step.slice(0, -1).replace(/[\\%_]/g, "\\$&") + "%"] };
  return { sql: `${a}type = 'pageview' AND ${a}path = ?`, binds: [step] };
}

export interface FunnelStep {
  step: string;
  visitors: number;
  pct_of_first: number;
  pct_of_previous: number | null;
  lost_from_previous: number;
}

export interface FunnelResult {
  steps: FunnelStep[];
  overall_conversion_pct: number;
  biggest_drop: { from: string; to: string; lost: number; lost_pct: number } | null;
  note: string;
}

const pct = (a: number, b: number) => (b === 0 ? 0 : Math.round((a / b) * 1000) / 10);

export async function funnelResult(db: D1Database, siteId: number, w: Window, steps: string[]): Promise<FunnelResult> {
  const ctes: string[] = [];
  const binds: (string | number)[] = [];
  steps.forEach((step, i) => {
    const c = condition(step, i === 0 ? "" : "e.");
    binds.push(siteId, w.from, w.to, ...c.binds);
    ctes.push(
      i === 0
        ? `s1 AS (SELECT visitor_hash, MIN(ts) AS t FROM events WHERE site_id = ? AND ts >= ? AND ts < ? AND ${c.sql} GROUP BY visitor_hash)`
        : `s${i + 1} AS (SELECT e.visitor_hash, MIN(e.ts) AS t FROM events e JOIN s${i} p ON p.visitor_hash = e.visitor_hash
             WHERE e.site_id = ? AND e.ts >= ? AND e.ts < ? AND e.ts >= p.t AND ${c.sql} GROUP BY e.visitor_hash)`,
    );
  });
  const counts = await db
    .prepare(`WITH ${ctes.join(", ")} SELECT ${steps.map((_, i) => `(SELECT COUNT(*) FROM s${i + 1}) AS c${i + 1}`).join(", ")}`)
    .bind(...binds)
    .first<Record<string, number>>();
  const visitors = steps.map((_, i) => counts![`c${i + 1}`]!);

  const out: FunnelStep[] = steps.map((step, i) => ({
    step,
    visitors: visitors[i]!,
    pct_of_first: pct(visitors[i]!, visitors[0]!),
    pct_of_previous: i === 0 ? null : pct(visitors[i]!, visitors[i - 1]!),
    lost_from_previous: i === 0 ? 0 : visitors[i - 1]! - visitors[i]!,
  }));
  let biggest: FunnelResult["biggest_drop"] = null;
  out.forEach((s, i) => {
    if (i > 0 && s.lost_from_previous > 0 && (!biggest || s.lost_from_previous > biggest.lost)) {
      biggest = { from: steps[i - 1]!, to: s.step, lost: s.lost_from_previous, lost_pct: 100 - s.pct_of_previous! };
    }
  });
  return {
    steps: out,
    overall_conversion_pct: pct(visitors[visitors.length - 1]!, visitors[0]!),
    biggest_drop: biggest,
    note: "Visitors are matched within a single UTC day (visitor ids rotate daily), and each step must come at or after the previous one.",
  };
}

const row = (r: { id: number; name: string; steps_json: string; created_at: number }): FunnelRow => ({ id: r.id, name: r.name, steps: JSON.parse(r.steps_json) as string[], created_at: r.created_at });

export async function listFunnels(db: D1Database, siteId: number): Promise<FunnelRow[]> {
  const { results } = await db.prepare("SELECT id, name, steps_json, created_at FROM funnels WHERE site_id = ? ORDER BY created_at, id").bind(siteId).all<{ id: number; name: string; steps_json: string; created_at: number }>();
  return results.map(row);
}

export async function createFunnel(db: D1Database, siteId: number, input: { name?: unknown; steps?: unknown }, now: number): Promise<FunnelRow> {
  const name = clean(input.name, 60);
  if (!name) throw new Error("name is required");
  const steps = readSteps(input.steps);
  const count = await db.prepare("SELECT COUNT(*) AS n FROM funnels WHERE site_id = ?").bind(siteId).first<{ n: number }>();
  if (count!.n >= MAX_FUNNELS) throw new Error(`a site can have ${MAX_FUNNELS} saved funnels; delete one first`);
  try {
    const r = await db.prepare("INSERT INTO funnels (site_id, name, steps_json, created_at) VALUES (?, ?, ?, ?) RETURNING id").bind(siteId, name, JSON.stringify(steps), now).first<{ id: number }>();
    return { id: r!.id, name, steps, created_at: now };
  } catch {
    throw new Error(`a funnel named "${name}" already exists`);
  }
}

// By id or by name (case-insensitive). Returns whether anything was removed.
export async function deleteFunnel(db: D1Database, siteId: number, ref: { id?: unknown; name?: unknown }): Promise<boolean> {
  const r =
    ref.id !== undefined
      ? await db.prepare("DELETE FROM funnels WHERE site_id = ? AND id = ?").bind(siteId, Number(ref.id)).run()
      : await db.prepare("DELETE FROM funnels WHERE site_id = ? AND name = ? COLLATE NOCASE").bind(siteId, clean(ref.name, 60)).run();
  return (r.meta.changes ?? 0) > 0;
}
