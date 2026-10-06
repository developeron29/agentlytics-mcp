import { beforeEach, describe, expect, it } from "vitest";
import { handleMcp } from "../src/mcp";
import { rollup } from "../src/rollup";
import { detectSpikes } from "../src/spikes";
import { SITE_ID } from "../src/env";
import { DAY, HOUR, NOW, db, hourOfHits, insertHits, resetDb, seedSteadyTraffic } from "./helpers";

const env = { DB: db, MCP_READ_KEY: "rk_test", SITE_DOMAIN: "example.com" } as never;
const hourNow = Math.floor(NOW / HOUR) * HOUR;
const spikeHour = hourNow - 2 * HOUR;

async function rpc(method: string, params?: object, key = "rk_test", id: number | null = 1) {
  const res = await handleMcp(
    new Request("https://x.test/mcp", {
      method: "POST",
      headers: { authorization: `Bearer ${key}` },
      body: JSON.stringify({ jsonrpc: "2.0", ...(id === null ? {} : { id }), method, params }),
    }),
    env,
    NOW,
  );
  return res;
}

async function tool(name: string, args: object = {}) {
  const body = (await (await rpc("tools/call", { name, arguments: args })).json()) as {
    result: { isError?: boolean; content: { text: string }[] };
  };
  const text = body.result.content[0]!.text;
  const isError = body.result.isError ?? false;
  return { isError, data: isError ? text : JSON.parse(text) };
}

const siteId = SITE_ID;
beforeEach(async () => {
  await resetDb();
  await seedSteadyTraffic(siteId, NOW, 6);
  await insertHits(siteId, [
    ...hourOfHits(spikeHour, 150, { source: "news.ycombinator.com", path: "/launch" }),
    { ts: spikeHour + 5000, source: "news.ycombinator.com", path: "/launch", visitor: "hn1" },
    { ts: spikeHour + 9000, type: "event", name: "signup", visitor: "hn1" },
  ]);
  await rollup(db, hourNow - 5 * 7 * DAY, NOW);
  await detectSpikes(db, siteId, NOW - 30 * DAY, NOW, 6);
});

describe("mcp transport", () => {
  it("requires a valid read key and POST", async () => {
    expect((await rpc("ping", {}, "rk_wrong")).status).toBe(401);
    const get = await handleMcp(new Request("https://x.test/mcp"), env, NOW);
    expect(get.status).toBe(405);
  });

  it("initializes, echoing a supported protocol version", async () => {
    const body = (await (await rpc("initialize", { protocolVersion: "2025-03-26" })).json()) as any;
    expect(body.result.protocolVersion).toBe("2025-03-26");
    expect(body.result.serverInfo.name).toBe("agentlytics-mcp");
    expect(body.result.instructions).toContain("example.com");
  });

  it("accepts notifications with 202 and lists tools and prompts", async () => {
    expect((await rpc("notifications/initialized", {}, "rk_test", null)).status).toBe(202);
    const tools = ((await (await rpc("tools/list")).json()) as any).result.tools.map((t: { name: string }) => t.name);
    expect(tools).toEqual(expect.arrayContaining(["get_overview", "find_traffic_spikes", "explain_spike", "get_whats_working", "add_annotation"]));
    const prompt = ((await (await rpc("prompts/get", { name: "plan_marketing", arguments: { goal: "signups" } })).json()) as any).result;
    expect(prompt.messages[0].content.text).toContain("get_whats_working");
    expect(prompt.messages[0].content.text).toContain("signups");
  });
});

describe("mcp tools", () => {
  it("get_overview reports totals and the top source", async () => {
    const { data } = await tool("get_overview", { range: "24h" });
    expect(data.pageviews).toBeGreaterThan(150);
    expect(data.top_sources[0].name).toBe("news.ycombinator.com");
  });

  it("finds the spike and explains it", async () => {
    const { data: spikes } = await tool("find_traffic_spikes", { range: "7d" });
    expect(spikes).toHaveLength(1);
    expect(spikes[0].causes[0]).toMatchObject({ kind: "source", name: "news.ycombinator.com" });
    const { data } = await tool("explain_spike", { spike_id: spikes[0].id });
    expect(data.start).toBe(new Date(spikeHour).toISOString());
    expect((await tool("explain_spike", { spike_id: 99999 })).isError).toBe(true);
  });

  it("get_whats_working ranks the converting channel first with its spike driver", async () => {
    const { data } = await tool("get_whats_working", { range: "30d" });
    expect(data.channels[0]).toMatchObject({ source: "news.ycombinator.com", converted_visitors: 1 });
    expect(data.channels[0].conversion_rate_pct).toBeGreaterThan(0);
    expect(data.spike_drivers[0]).toMatchObject({ name: "news.ycombinator.com", spikes: 1 });
  });

  it("add_annotation records and validates", async () => {
    const ok = await tool("add_annotation", { label: "Shipped pricing page", kind: "deploy" });
    expect(ok.data.recorded.kind).toBe("deploy");
    const row = await db.prepare("SELECT * FROM annotations").first<{ label: string }>();
    expect(row!.label).toBe("Shipped pricing page");
    expect((await tool("add_annotation", { label: "" })).isError).toBe(true);
    expect((await tool("add_annotation", { label: "x", ts: "2099-01-01T00:00:00Z" })).isError).toBe(true);
  });

  it("unknown tool returns a tool error", async () => {
    expect((await tool("nope")).isError).toBe(true);
  });
});

