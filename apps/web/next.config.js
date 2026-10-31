import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Load monorepo root .env into process.env (NEXT_PUBLIC_* for the browser).
const rootEnvPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../.env",
);

try {
  const raw = fs.readFileSync(rootEnvPath, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
} catch {
  // Root .env is optional for builds that inject env another way.
}

/** @type {import('next').NextConfig} */
const nextConfig = {};

export default nextConfig;
