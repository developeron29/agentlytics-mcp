import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { env } from "cloudflare:workers";

const testEnv = env as unknown as { DB: D1Database; TEST_MIGRATIONS: D1Migration[] };
await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
