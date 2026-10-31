# Munshi

**An AI teammate that figures out the workflow, does the work, records everything, and asks for help only when it should.**

Built for Paytm Devsemble, Track 3: Autonomous AI Teammates.

> Status: design and early build. Numbers in this document are targets to validate in the demo, not proven results.

---

## What it is

Most support bots answer a question and stop. Munshi behaves more like a junior employee:

- It **understands the case**: who the customer is, what happened before, what they actually need.
- It **decides the workflow itself**. If a customer asks something new, like "my IRCTC refund status", it composes a plan from the tools it has instead of needing a hand-built flow.
- It **takes actions across systems** and keeps **owning the case until it is truly closed**, including chasing banks and partners when deadlines pass.
- It **escalates to a human only when needed**, with a clear summary and a recommendation, and a human can take over or hand back at any time.
- It **gets better with use**. Workflows that were correct, compliant, and liked by customers are saved and reused.

## What it will not do

Munshi only claims actions that Paytm actually controls. For example, a UPI reversal comes from the bank, not from Paytm, so Munshi does not "refund" a UPI payment. It investigates, classifies, raises or follows up the dispute, explains the status honestly, and chases the deadline. The same applies to third parties like IRCTC: Munshi reads status, explains it, and follows up, but does not issue refunds that belong to the railway.

## How it works

1. **Understand.** Triage reads the message and the case history: intent, urgency, sentiment, related cases.
2. **Find a workflow.** Look for a saved workflow that matches. If none, the **planner** composes a new plan from the tool registry.
3. **Validate.** Code checks the plan: every tool exists, inputs are typed, risk levels fit the case, no write step lacks a gate.
4. **Run.** Steps execute one at a time through the **tool gateway**, with a guardrail check before every step that changes something.
5. **Close or wait.** The case closes, or waits on a bank, partner, customer, or human, with a timer to wake it up.
6. **Escalate when needed.** A human gets a summary, a recommendation, and exactly what is needed from them.
7. **Learn.** The outcome is scored. Good plans are saved and ranked. Human overrides are stored with the reason.

## Key design ideas

- **LLMs propose, code enforces.** Models understand, plan, and draft. Deterministic code validates plans, applies rules, and executes. Prompt injection cannot move money because models never execute anything.
- **Postgres is the memory.** Every case is an append-only event log. Any worker can resume any case after a crash.
- **The context window is never the memory.** Each model call gets a prompt rebuilt from the case log under a fixed token budget.
- **Three layers of safety.** A lease stops duplicate work, a fencing epoch rejects stale writers, and idempotency keys protect external side effects.
- **Unknown is not failure.** If a call times out, a reconciler asks the downstream system what happened instead of guessing.
- **Autonomy is earned.** New workflows start human-watched, then run alone for read-only work, then for side effects only after many clean runs.
- **Complexity is earned.** One planner-executor agent first. Specialist agents, multi-hop retrieval, and bigger models are added only when evaluation numbers justify them.
- **Evaluated per component.** Retrieval, planner, tools, guardrails, and escalation each have their own metrics. Failures found in production become new eval scenarios.

## Surfaces

| Surface                 | Purpose                                                                            |
| ----------------------- | ---------------------------------------------------------------------------------- |
| Customer chat and voice | Report an issue by typing or speaking, see honest live status                      |
| Munshi Desk             | Live case queue, full trace of what Munshi did and why, takeover and hand-back     |
| Ops dashboard           | Resolution rate, handling time, escalation reasons, cost per ticket, system health |
| Admin                   | Policy docs, deterministic rules, tool registry, workflow library review           |

## Tech stack (proposed)

| Area                                           | Choice                                                                              |
| ---------------------------------------------- | ----------------------------------------------------------------------------------- |
| Language                                       | TypeScript on Node.js                                                               |
| Source of truth, queue, timers, vectors        | PostgreSQL with pgvector                                                            |
| Cache, rate limits, ephemeral realtime fan-out | Redis                                                                               |
| Realtime                                       | WebSockets via Socket.io                                                            |
| Model access                                   | Provider SDKs with schema validation                                                |
| Agent graphs inside a step                     | LangGraph, optional                                                                 |
| LLM tracing, cost, evals                       | Langfuse                                                                            |
| System metrics and traces                      | OpenTelemetry, Prometheus, Grafana                                                  |
| Frontend                                       | React                                                                               |
| Voice                                          | Sarvam speech-to-text and text-to-speech, streamed through our API from the web app |
| Downstream systems                             | Mock Paytm world with fault injection                                               |

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the reasoning and the open decisions.

