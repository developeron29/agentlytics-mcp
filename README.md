# agentlytics-mcp

**Website analytics your AI agent can read.** A small, cookieless analytics server for one website, with an [MCP](https://modelcontextprotocol.io) server built in, so Claude Code, Cursor or Codex can look at your traffic and help you decide what to do next.

You deploy it to your own Cloudflare account (Workers + D1, the free tier is enough for most small sites). Your data stays in your account.

> Don't want to run it yourself? **[measuremy.site](https://measuremy.site/?utm_source=github&utm_medium=referral&utm_campaign=agentlytics-mcp)** is the hosted version: same MCP tools, plus a dashboard, AI explanations of traffic spikes, tracking of posts that mention you (Hacker News, Bluesky, YouTube...), alerts and weekly summaries. Free for 10,000 pageviews a month.

## What your agent can do

Ask in plain words, for example:

- "Why did traffic jump yesterday?" It finds the spike and the source, page or event behind it.
- "Where do people drop off between the homepage and signup?" It builds a funnel and shows the biggest drop.
- "What's working, and what should I post next?" It ranks channels by conversions and turns that into steps.
- "Make a tracked link for my Reddit post, and check how it did next week."

Tools exposed over MCP:

| Area | Tools |
|---|---|
| Traffic | `get_overview`, `get_timeseries`, `top_sources`, `top_pages`, `top_countries`, `top_browsers`, `top_systems`, `list_events` |
| Questions about visits | `query_visits` (filter and group by country, browser, OS, source, page, event, day), `recent_visits` |
| Spikes | `find_traffic_spikes`, `explain_spike` (ranked causes, plus your annotations) |
| Funnels | `create_funnel`, `get_funnel`, `delete_funnel` |
| Growth | `get_whats_working`, `get_growth_actions` |
| Campaigns | `create_tracked_link`, `get_campaign_results`, `add_annotation` |

Plus a `plan_marketing` prompt that walks the agent through a data-backed plan.

## Privacy

- No cookies and nothing stored in the visitor's browser.
- No IP address or user agent is stored. A visitor id is a hash that changes every day, so nobody can be followed from one day to the next.
- Only browser and OS names (like "Firefox", "macOS") and the country Cloudflare reports are kept.
- Raw events are deleted after 400 days; hourly totals are kept.

Check what applies where you and your visitors are; this is not legal advice.

## Deploy

### One click

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/developeron29/agentlytics-mcp)

The button copies this repo to your GitHub account, creates the D1 database, runs the migrations and deploys the worker. It asks for three settings:

- `SITE_DOMAIN`: your website's domain, like `example.com` (no `https://` or `www`)
- `HASH_SECRET`: any long random string, used to make the daily visitor id
- `MCP_READ_KEY`: another long random string, the key your AI agent uses

Generate the two random values with `openssl rand -hex 32`, and keep `MCP_READ_KEY` for connecting your agent below.

### By hand

You need a Cloudflare account and Node.js 20+.

```sh
git clone https://github.com/developeron29/agentlytics-mcp.git
cd agentlytics-mcp
npm install
npx wrangler login
```

1. **Create the database** and paste the printed `database_id` into `wrangler.jsonc`:

   ```sh
   npx wrangler d1 create agentlytics-mcp
   ```

2. **Set the three settings.** Use long random values for the two keys, for example from `openssl rand -hex 32`:

   ```sh
   npx wrangler secret put SITE_DOMAIN     # e.g. example.com
   npx wrangler secret put HASH_SECRET     # makes the daily visitor id; never share it
   npx wrangler secret put MCP_READ_KEY    # the key your agent uses; keep it out of your repo
   ```

   Wrangler may offer to create the worker on the first `secret put`; say yes.

3. **Deploy** (this also creates the tables):

   ```sh
   npm run deploy
   ```

Either way you get a worker URL like `https://agentlytics-mcp.<you>.workers.dev`. Opening it shows a status page with your domain. You can attach a custom domain such as `stats.yourdomain.com` in the Cloudflare dashboard.

**Optional rate limit:** to cap how often one IP can send hits, add this to `wrangler.jsonc` and deploy again:

```jsonc
"ratelimits": [{ "name": "COLLECT_LIMITER", "namespace_id": "1001", "simple": { "limit": 120, "period": 60 } }]
```

## Add the tracker to your site

Put this in the `<head>` of every page:

```html
<script defer src="https://YOUR-WORKER-URL/t.js"></script>
```

It counts pageviews, including client-side navigation in single-page apps. To count something that matters, like a signup:

```js
agentlytics.track("signup", { plan: "pro" });
```

or without JavaScript, on any element:

```html
<button data-agentlytics-event="cta_click">Start free</button>
```

Only pages on `SITE_DOMAIN` (and its subdomains) are counted.

## Connect your agent

**Claude Code**

```sh
claude mcp add --scope user --transport http agentlytics https://YOUR-WORKER-URL/mcp --header "Authorization: Bearer YOUR_MCP_READ_KEY"
```

**Cursor** (`.cursor/mcp.json` or `~/.cursor/mcp.json`)

```json
{
  "mcpServers": {
    "agentlytics": {
      "url": "https://YOUR-WORKER-URL/mcp",
      "headers": { "Authorization": "Bearer YOUR_MCP_READ_KEY" }
    }
  }
}
```

**Codex** (`~/.codex/config.toml`)

```toml
[mcp_servers.agentlytics]
url = "https://YOUR-WORKER-URL/mcp"
bearer_token_env_var = "AGENTLYTICS_READ_KEY"
```

and `export AGENTLYTICS_READ_KEY=YOUR_MCP_READ_KEY` in the shell that starts Codex.

Then ask: *"Use agentlytics to tell me how my site did this week."* Spikes need a few days of traffic to compare against.

### Let your agent do the setup

Point your coding agent at [`AGENTS.md`](AGENTS.md): "Deploy agentlytics-mcp for my site by following AGENTS.md". It walks through every step and asks you before anything that needs your Cloudflare login.

## Self-hosted or hosted?

| | agentlytics-mcp (this repo) | [measuremy.site](https://measuremy.site/pricing?utm_source=github&utm_medium=referral&utm_campaign=agentlytics-mcp) |
|---|---|---|
| MCP tools for your agent | Yes | Yes |
| Cookieless tracking, funnels, spikes, campaigns | Yes | Yes |
| Sites | One per deploy | Several, one account |
| Dashboard | No (ask your agent) | Yes, with filters and a public share link |
| AI explanations of spikes | No | Yes |
| Posts that mention you (HN, Lobsters, Bluesky, YouTube, Reddit) | No | Yes, on your traffic chart |
| Alerts, weekly email summary | No | Yes |
| Who runs it | You, on your Cloudflare account | Us |
| Price | Free (your Cloudflare usage) | Free up to 10,000 pageviews a month, then paid plans |

## Develop

```sh
cp .dev.vars.example .dev.vars   # then edit the values
npm run db:migrate:local
npx wrangler dev
npm test
npm run typecheck
```

## License

MIT. See [LICENSE](LICENSE).
