/**
 * Vercel Services entry for the Hono API (HTTP only).
 * Local/dev continues to use `src/index.ts` (Node HTTP + Socket.io).
 */
import { createDb } from "@repo/core";
import { createApp } from "./app.js";
import { loadEnv } from "./env.js";

const env = loadEnv();
const db = createDb(env.databaseUrl);

export default createApp(db);
