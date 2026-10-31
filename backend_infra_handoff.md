# Backend Infrastructure --- Engineering Handoff

## 1. Purpose

This document defines the scope, interfaces, and implementation expectations for the engineer responsible for the **backend infrastructure** of Munshi.

Munshi is one application. This layer is the parent backend that the agentic layer calls. It authenticates the customer, stores the case, runs workers, and exposes the only door through which a tool can change anything.

Read [ARCHITECTURE.md](./ARCHITECTURE.md) for the reasoning. Read [agentic_ai_engineering_handoff.md](./agentic_ai_engineering_handoff.md) for what the agent engineer owns. Where this document and the agent handoff name the same interface, implement that interface. Do not invent a second one.

## 2. Technology decisions

| Area | Technology |
| --- | --- |
| Language/runtime | TypeScript on Node.js |
| HTTP and WebSocket API | Node.js. Socket.io is the proposed WebSocket transport |
| Database | PostgreSQL, one instance, with `pgvector` |
| Queue | No separate job queue. A runnable case is the job, claimed with `SKIP LOCKED` |
| Cache, rate limits, ephemeral fan-out | Redis. Losing Redis loses no case data |
| Validation | Zod at every boundary |
| Tests | Vitest |
| Traces | OpenTelemetry, one trace per case step, keyed by case id |
| System metrics | Prometheus and Grafana |
| Local dependencies | Postgres, Redis, and Grafana via docker-compose |

Do not add a second database, a Python service, BullMQ, or a workflow engine. Temporal is the later production path. It is not built for this project.

## 3. Scope and ownership

### 3.1 In scope

- HTTP API and WebSocket gateway.
- Authentication of the caller, and construction of trusted customer context. The agent never receives a customer id from the message body.
- Postgres schema, migrations, and SQL views for the business metrics.
- Observability for this layer: OpenTelemetry traces, Prometheus metrics, Grafana, and the audit query over the event log. Model-call traces in Langfuse stay with the agent engineer.
- Case log, facts ledger, action intents, leases, and the fencing epoch.
- Worker process: claim a case, run one step, append the result, release or park the case.
- Timer scheduler and the virtual clock used by the demo.
- Reconciler for `unknown` intents and stuck cases.
- Tool gateway: validation, guardrail hook, idempotency, timeout, circuit breaker, per-tool rate limit.
- Tool handlers for the mock Paytm world: UPI, refunds, recharge, account status, complaints.
- Realtime fan-out of durable events, and replay from the log on reconnect.
- Desk commands: takeover, approve, hand-back. Each command is idempotent.
- Mock-world fault injection: latency, timeouts, duplicate webhooks, lost responses.
- Local development setup: environment variables, migrations, seed data.

### 3.2 Out of scope

The agent engineer owns these. Do not reimplement them here.

- The LangGraph supervisor, intent classification, and specialist agent prompts.
- Choosing which tool to call. The agent proposes. This layer validates and executes.
- RAG chunking, embedding generation, and retrieval ranking. This layer provides the `pgvector` table and a read function.
- Customer chat UI, Munshi Desk UI, and the ops dashboard. This layer provides the APIs and the SQL views they read.
- Langfuse traces of model calls, retrieval scores, and the eval-set runner. This layer passes a correlation id so those traces can be joined to a case.
- Workflow promotion policy. This layer stores the workflow row and its level. The rule for when a level changes is in ARCHITECTURE.md section 6.

## 4. What this layer guarantees

Three mechanisms, each for one failure. Do not add a fourth.

| Mechanism | Protects against | Where it lives |
| --- | --- | --- |
| Lease on the `cases` row, with a TTL | Two workers running the same case | Postgres. The database clock decides expiry |
| Fencing epoch | A stale worker writing after it lost the lease | Checked on every state write |
| Idempotency key, case id plus step | A retry creating a second side effect | `action_intents`, written before the call |

A timeout is `unknown`, not failure. The reconciler, or a human, checks before that step is tried again. This layer does not auto-reverse a payment.

Waiting never holds a lease. A waiting case always has a `wake_at`. A new event while it is waiting marks it runnable again.

## 5. Data model

Implement these tables. Names can be adjusted in a migration, but the columns below are the contract.

### `cases`

Snapshot. One row per conversation.

- `id`. This is the `conversationId` the agent handoff uses. There is no second conversation id.
- `status`, `ownership` (`AI_ACTIVE`, `WAITING_EXTERNAL`, `PENDING_APPROVAL`, `HUMAN_OWNED`, `CLOSED`).
- `lease_owner`, `lease_expires_at`, `epoch`.
- `wake_at`, `priority`, `customer_id`.
- `last_event_seq`.