## Repository layout

```
munshi/
  apps/
    api/            HTTP and WebSocket gateway
    worker/         case runner, timers, reconciler
    web/            customer chat, Desk, ops dashboard, admin
  packages/
    core/           case log, leases, epochs, state machine
    planner/        plan format, validator, workflow library
    gateway/        tool gateway, idempotency, breakers
    registry/       tool cards and domain packs
    context/        context builder and budgets
    guardrails/     policy engine and risk rules
    mock-world/     bank, UPI, wallet, IRCTC, CRM, tickets, clock
    eslint-config/  shared ESLint configs
    typescript-config/ shared tsconfigs
    ui/             shared React UI stubs for web
  docs/
    policies/       versioned policy documents
  evals/
    scenarios/      labelled offline eval cases
```

## Getting started

### Database and Redis

```sh
cp .env.example .env
# Set DATABASE_URL (Supabase) and REDIS_URL (Redis Cloud) in .env
npm run db:migrate   # apply schema to DATABASE_URL
npm run redis:ping   # should print PONG
```

Optional local Docker: `npm run db:up` (Redis) or `npm run db:up:local` (Postgres + Redis). See [infra/README.md](./infra/README.md).

### API (B2)

```sh
npm run dev:api
# health
curl -s localhost:3001/health
# first message (creates a case)
curl -s -X POST localhost:3001/v1/cases/messages \
  -H 'content-type: application/json' \
  -H 'x-customer-id: customer-soham' \
  -d '{"message":"My IRCTC UPI payment failed","commandId":"cmd-1"}'
```

Demo auth is the `X-Customer-Id` header (`customer-soham`, `customer-aditya`, `customer-saurabh`). A `customerId` in the body is ignored.

### Worker (B3)

```sh
npm run dev:worker
# In another shell, create a message (API above), then the worker claims the case,
# appends an internal worker_step stub event, and clears runnable.
# Inspect: GET /v1/cases/:id with x-customer-id (look for type worker_step)
```

Optional: `WORKER_ID`, `LEASE_MS` (default 30000), `WORKER_POLL_MS` (default 500).

### Tool gateway (B4)

Read tools run through `@repo/gateway` `createInvokeTool` against seeded `mock_*` rows (scoped by session `customerId`). Writes are rejected until B5.

```sh
# Integration tests (requires DATABASE_URL + migrated seed)
npm run test --workspace=@repo/core
npm run test --workspace=@repo/mock-world
npm run test --workspace=@repo/gateway
```

## Demo scenarios

1. **Known workflow, easy case.** Munshi resolves it alone and tells the customer an honest ETA.
2. **A query it has never seen.** Munshi composes a plan from the registry, runs it, and saves the workflow.
3. **Escalation.** A risky or high-value case goes to the Desk with a summary and a recommendation.
4. **Human override.** A human corrects Munshi, and a similar case later reflects the correction.
5. **Deadline chasing.** The virtual clock jumps ahead, a bank deadline passes, and Munshi follows up by itself.
6. **Chaos.** Kill a worker mid-case, time out a downstream call after it executed, replay a duplicate webhook, take the LLM provider down. Show that nothing is duplicated or lost.
7. **Hostile input.** A message or tool result that tries to give Munshi instructions has no effect.
8. **Voice.** A customer speaks in mixed Hindi and English, Munshi answers by voice with details on screen, and an interruption stops it mid-sentence.

## Metrics

Tracked from the event log, so the dashboard and the audit trail always agree:

- Resolution rate without human help
- Average handling time
- Escalation rate and reasons
- Wrong-action rate (target: zero on the eval set)
- Cost per ticket, against a stated baseline assumption
- Customer satisfaction (simulated in the demo)
- Workflow reuse rate
- Voice, on a small fixed audio set: word error rate, time to first audio
- Per-component evals: retrieval precision and recall, groundedness, tool selection accuracy, plan validity, escalation correctness

Targets are pilot targets, to be validated against the eval set and live demo.

## Limitations

- Downstream systems are mocks. Real integrations would need real API contracts, especially status lookup by reference, which the reconciler depends on.
- Policy documents and timelines in the demo are illustrative and must be replaced with Paytm's real rules.
- Planner reliability is the main technical risk and is managed with validation, step caps, and an eval set of unseen queries.
- Exactly-once execution is not claimed. The guarantee is at-least-once execution with idempotent effects.
- Voice uses paid credits, so evals and load tests run on text or a small fixed audio set.
- Volume, latency, language, and corpus-size figures in ARCHITECTURE.md are working assumptions, to be replaced with real ones.

