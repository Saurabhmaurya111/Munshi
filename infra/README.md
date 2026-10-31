# Infrastructure

## Database

Apps read `DATABASE_URL` from `.env`. Preferred setup is hosted Postgres (Supabase). Local Docker Postgres is optional.

| Target | How |
| --- | --- |
| Supabase (default) | Set `DATABASE_URL` in `.env`, then `npm run db:migrate` |
| Local Docker | `npm run db:up:local` (profile `local-db`). Schema loads from `postgres/init/` on first empty volume |

Local Postgres image: `munshi-postgres:17-pgvector` from `postgres/Dockerfile`.

## Redis

Always local via Compose for now.

| Service | Image | Port |
| --- | --- | --- |
| redis | `public.ecr.aws/docker/library/redis:7-alpine` | 6379 |

## Commands

```sh
cp .env.example .env          # then put your Supabase DATABASE_URL in .env
npm run db:up                 # Redis only
npm run db:migrate            # apply infra/postgres/init/*.sql to DATABASE_URL
npm run db:up:local           # optional local Postgres + Redis
npm run db:down
```

Never commit `.env`. Rotate any password that was pasted into chat or a ticket.
