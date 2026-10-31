# Infrastructure

Local services for Munshi.

## Services

| Service  | Image                              | Port | Purpose                          |
| -------- | ---------------------------------- | ---- | -------------------------------- |
| postgres | `munshi-postgres:17-pgvector` (local build) | 5432 | Cases, events, vectors  |
| redis    | `public.ecr.aws/docker/library/redis:7-alpine` | 6379 | Cache, rate limits, ephemeral fan-out |

Postgres is built from `postgres/Dockerfile` (official Postgres 17 plus the `pgvector` package). Init scripts in `postgres/init/` run once when the data volume is empty.

## Commands

From the repo root:

```sh
cp .env.example .env   # first time only
npm run db:up
npm run db:psql        # interactive shell
npm run db:down
```

`DATABASE_URL` and `REDIS_URL` in `.env` are what the apps will use.
