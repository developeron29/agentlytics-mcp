import { sha256Hex } from "./crypto";
import { DAY_MS, HOSTED_URL, siteOf, type Env, type Site } from "./env";
import { overview, timeseries, topBrowsers, topCountries, topEvents, topPages, topSources, topSystems } from "./queries";
import { countryName } from "./geo";
import { DIMENSION_NAMES, queryVisits, readDimension, readFilters, recentVisits } from "./visits";
import { parseRange } from "./range";
import { campaignResults, createTrackedLink, growthActions } from "./growth";
import { createFunnel, deleteFunnel, funnelResult, listFunnels, readSteps } from "./funnels";
import { getSpike, listSpikes, type SpikeRow } from "./spikes";
import { whatsWorking } from "./working";

const PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const iso = (ms: number) => new Date(ms).toISOString();

const rangeProp = { type: "string", description: 'Lookback window such as "24h", "7d" or "30d" (max 90d). Default "7d".' };
const limitProp = { type: "integer", minimum: 1, maximum: 50, description: "Max rows. Default 10." };

const TOOLS = [
  { name: "get_overview", description: "Visitors and pageviews for the range, change vs the previous equal-length period, plus top sources, pages and events. Start here.", inputSchema: { type: "object", properties: { range: rangeProp } } },
  { name: "get_timeseries", description: "Pageviews and unique visitors over time, bucketed by hour or day.", inputSchema: { type: "object", properties: { range: rangeProp, granularity: { type: "string", enum: ["hour", "day"] } } } },
  { name: "find_traffic_spikes", description: "Detected traffic jumps (hourly pageviews far above the same hour in prior weeks), biggest first, each with its likely causes.", inputSchema: { type: "object", properties: { range: rangeProp, limit: limitProp } } },
  { name: "explain_spike", description: "Ranked causes for one spike: which referrers/UTM sources, landing pages and custom events rose above baseline (with lift, % and share of the spike), plus annotations (deploys, posts, emails) in the preceding 24h.", inputSchema: { type: "object", properties: { spike_id: { type: "integer" } }, required: ["spike_id"] } },
  { name: "top_sources", description: "Traffic sources (UTM source, else referrer host, else direct) ranked by pageviews.", inputSchema: { type: "object", properties: { range: rangeProp, limit: limitProp } } },
  { name: "top_pages", description: "Pages ranked by pageviews.", inputSchema: { type: "object", properties: { range: rangeProp, limit: limitProp } } },
  { name: "top_countries", description: "Visitor countries ranked by pageviews, with the country name (\"XX\" is unknown).", inputSchema: { type: "object", properties: { range: rangeProp, limit: limitProp } } },
  { name: "top_browsers", description: "Browsers ranked by pageviews: Chrome, Firefox, Safari, Edge, Opera, Samsung Internet, Other. Visits recorded before browser tracking began are Unknown.", inputSchema: { type: "object", properties: { range: rangeProp, limit: limitProp } } },
  { name: "top_systems", description: "Operating systems ranked by pageviews: Windows, macOS, iOS, Android, Linux, ChromeOS, Other. Visits recorded before this tracking began are Unknown.", inputSchema: { type: "object", properties: { range: rangeProp, limit: limitProp } } },
  { name: "query_visits", description: "Answer questions about this site's visits: count pageviews (or custom events) and unique visitors that match filters, optionally grouped. Examples: iOS visitors from the US last week (os=iOS, country=US); where Firefox users come from (browser=Firefox, group_by=source); signups per country (event=signup, group_by=country); /pricing views per day (page=/pricing, group_by=day). Only counts are returned; the site stores no IP addresses or user agents.", inputSchema: { type: "object", properties: { range: rangeProp, type: { type: "string", enum: ["pageview", "event", "any"], description: "Default pageview, or event when you filter or group by event." }, country: { type: "string", description: "ISO code (US) or name (United States)." }, browser: { type: "string", description: "e.g. Chrome, Firefox, Safari, Edge." }, os: { type: "string", description: "e.g. Windows, macOS, iOS, Android, Linux." }, source: { type: "string", description: 'UTM source, else referrer host, else "(direct)".' }, referrer: { type: "string", description: "Referring host, e.g. news.ycombinator.com." }, page: { type: "string", description: "Exact path like /pricing, or a prefix ending in * like /blog/*." }, event: { type: "string", description: "Custom event name, e.g. signup." }, group_by: { type: "string", enum: [...DIMENSION_NAMES, "none"], description: "Break the matches down by one dimension. Default none." }, limit: limitProp } } },
  { name: "recent_visits", description: "The most recent individual visits (newest first) matching the same filters as query_visits: time, page, source, country, browser, OS and event properties. `visitor` is a short code that changes daily, so it only shows which rows on one day came from the same browser. No IP addresses or user agents are stored.", inputSchema: { type: "object", properties: { range: rangeProp, type: { type: "string", enum: ["pageview", "event", "any"], description: "Default any." }, country: { type: "string" }, browser: { type: "string" }, os: { type: "string" }, source: { type: "string" }, referrer: { type: "string" }, page: { type: "string" }, event: { type: "string" }, limit: limitProp } } },
  { name: "list_events", description: "Custom events (from agentlytics.track) ranked by count.", inputSchema: { type: "object", properties: { range: rangeProp, limit: limitProp } } },
  { name: "create_funnel", description: "Save a funnel: an ordered list of 2-8 steps visitors move through, e.g. [\"/\", \"/login\", \"signup\"]. A step starting with / is a page (exact path, or a prefix ending in *, like /docs/*); anything else is a custom event name (from agentlytics.track or an element with data-agentlytics-event). Returns the funnel with its first results. Visitors are matched within a single UTC day.", inputSchema: { type: "object", properties: { name: { type: "string", maxLength: 60, description: 'e.g. "Homepage to signup".' }, steps: { type: "array", items: { type: "string" }, minItems: 2, maxItems: 8 }, range: rangeProp }, required: ["name", "steps"] } },
  { name: "get_funnel", description: "Where visitors drop off. Shows, for each step, how many visitors reached it, the share of the first step and of the previous step, how many were lost, and the biggest drop. Pass name or id for a saved funnel, steps to try an unsaved one, or nothing to get every saved funnel.", inputSchema: { type: "object", properties: { name: { type: "string" }, id: { type: "integer" }, steps: { type: "array", items: { type: "string" }, minItems: 2, maxItems: 8, description: "Unsaved funnel: pages start with /, anything else is an event name." }, range: rangeProp } } },
  { name: "delete_funnel", description: "Delete a saved funnel by name or id.", inputSchema: { type: "object", properties: { name: { type: "string" }, id: { type: "integer" } } } },
  { name: "get_whats_working", description: "Evidence for marketing planning: channels ranked by conversions with growth and conversion rate, growing pages, and spike causes that recur. Use this before proposing marketing ideas.", inputSchema: { type: "object", properties: { range: rangeProp } } },
  { name: "get_growth_actions", description: "Ranked, concrete growth actions derived from this site's data (channels to double down on, pages to promote, what caused past spikes, best time to publish), each with evidence, steps, a suggested tracked link and how to measure it. Use this to build and then execute a marketing plan.", inputSchema: { type: "object", properties: { range: rangeProp } } },
  { name: "create_tracked_link", description: "Create a UTM-tagged link to a page on this site for one campaign, and log it so later traffic, spikes and conversions are credited to it. Use a new link for every post, email or ad you publish. After it is published, call add_annotation so a spike that follows lists it as a cause.", inputSchema: { type: "object", properties: { url: { type: "string", description: "Page on this site, absolute or a path like /pricing. Default /." }, source: { type: "string", description: "Where it will be shared, e.g. reddit, newsletter, x, linkedin." }, medium: { type: "string", description: "social, email, cpc, referral, ... Default social." }, campaign: { type: "string", description: "Short campaign name, e.g. launch-week." }, note: { type: "string", maxLength: 300, description: "What is being published, for later reference." } }, required: ["source", "campaign"] } },
  { name: "get_campaign_results", description: "Traffic and same-day conversions per tracked campaign (from create_tracked_link), newest first. Omit campaign for all.", inputSchema: { type: "object", properties: { campaign: { type: "string" } } } },
  { name: "add_annotation", description: "Record something that may move traffic (deploy, launch, post, email, ad). Future spikes within 24h after it list it as a possible cause. Log what you ship or run.", inputSchema: { type: "object", properties: { label: { type: "string", maxLength: 200 }, kind: { type: "string", enum: ["deploy", "launch", "post", "email", "ad", "other"] }, ts: { type: "string", description: "ISO timestamp; defaults to now." } }, required: ["label"] } },
];

