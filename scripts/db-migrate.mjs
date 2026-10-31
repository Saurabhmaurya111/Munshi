#!/usr/bin/env node
/**
 * Apply infra/postgres/init/*.sql against DATABASE_URL.
 * Init scripts are idempotent (IF NOT EXISTS / ON CONFLICT).
 * Resolves the host to an address first so IPv6-only hosts (common on
 * Supabase direct connections) still work when the local resolver is weak.
 */
import { readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { lookup } from "node:dns/promises";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  console.error("DATABASE_URL is not set. Copy .env.example to .env first.");
  process.exit(1);
}

function digAddress(name, type) {
  const result = spawnSync("dig", ["+short", type, name], { encoding: "utf8" });
  if (result.status !== 0) return null;
  const line = result.stdout
    .split("\n")
    .map((value) => value.trim())
    .find((value) => value && !value.endsWith("."));
  return line ?? null;
}

async function resolveHost(hostname) {
  try {
    return (await lookup(hostname, { family: 6 })).address;
  } catch {
    // continue
  }
  try {
    return (await lookup(hostname, { family: 4 })).address;
  } catch {
    // continue
  }
  return digAddress(hostname, "AAAA") ?? digAddress(hostname, "A");
}

const url = new URL(databaseUrl);
const host = url.hostname;
const hostaddr = await resolveHost(host);

if (!hostaddr) {
  console.error(`Could not resolve ${host}`);
  process.exit(1);
}

const env = {
  ...process.env,
  PGHOST: host,
  PGHOSTADDR: hostaddr,
  PGPORT: url.port || "5432",
  PGUSER: decodeURIComponent(url.username),
  PGPASSWORD: decodeURIComponent(url.password),
  PGDATABASE: url.pathname.replace(/^\//, "") || "postgres",
  PGSSLMODE: url.searchParams.get("sslmode") || "require",
};

const initDir = join(root, "infra/postgres/init");
const files = readdirSync(initDir)
  .filter((name) => name.endsWith(".sql"))
  .sort();

console.log(`Migrating ${host} (${hostaddr})...`);

for (const file of files) {
  const path = join(initDir, file);
  console.log(`Applying ${file}...`);
  const result = spawnSync("psql", ["-v", "ON_ERROR_STOP=1", "-f", path], {
    stdio: "inherit",
    env,
  });
  if (result.status !== 0) {
    console.error(`Failed on ${file}`);
    process.exit(result.status ?? 1);
  }
}

console.log("Migrations applied.");
