#!/usr/bin/env node
import { createClient } from "redis";

const url = process.env.REDIS_URL;
if (!url) {
  console.error("REDIS_URL is not set. Copy .env.example to .env first.");
  process.exit(1);
}

const parsed = new URL(url);
const client = createClient({
  url,
  socket: {
    connectTimeout: 10_000,
    // Redis Cloud often needs TLS on the public endpoint.
    ...(parsed.protocol === "rediss:" ? { tls: true } : {}),
  },
});

client.on("error", (error) => {
  console.error("Redis error:", error.message);
});

try {
  await client.connect();
  const pong = await client.ping();
  console.log(pong);
  await client.quit();
} catch (error) {
  console.error("redis:ping failed:", error.message);
  console.error(
    "Tip: if Redis Cloud requires TLS, set REDIS_URL to start with rediss://",
  );
  try {
    await client.quit();
  } catch {
    // ignore
  }
  process.exit(1);
}
