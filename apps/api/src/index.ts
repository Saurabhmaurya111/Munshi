import { createServer } from "node:http";
import { createDb } from "@repo/core";
import { createApp } from "./app.js";
import { loadEnv } from "./env.js";
import { attachRealtime } from "./realtime.js";

const env = loadEnv();
const db = createDb(env.databaseUrl);
const app = createApp(db);

const server = createServer(async (req, res) => {
  const host = req.headers.host ?? `127.0.0.1:${env.port}`;
  const url = new URL(req.url ?? "/", `http://${host}`);
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) headers.append(key, item);
    } else {
      headers.set(key, value);
    }
  }

  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  const body =
    req.method === "GET" || req.method === "HEAD"
      ? undefined
      : Buffer.concat(chunks);

  const request = new Request(url, {
    method: req.method,
    headers,
    body,
  });

  try {
    const response = await app.fetch(request);
    res.statusCode = response.status;
    response.headers.forEach((value, key) => {
      if (key.toLowerCase() === "transfer-encoding") return;
      res.setHeader(key, value);
    });
    const buf = Buffer.from(await response.arrayBuffer());
    res.end(buf);
  } catch (error) {
    console.error(JSON.stringify({
      msg: "request_failed",
      error: error instanceof Error ? error.message : String(error),
    }));
    res.statusCode = 503;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({
      error: "Service temporarily unavailable",
      code: "UNAVAILABLE",
    }));
  }
});

attachRealtime(server, db);

server.listen(env.port, () => {
  console.log(`munshi api listening on http://localhost:${env.port}`);
});
