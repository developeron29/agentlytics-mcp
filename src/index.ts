import { CORS, collect } from "./collect";
import { HOSTED_URL, HOUR_MS, SITE_ID, siteOf, type Env } from "./env";
import { handleMcp } from "./mcp";
import { pruneEvents } from "./retention";
import { rollup } from "./rollup";
import { detectSpikes } from "./spikes";
import { TRACKER_JS } from "./tracker";

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const { pathname, origin } = new URL(req.url);
    const now = Date.now();

    if (pathname === "/t.js" && req.method === "GET") {
      return new Response(TRACKER_JS, { headers: { "content-type": "application/javascript; charset=utf-8", "cache-control": "public, max-age=3600" } });
    }
    if (pathname === "/collect") {
      if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
      if (req.method === "POST") return collect(req, env, now);
    }
    if (pathname === "/mcp") return handleMcp(req, env, now);
    if (pathname === "/" && req.method === "GET") {
      const site = siteOf(env);
      return new Response(
        `agentlytics-mcp is running for ${site.domain || "(SITE_DOMAIN is not set)"}.

Tracker:  <script defer src="${origin}/t.js"></script>
MCP:      ${origin}/mcp  (Authorization: Bearer <MCP_READ_KEY>)

Setup and source: https://github.com/developeron29/agentlytics-mcp
Want a dashboard, AI spike explanations and mention tracking without running a server? ${HOSTED_URL}
`,
        { headers: { "content-type": "text/plain; charset=utf-8" } },
      );
    }
    return new Response("not found", { status: 404 });
  },

  // Hourly: rebuild the last 48 hours of rollups (absorbs late events), find spikes, and delete raw events past retention.
  async scheduled(_event: ScheduledController, env: Env): Promise<void> {
    const now = Date.now();
    await rollup(env.DB, now - 48 * HOUR_MS, now);
    const first = await env.DB.prepare("SELECT MIN(hour) AS h FROM rollup_hourly WHERE site_id = ?").bind(SITE_ID).first<{ h: number | null }>();
    if (first?.h != null) await detectSpikes(env.DB, SITE_ID, first.h, now);
    await pruneEvents(env.DB, SITE_ID, now);
  },
} satisfies ExportedHandler<Env>;