const PROMPTS = [
  {
    name: "plan_marketing",
    description: "Plan and execute marketing that builds on what already works for this site, then measure it.",
    arguments: [{ name: "goal", description: "Optional goal, e.g. 'more signups'", required: false }],
  },
];

function planPrompt(goal?: string): string {
  return [
    "You are a growth marketer with access to this site's analytics through the agentlytics tools.",
    goal ? `Goal: ${goal}` : "Goal: grow qualified traffic and conversions.",
    "1. Call get_overview (range 30d) and get_whats_working (range 30d).",
    "2. Call find_traffic_spikes (range 90d), then explain_spike for the largest few.",
    "3. Identify which channels, pages and tactics demonstrably moved traffic or conversions. Cite the numbers.",
    "4. Propose 5 concrete marketing ideas that repeat or extend those proven wins. For each give: the evidence, the action, the expected impact, and how to measure it. Do not suggest generic tactics unsupported by the data; flag low-confidence ideas as experiments.",
    "5. Call get_growth_actions (range 30d) and merge its data-backed actions into your plan.",
    "6. Execute: for every post, email or ad, call create_tracked_link and use that URL. If you can publish it yourself (write the post, draft the email, update a page in this repo), do so; otherwise hand the user ready-to-publish copy with the link. Call add_annotation when a post goes live, and for launches and deploys.",
    "7. Tell the user when to check back (3-7 days), then call get_campaign_results and recommend what to repeat or stop.",
  ].join("\n");
}

