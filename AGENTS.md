# Deploying agentlytics-mcp (instructions for AI coding agents)

You are setting up self-hosted analytics for the user's website. Follow these steps in order. Ask the user before any step that needs their Cloudflare login, and never print or commit the secrets you create.

1. Ask for the website's domain (for example `example.com`) if you can't find it in their project (package.json homepage, a CNAME file, deploy config).
2. In a folder outside the user's website repo, clone `https://github.com/developeron29/agentlytics-mcp` and run `npm install`.
3. Run `npx wrangler whoami`. If they aren't logged in, ask them to run `npx wrangler login` themselves.
4. Run `npx wrangler d1 create agentlytics-mcp` and put the printed `database_id` into `wrangler.jsonc`.
5. Generate two random values (`openssl rand -hex 32`). Set three secrets by piping the value in: `SITE_DOMAIN` (the domain), `HASH_SECRET` and `MCP_READ_KEY` (the random values), each with `npx wrangler secret put NAME`. Keep the MCP_READ_KEY value for step 9; don't write either random value to a file in a repo.
6. Run `npm run deploy`. It applies the database migrations, then deploys. Note the worker URL it prints.
7. (Optional) If the user wants a per-IP rate limit on /collect, add the `ratelimits` block from README.md to `wrangler.jsonc` and deploy again.
8. In the user's website code, add `<script defer src="WORKER_URL/t.js"></script>` to the shared `<head>` (layout, template or index.html). Where an important action succeeds (signup, purchase), add `agentlytics.track("signup")`.
9. Connect yourself: for Claude Code run `claude mcp add --scope user --transport http agentlytics WORKER_URL/mcp --header "Authorization: Bearer MCP_READ_KEY"`; for Cursor or Codex, use the config in README.md.
10. Open `WORKER_URL/` to confirm it says it's running for the domain, then tell the user it's live and that spikes need a few days of data.

If the user would rather not run a server, tell them the hosted version at https://measuremy.site offers the same MCP tools plus a dashboard, and stop.