### `case_events`

Append-only. Nothing in this table is updated.

- `case_id`, `seq` (monotonic per case), `type`, `audience` (`customer`, `desk`, `internal`), `payload`, `created_at`.
- Customer messages, transcripts, plans, tool calls, tool results, model outputs, human actions, timer firings.

### `case_facts`

Current facts only: ids, amounts, statuses, deadlines, promises. Amounts and identifiers are written from tool results, not from the customer message. History of how a fact changed stays in `case_events`.

### `action_intents`

One row per external side effect, inserted before the call.

- `case_id`, `step_id`, `tool`, `idempotency_key` (`case_id` + `step_id`), `state`.
- States: `intended`, `sent`, `confirmed`, `failed`, `unknown`.
- A retry of the same step reuses the row. A genuine later repeat is a new step and a new row.

### Other tables

- `tools`: name, description, input schema, output schema, risk (`read`, `write`, `money`), domain pack, handler name.
- `workflows`: saved plan, level (0, 1, or 2), consecutive clean runs, policy version it was checked against.
- `policy_chunks`: document id, version, content, metadata, embedding. The agent engineer writes the ingestion. This layer owns the table.

Business metrics are SQL views over `case_events`. Do not keep a second counters table.

## 6. Case loop

1. An event arrives: customer message, webhook, timer, or human command. Append it. Mark the case runnable.
2. A worker claims one runnable case with `SELECT ... FOR UPDATE SKIP LOCKED`, sets the lease, and increments `epoch`, in one transaction. The database clock sets `lease_expires_at`.
3. The worker calls the agent package with the case id and the trusted context. The agent returns a structured result. It does not write to Postgres itself.
4. The worker appends the result. Every update to `cases` includes `AND epoch = $held`. Zero rows means the worker lost the case. It stops.
5. The step ends as closed, waiting with a `wake_at`, pending approval, handed to a human, or runnable again.

Renew the lease with the same epoch check. A dead worker cannot refresh a lease it no longer owns. A human takeover increments the epoch, so an in-flight worker's next write fails.

Lease expiry uses the database clock. `wake_at` uses the virtual clock. A demo time jump must not expire a live lease.

## 7. API the agent calls

The agent package is in-process for the first slice. The shape is the same one in the agent handoff, so it can move behind HTTP later without a rewrite.

### Run one turn

Request:

```json
{
  "conversationId": "case-123",
  "message": "My payment failed and my refund is pending.",
  "authenticatedContext": {
    "customerId": "customer-456",
    "roles": ["customer"]
  }
}
```

`authenticatedContext` is built by this layer from the session. The message body is untrusted. A `customerId` inside the message is ignored.

Response:

```json
{
  "conversationId": "case-123",
  "status": "completed",
  "message": "I checked both issues. Here are the verified results.",
  "tasks": [
    {
      "taskId": "task-1",
      "agent": "upi_agent",
      "status": "completed",
      "summary": "Verified payment status."
    }
  ],
  "requiresCustomerInput": false
}
```

The worker persists this response as events before it is sent to the client. The client never sees model output that has not been stored and audience-tagged.

### Context the worker loads for the next turn

Pass the agent the current facts, the recent events, and the new message for that case id. Do not pass a LangGraph checkpoint. There is no checkpointer. A run that dies is not resumed. The next run reads the log.

### Tool invocation

The agent calls one function:

```ts
invokeTool(input: {
  caseId: string;
  stepId: string;
  tool: string;
  args: unknown;
  customerId: string;
}): Promise<ToolResult>
```

`invokeTool` is the gateway in section 8. The agent does not open its own connection to the mock world or to Postgres.

## 8. Tool gateway

Every side effect goes through `invokeTool`, in this order:

1. The tool exists and is allowed for this case, this customer, and this workflow level.
2. Args validate against the tool's Zod schema. Amounts and identifiers must already be facts from a system lookup, not raw customer text.
3. The guardrail hook returns allow, block, or escalate. It cannot approve. A write whose re-check system is down does not proceed.
4. Insert `action_intents` with the idempotency key. If the row already exists, return the recorded result instead of calling again.
5. Call the handler with a timeout.
6. Record `confirmed`, `failed`, or `unknown`.

Retries with backoff apply to transient read failures only. A money-adjacent tool is retried only when that mock (or later, that real system) dedupes on our key. Otherwise `unknown` waits for the reconciler or a human.

The handler receives `customerId` from the session. It must ignore any customer id inside `args`.

