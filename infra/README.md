# Infrastructure

## Database

Apps read `DATABASE_URL` from `.env`. Preferred setup is hosted Postgres (Supabase). Local Docker Postgres is optional.

| Target | How |
| --- | --- |
| Supabase (default) | Set `DATABASE_URL` in `.env`, then `npm run db:migrate` |
| Local Docker | `npm run db:up:local` (profile `local-db`). Schema loads from `postgres/init/` on first empty volume |

Local Postgres image: `munshi-postgres:17-pgvector` from `postgres/Dockerfile`.

| Script | Contents |
| --- | --- |
| `001_extensions.sql` | `vector`, `pgcrypto` |
| `002_schema.sql` | Case runtime: cases, events, facts, intents, tools, workflows, policy_chunks |
| `003_mock_world.sql` | Demo source systems: customers, transactions, refunds, recharges, complaints + seed rows |
| `004_mock_wallet.sql` | Paytm wallet balances, wallet-channel payments, wallet-bound refunds + seed rows |

Mock tables are what `getTransactions` / `getRefundStatus` / etc. read. They are not a real bank ledger. No OTPs, PINs, or full credentials.

## Redis

Apps read `REDIS_URL` from `.env`. Preferred setup is hosted Redis (Redis Cloud). Local Docker Redis is optional.

| Target | How |
| --- | --- |
| Redis Cloud (default) | Set `REDIS_URL` in `.env`, then `npm run redis:ping` |
| Local Docker | `npm run db:up` (Compose Redis on `REDIS_PORT`) |

## Commands

```sh
cp .env.example .env          # then set DATABASE_URL and REDIS_URL
npm run db:migrate            # apply schema to DATABASE_URL
npm run redis:ping            # check REDIS_URL
npm run db:up                 # optional local Redis
npm run db:up:local           # optional local Postgres + Redis
npm run db:down
```

Never commit `.env`. Rotate any password that was pasted into chat or a ticket.