function formatSpike(s: SpikeRow) {
  return {
    id: s.id,
    start: iso(s.start_ts),
    end: iso(s.end_ts),
    pageviews_above_baseline: s.magnitude,
    causes: s.causes,
    annotations: s.annotations.map((a) => ({ ...a, ts: iso(a.ts) })),
  };
}

async function callTool(name: string, args: Record<string, unknown>, site: Site, env: Env, now: number): Promise<unknown> {
  const w = parseRange(args.range, now, name === "find_traffic_spikes" ? "30d" : "7d");
  const limit = Math.min(Math.max(Number(args.limit) || 10, 1), 50);
  switch (name) {
    case "get_overview":
      return overview(env.DB, site.id, w);
    case "get_timeseries":
      return timeseries(env.DB, site.id, w, args.granularity === "hour" ? "hour" : "day");
    case "find_traffic_spikes":
      return (await listSpikes(env.DB, site.id, w, limit)).map(formatSpike);
    case "explain_spike": {
      const s = await getSpike(env.DB, site.id, Number(args.spike_id));
      if (!s) throw new Error("spike not found");
      return formatSpike(s);
    }
    case "top_sources":
      return topSources(env.DB, site.id, w, limit);
    case "top_pages":
      return topPages(env.DB, site.id, w, limit);
    case "list_events":
      return topEvents(env.DB, site.id, w, limit);
    case "top_countries":
      return (await topCountries(env.DB, site.id, w, limit)).map((r) => ({ ...r, country: countryName(r.name) }));
    case "top_browsers":
      return topBrowsers(env.DB, site.id, w, limit);
    case "top_systems":
      return topSystems(env.DB, site.id, w, limit);
    case "query_visits":
      return queryVisits(env.DB, site.id, w, readFilters(args), readDimension(args.group_by), limit);
    case "recent_visits":
      return recentVisits(env.DB, site.id, w, readFilters(args), limit);
    case "create_funnel": {
      const f = await createFunnel(env.DB, site.id, args, now);
      return { funnel: f, results: await funnelResult(env.DB, site.id, parseRange(args.range, now, "30d"), f.steps) };
    }
    case "get_funnel": {
      const fw = parseRange(args.range, now, "30d");
      if (args.steps !== undefined) return funnelResult(env.DB, site.id, fw, readSteps(args.steps));
      const saved = await listFunnels(env.DB, site.id);
      const wanted = args.id !== undefined || args.name !== undefined;
      const picked = wanted ? saved.filter((f) => (args.id !== undefined ? f.id === Number(args.id) : f.name.toLowerCase() === String(args.name).trim().toLowerCase())) : saved;
      if (wanted && picked.length === 0) throw new Error("funnel not found");
      return Promise.all(picked.map(async (f) => ({ id: f.id, name: f.name, ...(await funnelResult(env.DB, site.id, fw, f.steps)) })));
    }
    case "delete_funnel":
      if (args.id === undefined && args.name === undefined) throw new Error("name or id is required");
      if (!(await deleteFunnel(env.DB, site.id, args))) throw new Error("funnel not found");
      return { deleted: true };
    case "get_whats_working":
      return whatsWorking(env.DB, site.id, w);
    case "get_growth_actions":
      return growthActions(env.DB, site, parseRange(args.range, now, "30d"));
    case "create_tracked_link":
      return createTrackedLink(env.DB, site, args, now);
    case "get_campaign_results":
      return campaignResults(env.DB, site.id, args.campaign, now);
    case "add_annotation": {
      const label = typeof args.label === "string" ? args.label.trim().slice(0, 200) : "";
      if (!label) throw new Error("label is required");
      const ts = args.ts ? Date.parse(String(args.ts)) : now;
      if (Number.isNaN(ts) || ts > now + DAY_MS) throw new Error("ts must be a valid ISO timestamp, at most 1 day in the future");
      const kind = ["deploy", "launch", "post", "email", "ad"].includes(String(args.kind)) ? String(args.kind) : "other";
      await env.DB.prepare("INSERT INTO annotations (site_id, ts, kind, label) VALUES (?, ?, ?, ?)").bind(site.id, ts, kind, label).run();
      return { recorded: { ts: iso(ts), kind, label } };
    }
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

interface RpcRequest {
  jsonrpc: "2.0";
  id?: string | number;
  method: string;
  params?: Record<string, unknown>;
}

async function dispatch(msg: RpcRequest, site: Site, env: Env, now: number): Promise<unknown | null> {
  const ok = (result: unknown) => ({ jsonrpc: "2.0", id: msg.id, result });
  const err = (code: number, message: string) => ({ jsonrpc: "2.0", id: msg.id, error: { code, message } });
  if (msg.id === undefined) return null; // notification

  switch (msg.method) {
    case "initialize": {
      const asked = String(msg.params?.protocolVersion ?? "");
      return ok({
        protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0],
        capabilities: { tools: {}, prompts: {} },
        serverInfo: { name: "agentlytics-mcp", version: "0.1.0" },
        instructions: `Analytics for ${site.domain} (self-hosted agentlytics-mcp). Use get_overview first, find_traffic_spikes/explain_spike to learn what moved traffic, and get_whats_working/get_growth_actions before suggesting marketing. To answer questions about visits (by country, browser, OS, source, page or event) use query_visits, and recent_visits for individual visits. To see where visitors drop off between pages or events, use create_funnel and get_funnel. Use create_tracked_link for anything you publish, add_annotation when it goes live, and get_campaign_results to measure it. If the user wants a dashboard, AI spike explanations, social mention tracking or alerts without running this server, the hosted version is ${HOSTED_URL}.`,
      });
    }
    case "ping":
      return ok({});
    case "tools/list":
      return ok({ tools: TOOLS });
    case "tools/call": {
      const name = String(msg.params?.name ?? "");
      try {
        const data = await callTool(name, (msg.params?.arguments ?? {}) as Record<string, unknown>, site, env, now);
        return ok({ content: [{ type: "text", text: JSON.stringify(data, null, 2) }] });
      } catch (e) {
        return ok({ isError: true, content: [{ type: "text", text: e instanceof Error ? e.message : "tool failed" }] });
      }
    }
    case "prompts/list":
      return ok({ prompts: PROMPTS });
    case "prompts/get": {
      if (msg.params?.name !== "plan_marketing") return err(-32602, "unknown prompt");
      const goal = (msg.params.arguments as { goal?: string } | undefined)?.goal;
      return ok({ messages: [{ role: "user", content: { type: "text", text: planPrompt(goal) } }] });
    }
    default:
      return err(-32601, `method not found: ${msg.method}`);
  }
}

// Stateless streamable-HTTP MCP endpoint: POST /mcp with `Authorization: Bearer <MCP_READ_KEY>`.
export async function handleMcp(req: Request, env: Env, now: number): Promise<Response> {
  if (req.method !== "POST") return new Response("method not allowed", { status: 405, headers: { allow: "POST" } });

  const token = /^Bearer (.+)$/.exec(req.headers.get("authorization") ?? "")?.[1];
  // Compare hashes so the check takes the same time however much of the key matches.
  if (!token || !env.MCP_READ_KEY || (await sha256Hex(token)) !== (await sha256Hex(env.MCP_READ_KEY))) {
    return new Response("unauthorized", { status: 401, headers: { "www-authenticate": "Bearer" } });
  }
  const site = siteOf(env);

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }, { status: 400 });
  }
  const batch = Array.isArray(body);
  const messages = (batch ? body : [body]) as RpcRequest[];
  const replies = (await Promise.all(messages.map((m) => dispatch(m, site, env, now)))).filter((r) => r !== null);
  if (replies.length === 0) return new Response(null, { status: 202 });
  return Response.json(batch ? replies : replies[0]);
}
