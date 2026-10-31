import { serve } from "@hono/node-server";
import { createDb } from "@repo/core";
import { createApp } from "./app.js";
import { loadEnv } from "./env.js";

const env = loadEnv();
const db = createDb(env.databaseUrl);
const app = createApp(db);

serve({ fetch: app.fetch, port: env.port }, (info) => {
  console.log(`munshi api listening on http://localhost:${info.port}`);
});