### Tools to implement against the mock world

Match these names unless the agent handoff changes them. Read tools return the mock's record. They never invent a status.

| Tool | Risk | Behaviour |
| --- | --- | --- |
| `getTransactions`, `getTransactionStatus`, `getBankReference` | read | UPI payment lookup for this customer |
| `getRefundStatus`, `getRefundDetails` | read | Refund lookup |
| `getRechargeStatus`, `getRechargeDetails` | read | Recharge lookup |
| `getAccountSupportStatus` | read | Account guidance facts. No credential changes |
| `createComplaint`, `getComplaintStatus`, `addComplaintDetails` | write | Complaint on this customer's case |
| `escalateComplaint` | write | Moves the case toward a human |

Do not implement a tool that issues a UPI reversal or a partner refund. Those actions do not exist.

Wallet credit, if implemented for the demo, is `money`. It always stops for approval above the amount threshold, including at workflow level 2.

### Workflow level enforcement

| Level | Gateway behaviour |
| --- | --- |
| 0 | Reads run. Writes and the customer reply are held for approval |
| 1 | Reads and the customer reply run. Writes are held |
| 2 | Low-risk writes run. Money-adjacent still stops above the threshold |

A new workflow starts at level 0. Promotion counts are stored here and decided by the rule in ARCHITECTURE.md: 20 consecutive clean runs to leave level 0, then 20 more on the write path to reach level 2. Those numbers are a starting rule.

## 9. Realtime

Durable events are written to `case_events` first, then pushed. Fan-out uses Postgres `LISTEN/NOTIFY` with the case id and sequence number only. Each API process holds one listener connection outside any transaction-mode pooler.

Ephemeral signals (typing, presence) go through Redis and are never written to Postgres.

- Socket.io, WebSocket transport only, so the API does not need sticky sessions.
- Separate namespaces for the customer and the Desk.
- On reconnect the client sends the last `seq` it saw. The server replays the gap from `case_events`.
- Customer namespace receives `audience = customer` only. Enforce this on the server.
- Commands carry a client-generated id. A retried command returns the original event.
- Do not stream raw model tokens to the customer. Push a status event, then the stored reply.

Voice is a later adapter on the same case. The speech provider key stays on the server. A final transcript is stored as a normal customer event. Text works before voice exists.

## 10. Time, reconciler, and the mock world

`wake_at` holds bank deadlines, follow-ups, and SLA timers. The scheduler marks due cases runnable. Timers survive a process restart because they are rows.

The virtual clock is a single value the demo can move forward. Deadlines read it. Lease expiry does not.

The reconciler runs on a timer. It asks the mock world for the status of each `unknown` intent and appends the outcome. It also flags cases stuck in `AI_ACTIVE` past the lease TTL.

The mock world is a package, not a separate deployed product. It has bank, UPI, wallet, recharge, IRCTC, CRM, and tickets, plus a clock. It must support:

- Status lookup by the idempotency key, so the reconciler can do its job.
- Fault injection: added latency, timeout, HTTP 500, duplicate webhook, and "the call succeeded but the response was lost."

Seed a small fixed set of customers and transactions so the eval set and the demo see the same data. Those rows live in `mock_*` tables (`infra/postgres/init/003_mock_world.sql`): `mock_customers`, `mock_transactions`, `mock_refunds`, `mock_recharges`, `mock_complaints`. Tools read and write only those tables, always scoped by the session `customer_id`.

## 11. Observability

Two records, for two jobs. Do not merge them.

| Record | Answers | Survives Langfuse being down |
| --- | --- | --- |
| `case_events` and the SQL views | What happened to this customer, and the business numbers | Yes. This is the audit trail and the ops dashboard |
| OpenTelemetry trace, keyed by case id | Where the time went: API, claim, tool, reconciler | The trace export can be down. The events are still in Postgres |

Langfuse is the agent engineer's record of model calls, tokens, cost, and prompt version. This layer does not write prompts or completions there.

### Correlation

The API creates a correlation id when a message or command arrives. The worker puts it on the case span and on every `invokeTool` span. Pass the same id into the agent call so a Langfuse trace can be joined back to the case. Log the case id, the correlation id, and the event seq. Do not log the message body.

### What a trace contains

One span for the claim, one for the agent call, one per tool call, one for the append. A tool span records the tool name, duration, retries, and the intent state (`confirmed`, `failed`, `unknown`). Arguments are recorded only after PII masking. A timeout is a span with state `unknown`, not a missing span.

### Metrics

Prometheus counters and histograms, scraped from the API and the worker:

