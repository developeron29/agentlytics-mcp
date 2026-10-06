import { DAY_MS, type Site } from "./env";
import type { Window } from "./queries";
import { whatsWorking } from "./working";

const slug = (s: string, max = 60) =>
  s.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, max);

export interface TrackedLinkInput {
  url?: unknown;
  source?: unknown;
  medium?: unknown;
  campaign?: unknown;
  note?: unknown;
}

const ANNOTATION_KIND: Record<string, string> = { email: "email", newsletter: "email", cpc: "ad", paid: "ad", ad: "ad", social: "post", post: "post" };

// Builds a UTM link to a page on the site, records the campaign, and logs an annotation so spikes attribute to it.
export async function createTrackedLink(db: D1Database, site: Site, input: TrackedLinkInput, now: number) {
  const source = slug(String(input.source ?? ""), 40);
  const campaign = slug(String(input.campaign ?? ""));
  const medium = slug(String(input.medium ?? "social"), 40) || "social";
  if (!source || !campaign) throw new Error("source and campaign are required");

  let target: URL;
  try {
    target = new URL(typeof input.url === "string" && input.url ? input.url : "/", `https://${site.domain}`);
  } catch {
    throw new Error("url must be a page on " + site.domain);
  }
  const host = target.hostname.replace(/^www\./, "");
  if (host !== site.domain && !host.endsWith("." + site.domain)) throw new Error("url must be a page on " + site.domain);
  target.searchParams.set("utm_source", source);
  target.searchParams.set("utm_medium", medium);
  target.searchParams.set("utm_campaign", campaign);

  const note = typeof input.note === "string" ? input.note.trim().slice(0, 300) : null;
  await db.batch([
    db
      .prepare("INSERT INTO campaigns (site_id, name, source, medium, url, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .bind(site.id, campaign, source, medium, target.href, note, now),
    db
      .prepare("INSERT INTO annotations (site_id, ts, kind, label) VALUES (?, ?, ?, ?)")
      .bind(site.id, now, ANNOTATION_KIND[medium] ?? "other", `campaign ${campaign} via ${source}${note ? `: ${note}` : ""}`.slice(0, 200)),
  ]);
  return { url: target.href, utm_source: source, utm_medium: medium, utm_campaign: campaign };
}

interface CampaignRow {
  name: string;
  source: string;
  medium: string;
  url: string;
  note: string | null;
  created_at: number;
}

// Per campaign name: traffic and same-day conversions from visitors who arrived with that utm_campaign.
export async function campaignResults(db: D1Database, siteId: number, name: unknown, now: number) {
  const filter = typeof name === "string" && name ? slug(name) : null;
  const { results } = await db
    .prepare(
      `SELECT name, source, medium, url, note, MIN(created_at) AS created_at FROM campaigns
       WHERE site_id = ? AND (? IS NULL OR name = ?) GROUP BY name ORDER BY created_at DESC LIMIT 25`,
    )
    .bind(siteId, filter, filter)
    .all<CampaignRow>();

  return Promise.all(
    results.map(async (c) => {
      const since = c.created_at - DAY_MS; // links are often shared before the campaign row is created
      const [traffic, conv] = await Promise.all([
        db
          .prepare(
            `SELECT COUNT(*) AS pageviews, COUNT(DISTINCT visitor_hash) AS visitors, MIN(ts) AS first_ts, MAX(ts) AS last_ts
             FROM events WHERE site_id = ? AND utm_campaign = ? AND type = 'pageview' AND ts >= ?`,
          )
          .bind(siteId, c.name, since)
          .first<{ pageviews: number; visitors: number; first_ts: number | null; last_ts: number | null }>(),
        db
          .prepare(
            `SELECT COUNT(DISTINCT visitor_hash) AS converted FROM events
             WHERE site_id = ? AND type = 'event' AND ts >= ? AND visitor_hash IN
               (SELECT visitor_hash FROM events WHERE site_id = ? AND utm_campaign = ? AND type = 'pageview' AND ts >= ?)`,
          )
          .bind(siteId, since, siteId, c.name, since)
          .first<{ converted: number }>(),
      ]);
      const t = traffic!;
      return {
        campaign: c.name,
        source: c.source,
        medium: c.medium,
        link: c.url,
        note: c.note,
        created: new Date(c.created_at).toISOString(),
        days_running: Math.max(0, Math.round((now - c.created_at) / DAY_MS)),
        pageviews: t.pageviews,
        visitors: t.visitors,
        converted_visitors: conv!.converted,
        conversion_rate_pct: t.visitors ? Math.round((conv!.converted / t.visitors) * 1000) / 10 : 0,
        first_visit: t.first_ts ? new Date(t.first_ts).toISOString() : null,
        last_visit: t.last_ts ? new Date(t.last_ts).toISOString() : null,
      };
    }),
  );
}

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

async function busiestHour(db: D1Database, siteId: number, w: Window) {
  return db
    .prepare(
      `SELECT CAST(strftime('%w', ts / 1000, 'unixepoch') AS INTEGER) AS dow, CAST(strftime('%H', ts / 1000, 'unixepoch') AS INTEGER) AS hour, COUNT(*) AS n
       FROM events WHERE site_id = ? AND type = 'pageview' AND ts >= ? AND ts < ? GROUP BY dow, hour ORDER BY n DESC LIMIT 1`,
    )
    .bind(siteId, w.from, w.to)
    .first<{ dow: number; hour: number; n: number }>();
}

export interface GrowthAction {
  priority: number;
  title: string;
  evidence: string;
  steps: string[];
  tracked_link?: { source: string; medium: string; campaign: string; url: string };
  measure: string;
}

// Turns the analytics into a ranked, concrete action list an agent can carry out and later measure.
export async function growthActions(db: D1Database, site: Site, w: Window) {
  const [ww, peak] = await Promise.all([whatsWorking(db, site.id, w), busiestHour(db, site.id, w)]);
  const totalPv = ww.channels.reduce((n, c) => n + c.pageviews, 0);
  const hasConversions = ww.channels.some((c) => c.converted_visitors > 0);
  const actions: GrowthAction[] = [];
  const week = new Date(w.to).toISOString().slice(0, 10);
  const link = (source: string, medium: string, path = "/") => ({
    source: slug(source, 40),
    medium,
    campaign: `${slug(source, 20)}-${week}`,
    url: `https://${site.domain}${path}`,
  });

  if (totalPv < 100) {
    actions.push({
      priority: 1,
      title: "Get enough traffic to learn from",
      evidence: `Only ${totalPv} pageviews in this period; patterns below this are mostly noise.`,
      steps: [
        "Pick 2-3 channels where your audience already gathers (communities, newsletters, social).",
        "Share one useful piece per channel this week, each with its own tracked link (create_tracked_link).",
        "Check get_campaign_results after 3-7 days and keep the channel that brought visitors.",
      ],
      measure: "get_campaign_results; aim for 100+ pageviews/week so spikes and conversion rates become meaningful.",
    });
  }

  if (!hasConversions) {
    actions.push({
      priority: 2,
      title: "Track the action that matters (signups, purchases)",
      evidence: "No custom events recorded, so no channel can be credited with conversions.",
      steps: [
        'Call agentlytics.track("signup") (or "purchase", "demo_request") where that action succeeds in the site code.',
        "Deploy, then call add_annotation with kind=deploy.",
      ],
      measure: "list_events should show the event within a day; get_whats_working will then rank channels by conversions.",
    });
  }

  const converting = ww.channels.filter((c) => c.visitors >= 20 && c.converted_visitors > 0).sort((a, b) => b.conversion_rate_pct - a.conversion_rate_pct)[0];
  if (converting) {
    actions.push({
      priority: 3,
      title: `Double down on ${converting.source}`,
      evidence: `${converting.source} converts ${converting.conversion_rate_pct}% of ${converting.visitors} visitors (${converting.converted_visitors} converted).`,
      steps: [
        `Publish 2 more pieces aimed at the ${converting.source} audience this week.`,
        "Use a fresh tracked link for each so they can be compared.",
      ],
      tracked_link: link(converting.source, "social"),
      measure: "get_campaign_results for the new campaign vs this channel's current conversion rate.",
    });
  }

  const growing = ww.channels.filter((c) => c.visitors >= 10 && c.growth_pct !== null && c.growth_pct >= 50 && c.source !== converting?.source)[0];
  if (growing) {
    actions.push({
      priority: 4,
      title: `Ride the growth from ${growing.source}`,
      evidence: `${growing.source} pageviews are up ${growing.growth_pct}% vs the previous period (${growing.pageviews} now).`,
      steps: [`Find what was shared on ${growing.source} recently and post a follow-up there.`, "Reply to comments or threads that link to you."],
      tracked_link: link(growing.source, "social"),
      measure: "top_sources next week: the channel should hold or grow.",
    });
  }

  const page = ww.growing_pages.find((p) => p.path !== "/") ?? ww.growing_pages[0];
  if (page && page.pageviews >= 10) {
    actions.push({
      priority: 5,
      title: `Promote ${page.path}`,
      evidence: `${page.path} has ${page.pageviews} pageviews, ${page.growth_pct === null ? "new this period" : `up ${page.growth_pct}%`}.`,
      steps: [
        `Add a clear call to action on ${page.path} (signup, demo, newsletter).`,
        `Share ${page.path} on your best channel${converting ? ` (${converting.source})` : ""} with a tracked link.`,
      ],
      tracked_link: link(converting?.source ?? "social", "social", page.path),
      measure: "get_campaign_results, and list_events for the call-to-action event.",
    });
  }

  const driver = ww.spike_drivers.find((d) => d.spikes >= 2);
  if (driver) {
    actions.push({
      priority: 6,
      title: `Repeat what caused ${driver.spikes} spikes: ${driver.name}`,
      evidence: `${driver.kind} ${driver.name} appears in ${driver.spikes} spikes, ${driver.total_lift} extra pageviews in total.`,
      steps: ["Look at explain_spike for those spikes to see what was posted or launched.", "Schedule the same kind of post or launch again."],
      measure: "find_traffic_spikes after it goes out; log it with add_annotation first.",
    });
  }

  if (peak && peak.n >= 10) {
    actions.push({
      priority: 7,
      title: `Publish around ${String(peak.hour).padStart(2, "0")}:00 UTC on ${DAYS[peak.dow]}`,
      evidence: `Your busiest hour of the week in this period (${peak.n} pageviews).`,
      steps: ["Time launches, newsletters and posts to go out an hour or two before this."],
      measure: "Compare the next spike's size with explain_spike.",
    });
  }

  return {
    site: site.domain,
    from: new Date(w.from).toISOString(),
    to: new Date(w.to).toISOString(),
    actions: actions.sort((a, b) => a.priority - b.priority),
    how_to_execute: [
      "For each action you take, call create_tracked_link and use that URL wherever you share it.",
      "If you publish something yourself (post, email, deploy), call add_annotation right after.",
      "Come back in 3-7 days and call get_campaign_results to see what worked, then repeat the winners.",
    ],
  };
}
