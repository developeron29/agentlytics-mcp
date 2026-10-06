import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { resetDb } from "./helpers";

const db = (env as unknown as { DB: D1Database }).DB;
const app = (exports as unknown as { default: Fetcher }).default;
const BROWSER_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";

const worker = (path: string, init?: RequestInit) => app.fetch(new Request(`https://stats.example.com${path}`, init));
const hit = (payload: object, ua = BROWSER_UA) => worker("/collect", { method: "POST", headers: { "user-agent": ua }, body: JSON.stringify(payload) });
const rows = async () => (await db.prepare("SELECT * FROM events ORDER BY id").all<Record<string, unknown>>()).results;

beforeEach(resetDb);

describe("collect", () => {
  it("records a pageview from the site with UTM tags, browser and OS, and no IP or user agent", async () => {
    const res = await hit({ t: "pageview", u: "https://www.example.com/pricing?utm_source=reddit&utm_campaign=launch", r: "https://news.ycombinator.com/item?id=1" });
    expect(res.status).toBe(202);
    const [r] = await rows();
    expect(r).toMatchObject({ site_id: 1, type: "pageview", path: "/pricing", referrer_host: "news.ycombinator.com", utm_source: "reddit", utm_campaign: "launch", browser: "Safari", os: "macOS" });
    expect(String(r!.visitor_hash)).toHaveLength(32);
    expect(JSON.stringify(r)).not.toContain("Mozilla");
  });

  it("records custom events and drops internal referrers", async () => {
    expect((await hit({ t: "event", n: "signup", u: "https://example.com/signup", r: "https://example.com/", p: { plan: "pro" } })).status).toBe(202);
    const [r] = await rows();
    expect(r).toMatchObject({ type: "event", name: "signup", referrer_host: null, props_json: '{"plan":"pro"}' });
    expect((await hit({ t: "event", u: "https://example.com/" })).status).toBe(400); // an event needs a name
  });

  it("ignores other domains and bots", async () => {
    expect((await hit({ t: "pageview", u: "https://notexample.com/" })).status).toBe(403);
    expect((await hit({ t: "pageview", u: "https://example.com/" }, "Googlebot/2.1")).status).toBe(204);
    expect(await rows()).toHaveLength(0);
  });
});

describe("endpoints", () => {
  it("serves the tracker, a status page and a key-protected MCP endpoint", async () => {
    const js = await worker("/t.js");
    expect(js.headers.get("content-type")).toContain("javascript");
    expect(await js.text()).toContain("/collect");
    expect(await (await worker("/")).text()).toContain("running for example.com");
    expect((await worker("/mcp", { method: "POST", body: "{}" })).status).toBe(401);
    const ok = await worker("/mcp", { method: "POST", headers: { authorization: "Bearer rk_test" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    const names = ((await ok.json()) as { result: { tools: { name: string }[] } }).result.tools.map((t) => t.name);
    expect(names).toContain("find_traffic_spikes");
    expect(names).not.toContain("set_public_dashboard");
  });

  it("the hourly job rolls up traffic", async () => {
    await hit({ t: "pageview", u: "https://example.com/" });
    await (exports as unknown as { default: { scheduled: (c: ScheduledController) => Promise<void> } }).default.scheduled?.({ cron: "0 * * * *", scheduledTime: Date.now() } as ScheduledController);
    const r = await db.prepare("SELECT SUM(value) AS n FROM rollup_hourly WHERE metric = 'total'").first<{ n: number }>();
    expect(r!.n).toBe(1);
  });
});
