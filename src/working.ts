import { SOURCE_SQL } from "./rollup";
import { topPages, topSources, type Window } from "./queries";
import { listSpikes } from "./spikes";

const pct = (a: number, b: number) => (b === 0 ? null : Math.round(((a - b) / b) * 100));

// Evidence for marketing planning: which channels bring visitors, which of them convert, what is growing,
// and which spike causes keep recurring. Conversion = a custom event fired by the same visitor on the same
// day (visitor ids rotate daily) after a pageview from that channel.
export async function whatsWorking(db: D1Database, siteId: number, w: Window) {
  const span = w.to - w.from;
  const prev = { from: w.from - span, to: w.from };

  const [sources, prevSources, pages, prevPages, conv, spikes] = await Promise.all([
    topSources(db, siteId, w, 20),
    topSources(db, siteId, prev, 50),
    topPages(db, siteId, w, 10),
    topPages(db, siteId, prev, 50),
    db
      .prepare(
        `SELECT p.src AS name, COUNT(DISTINCT p.visitor_hash) AS visitors, COUNT(DISTINCT e.visitor_hash) AS converted
         FROM (SELECT visitor_hash, ts, ${SOURCE_SQL} AS src FROM events WHERE site_id = ? AND type = 'pageview' AND ts >= ? AND ts < ?) p
         LEFT JOIN events e ON e.site_id = ? AND e.type = 'event' AND e.ts >= ? AND e.ts < ? AND e.visitor_hash = p.visitor_hash AND e.ts >= p.ts
         GROUP BY p.src`,
      )
      .bind(siteId, w.from, w.to, siteId, w.from, w.to)
      .all<{ name: string; visitors: number; converted: number }>(),
    listSpikes(db, siteId, w, 20),
  ]);

  const prevBy = new Map(prevSources.map((s) => [s.name, s.count]));
  const convBy = new Map(conv.results.map((c) => [c.name, c]));
  const channels = sources.map((s) => {
    const c = convBy.get(s.name);
    return {
      source: s.name,
      pageviews: s.count,
      visitors: s.visitors,
      growth_pct: pct(s.count, prevBy.get(s.name) ?? 0), // null = new channel this period
      converted_visitors: c?.converted ?? 0,
      conversion_rate_pct: c && c.visitors > 0 ? Math.round((c.converted / c.visitors) * 1000) / 10 : 0,
    };
  });

  const prevPageBy = new Map(prevPages.map((p) => [p.name, p.count]));
  const growingPages = pages
    .map((p) => ({ path: p.name, pageviews: p.count, visitors: p.visitors, growth_pct: pct(p.count, prevPageBy.get(p.name) ?? 0) }))
    .filter((p) => p.growth_pct === null || p.growth_pct > 0);

  // Causes that show up in several spikes are channels/pages that reliably move traffic.
  const drivers = new Map<string, { kind: string; name: string; spikes: number; total_lift: number }>();
  for (const s of spikes) {
    for (const c of s.causes) {
      const key = `${c.kind}:${c.name}`;
      const d = drivers.get(key) ?? { kind: c.kind, name: c.name, spikes: 0, total_lift: 0 };
      d.spikes += 1;
      d.total_lift += c.lift;
      drivers.set(key, d);
    }
  }

  return {
    from: new Date(w.from).toISOString(),
    to: new Date(w.to).toISOString(),
    channels: channels.sort((a, b) => b.converted_visitors - a.converted_visitors || b.visitors - a.visitors),
    growing_pages: growingPages,
    spike_drivers: [...drivers.values()].sort((a, b) => b.total_lift - a.total_lift).slice(0, 10),
    spikes_in_range: spikes.length,
    notes: [
      "growth_pct compares against the immediately preceding period of equal length; null means no traffic then.",
      "conversion counts any custom event fired the same day by a visitor who arrived from that channel.",
    ],
  };
}