describe("visit questions", () => {
  const T = NOW - 3 * HOUR;
  beforeEach(async () => {
    await insertHits(siteId, [
      { ts: T, path: "/q/a", source: "google.com", country: "US", browser: "Safari", os: "iOS", visitor: "q1" },
      { ts: T + 1000, path: "/q/b", source: "google.com", country: "US", browser: "Safari", os: "iOS", visitor: "q1" },
      { ts: T + 2000, path: "/q/a", source: "github.com", country: "IN", browser: "Chrome", os: "Windows", visitor: "q2" },
      { ts: T + 3000, path: "/q/a", country: "IN", browser: "Firefox", os: "Linux", visitor: "q3" },
      { ts: T + 4000, path: "/q/c", visitor: "q4" }, // recorded before browser and country tracking: all unknown
      { ts: T + 5000, type: "event", name: "signup", path: "/q/a", country: "US", browser: "Safari", os: "iOS", visitor: "q1" },
    ]);
  });

  it("lists new tools and the top country, browser and system breakdowns", async () => {
    const list = (await (await rpc("tools/list")).json()) as { result: { tools: { name: string }[] } };
    const names = list.result.tools.map((t) => t.name);
    for (const n of ["top_countries", "top_browsers", "top_systems", "query_visits", "recent_visits"]) expect(names).toContain(n);
    const countries = (await tool("top_countries", { range: "24h" })).data as { name: string; country: string; count: number }[];
    expect(countries.find((c) => c.name === "US")).toMatchObject({ country: "United States", count: 2 });
    expect(countries.find((c) => c.name === "XX")?.country).toBe("Unknown");
    const browsers = (await tool("top_browsers", { range: "24h" })).data as { name: string; count: number }[];
    expect(browsers.find((b) => b.name === "Safari")?.count).toBe(2);
    const systems = (await tool("top_systems", { range: "24h" })).data as { name: string }[];
    expect(systems.map((s) => s.name)).toContain("iOS");
  });

  it("filters and groups visits", async () => {
    const ios = (await tool("query_visits", { range: "24h", os: "ios", country: "United States" })).data as any;
    expect(ios.total).toEqual({ count: 2, visitors: 1 }); // case-insensitive os, country by name; one visitor viewed two pages
    const bySource = (await tool("query_visits", { range: "24h", page: "/q/*", group_by: "source" })).data as any;
    expect(bySource.groups.map((g: any) => [g.name, g.count])).toEqual([["google.com", 2], ["(direct)", 2], ["github.com", 1]]);
    const firefox = (await tool("query_visits", { range: "24h", browser: "Firefox", group_by: "country" })).data as any;
    expect(firefox.groups).toEqual([{ name: "IN", country: "India", count: 1, visitors: 1 }]);
    const signups = (await tool("query_visits", { range: "24h", event: "signup", page: "/q/*", group_by: "country" })).data as any;
    expect(signups.filters.type).toBe("event");
    expect(signups.groups).toEqual([{ name: "US", country: "United States", count: 1, visitors: 1 }]);
    const unknown = (await tool("query_visits", { range: "24h", page: "/q/c", browser: "Unknown" })).data as any;
    expect(unknown.total.count).toBe(1);
    const perDay = (await tool("query_visits", { range: "7d", page: "/q/*", group_by: "day" })).data as any;
    expect(perDay.groups.reduce((n: number, g: any) => n + g.count, 0)).toBe(5);
  });

  it("rejects bad input and treats filter values as data, never SQL", async () => {
    expect((await tool("query_visits", { group_by: "visitor_hash" })).isError).toBe(true);
    expect((await tool("query_visits", { country: "Narnia" })).isError).toBe(true);
    const sneaky = (await tool("query_visits", { range: "24h", browser: "x' OR '1'='1", page: "/q/%" })).data as any;
    expect(sneaky.total.count).toBe(0);
    expect((await tool("query_visits", { range: "24h", page: "/q/*_" })).data.total.count).toBe(0); // LIKE wildcards in the value are escaped
  });

  it("lists recent visits newest first without identifying data", async () => {
    const rows = (await tool("recent_visits", { range: "24h", page: "/q/*", limit: 3 })).data as any[];
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.time)).toEqual([...rows.map((r) => r.time)].sort().reverse());
    expect(rows[0]).toMatchObject({ type: "event", event: "signup", country: { code: "US", name: "United States" }, browser: "Safari", os: "iOS" });
    const keys = new Set(rows.flatMap((r) => Object.keys(r)));
    for (const forbidden of ["ip", "user_agent", "ua", "visitor_hash"]) expect(keys.has(forbidden)).toBe(false);
    expect(rows.every((r) => typeof r.visitor === "string" && r.visitor.length <= 8)).toBe(true); // a short prefix, never the full hash
    const direct = (await tool("recent_visits", { range: "24h", page: "/q/c" })).data as any[];
    expect(direct[0]).toMatchObject({ source: "(direct)", country: { code: "XX", name: "Unknown" }, browser: "Unknown", os: "Unknown" });
  });
});
