import pg from "pg";

export type Db = pg.Pool;
export type DbClient = pg.PoolClient;

export function createDb(databaseUrl: string): Db {
  return new pg.Pool({
    connectionString: databaseUrl,
    max: 10,
    // Fail fast on unreachable hosted Postgres instead of hanging the API.
    connectionTimeoutMillis: 8_000,
    idleTimeoutMillis: 30_000,
    ssl: databaseUrl.includes("localhost")
      ? undefined
      : { rejectUnauthorized: false },
  });
}

export async function withTransaction<T>(
  db: Db,
  fn: (client: DbClient) => Promise<T>,
): Promise<T> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function checkDb(db: Db): Promise<boolean> {
  try {
    await db.query("SELECT 1");
    return true;
  } catch {
    return false;
  }
}