- Cases claimed, lease conflicts, and stale writes rejected by the epoch.
- Tool calls by name and result, including `unknown`.
- Time from `unknown` to reconciled.
- Approval waits, and the share of cases that needed a human this week.
- Reconciler lag and timer lag.

Grafana reads Prometheus. The ops dashboard's business numbers (resolution rate, handling time, escalation rate, cost per case, workflow reuse) come from the SQL views, not from Prometheus. Those two must not be re-implemented as a second store.

### Audit query

Given a case id, Postgres alone can answer:

- Who opened the case, and which customer id the session carried.
- Which tools ran, with which masked arguments, and how each ended.
- Which policy version was recorded on the decision.
- Who approved a write or a money-adjacent action, and when.

If that query needs Langfuse, the audit trail is in the wrong place.

## 12. Security

- Authenticate every HTTP and WebSocket request. A customer session sees only that customer's cases. Desk roles are agent, approver, and admin, checked on the server.
- Secrets live in the environment, never in events, prompts, or the repo.
- Mask PII before any log or trace export. Do not store OTPs, PINs, or full payment credentials.
- Customer text, tool payloads, and retrieved documents are stored as data. They are not concatenated into SQL or into a tool name.

## 13. Suggested layout

Follow the repository layout in the README.

```
apps/api            HTTP, WebSocket, auth, command handling
apps/worker         claim loop, timers, reconciler
packages/core       cases, events, leases, epochs
packages/gateway    invokeTool, intents, breakers
packages/registry   tool cards and schemas
packages/mock-world bank, UPI, wallet, recharge, tickets, clock
```

`packages/planner`, `packages/context`, and `packages/guardrails` are shared with the agent engineer. Agree the function signatures before filling them in. The guardrail hook inside `invokeTool` can return allow for every read in the first milestone, as long as the hook exists and writes still pass through it.

## 14. Milestones

| Milestone | Deliverable |
| --- | --- |
| B1 | Postgres and Redis via docker-compose. Migrations for `cases`, `case_events`, `case_facts`, `action_intents` |
| B2 | Append a customer message as an event. Session builds `authenticatedContext`. A customer id in the body is ignored |
| B3 | Worker claims a case, holds the lease, bumps the epoch, and appends a stub result. A second worker does not claim the same case |
| B4 | `invokeTool` for the read tools, with idempotency and a timeout. Mock world returns seeded UPI, refund, and recharge records |
| B5 | Write tools hold for approval at level 0. Approve and reject commands are idempotent |
| B6 | Timer scheduler and virtual clock. Moving the clock wakes a waiting case. It does not expire a live lease |
| B7 | WebSocket fan-out and resume from the last sequence. Customer sockets do not receive internal events |
| B8 | Reconciler resolves an `unknown` intent by asking the mock world. Takeover bumps the epoch and the in-flight write fails |
| B9 | Fault injection scenarios from the README chaos demo: kill the worker, lose a response, replay a webhook |
| B10 | Complaint tools and the SQL views the ops dashboard will read |
| B11 | OpenTelemetry spans on the claim and on each tool call, Prometheus metrics, Grafana, and the audit query for one case id |

Ship B1 to B4 before the agent graph needs real tools. The agent engineer can use the same `invokeTool` signature against a stub until B4 lands.

## 15. Definition of done

- A customer message becomes an event on a case, scoped to the authenticated customer.
- Two worker processes cannot run the same case.
- A worker killed mid-step is replaced after the lease expires, and the new worker continues from the log.
- A timed-out write stays `unknown` and is not sent a second time until the reconciler or a human resolves it.
- A replayed webhook does not create a second event.
- A customer WebSocket never receives an internal event, and a reconnect replays only the gap.
- Read tools return mock data for the session's customer only.
- No tool exists for a UPI reversal or a partner refund.
- `docker-compose`, migrations, and the seed are enough for another engineer to run the API and the worker locally.
- The commands and the tool names match the agent handoff.
- Given a case id, the audit query answers who opened it, which tools ran, and who approved a write, using Postgres only.
- A tool call produces a span with the case id, the tool name, the duration, and the intent state. A customer message body is not in the span.

## 16. Working rules

1. Postgres is the only memory that survives a process restart.
2. The agent proposes. This layer validates, authorizes, and executes.
3. Record the intent before the call.
4. A customer id comes from the session.
5. Prefer a small schema that matches this document over a table for every edge case.
6. If a failure is rarer than a crash, a timeout, or a duplicate webhook, send the case to a human. Do not build a new mechanism for it.
