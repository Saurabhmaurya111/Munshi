export type ApiEnv = {
  databaseUrl: string;
  port: number;
};

export function loadEnv(): ApiEnv {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required");
  }
  const port = Number(process.env.API_PORT ?? "3001");
  if (!Number.isFinite(port) || port <= 0) {
    throw new Error("API_PORT must be a positive number");
  }
  return { databaseUrl, port };
}
