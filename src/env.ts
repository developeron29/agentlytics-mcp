export interface Env {
  DB: D1Database;
  // Your website's domain, without https:// or www, e.g. "example.com". Visits from other domains are ignored.
  SITE_DOMAIN: string;
  // Secret used to make the daily-rotating visitor id. Any long random string; never share it.
  HASH_SECRET: string;
  // The key your AI agent sends as "Authorization: Bearer <key>" to read your analytics over MCP.
  MCP_READ_KEY: string;
  // Optional per-IP rate limit on /collect (see wrangler.jsonc). Without it, every request is accepted.
  COLLECT_LIMITER?: RateLimit;
}

// One site per deploy. The site_id column is kept in every table so the schema matches the hosted version at measuremy.site.
export const SITE_ID = 1;

export interface Site {
  id: number;
  domain: string;
}

export const siteOf = (env: Env): Site => ({ id: SITE_ID, domain: (env.SITE_DOMAIN ?? "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "") });

export const HOSTED_URL = "https://measuremy.site";
export const HOUR_MS = 3_600_000;
export const DAY_MS = 24 * HOUR_MS;
