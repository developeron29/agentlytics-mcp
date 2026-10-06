import { hmacHex } from "./crypto";
import { browserOf, osOf } from "./ua";
import { DAY_MS, siteOf, type Env } from "./env";

const BOT_UA = /bot|crawl|spider|slurp|headless|preview|facebookexternalhit|curl|wget|python-requests|lighthouse/i;
const MAX_PROPS_BYTES = 2048;

export const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "content-type",
};

interface Payload {
  t?: unknown; // "pageview" | "event"
  n?: unknown; // event name
  u?: unknown; // page url
  r?: unknown; // document.referrer
  p?: unknown; // custom props
}

const str = (v: unknown, max: number): string | null => (typeof v === "string" && v.length > 0 ? v.slice(0, max) : null);

function hostOf(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
}

const sameSite = (host: string, domain: string) => host === domain || host.endsWith("." + domain);

// POST /collect from the tracker. Stores one pageview or custom event; nothing that identifies a person is kept.
export async function collect(req: Request, env: Env, now: number): Promise<Response> {
  const ua = req.headers.get("user-agent") ?? "";
  if (BOT_UA.test(ua)) return new Response(null, { status: 204, headers: CORS });

  const ip = req.headers.get("cf-connecting-ip") ?? "";
  if (env.COLLECT_LIMITER && !(await env.COLLECT_LIMITER.limit({ key: ip || "unknown" })).success) {
    return new Response("rate limited", { status: 429, headers: CORS });
  }

  let body: Payload;
  try {
    body = (await req.json()) as Payload; // sendBeacon sends text/plain, so ignore content-type
  } catch {
    return new Response("bad json", { status: 400, headers: CORS });
  }

  const site = siteOf(env);
  let parsed: URL;
  try {
    parsed = new URL(str(body.u, 2048) ?? "");
  } catch {
    return new Response("bad url", { status: 400, headers: CORS });
  }
  // Only your own site's pages are counted, so nobody can fill your analytics from elsewhere.
  if (!sameSite(parsed.hostname.replace(/^www\./, "").toLowerCase(), site.domain)) return new Response("origin mismatch", { status: 403, headers: CORS });

  const type = body.t === "event" ? "event" : "pageview";
  const name = type === "event" ? str(body.n, 100) : null;
  if (type === "event" && !name) return new Response("missing name", { status: 400, headers: CORS });

  let referrerHost = hostOf(str(body.r, 2048));
  if (referrerHost && sameSite(referrerHost, site.domain)) referrerHost = null; // internal navigation

  const props = body.p && typeof body.p === "object" ? JSON.stringify(body.p) : null;
  const propsJson = props && props.length <= MAX_PROPS_BYTES ? props : null;

  // Cookieless visitor id: rotates daily, so it cannot follow people across days. The IP and user agent are never stored.
  const salt = await hmacHex(env.HASH_SECRET, String(Math.floor(now / DAY_MS)));
  const visitor = (await hmacHex(salt, `${site.id}|${ip}|${ua}`)).slice(0, 32);

  const q = parsed.searchParams;
  await env.DB.prepare(
    `INSERT INTO events (site_id, ts, type, name, path, referrer_host, utm_source, utm_medium, utm_campaign, country, visitor_hash, props_json, browser, os)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      site.id,
      now,
      type,
      name,
      parsed.pathname.slice(0, 512),
      referrerHost,
      str(q.get("utm_source"), 100),
      str(q.get("utm_medium"), 100),
      str(q.get("utm_campaign"), 100),
      (req as Request & { cf?: { country?: string } }).cf?.country ?? null,
      visitor,
      propsJson,
      browserOf(ua),
      osOf(ua),
    )
    .run();
  return new Response(null, { status: 202, headers: CORS });
}
