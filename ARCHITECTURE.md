# Munshi: Architecture

This document explains how Munshi is designed and why. It is a design document: choices marked **open** are not settled yet (see the decision log at the end).

## 1. Principles

1. **LLMs propose, code enforces.** Models classify, plan, reason, and draft. They never execute anything. Deterministic code validates, applies rules, and runs side effects.
2. **Postgres is the single source of truth.** Workers, caches, and prompts hold no state that matters.
3. **Cases are event logs.** Nothing is overwritten. Every decision, tool call, and human action is an event.
4. **Assume everything fails.** Workers die, calls time out, webhooks duplicate. The design makes each of these safe, not rare.
5. **Own the case until it is closed**, even when the money or decision sits with another party.
6. **Autonomy is earned**, per workflow, through evidence.
7. **Claim only what Paytm controls.** No action exists for things the bank or a third party owns.

## 2. System overview

```
 Customer chat    Munshi Desk    Ops and admin
        \              |              /
         +------ API + WebSocket gateway ------+
                          |
                      PostgreSQL
        (case_events, cases, leases, timers, queue,
         tool registry, workflow library, policy vectors)
                          |
        +---------- stateless workers (N replicas) ----------+
        | orchestrator | planner | specialists | guardrails   |
        | tool gateway | timer scheduler | reconciler |       |
        | learning loop                                      |
        +-----------------------------------------------------+
              |                    |                 |
        LLM providers     Mock Paytm world     Observability
        (primary +        (bank, UPI, wallet,   (Langfuse, OTel,
         fallback)         IRCTC, CRM, tickets)  Prometheus)
```

Redis exists for cache, rate limits, and ephemeral realtime fan-out only. Losing it loses no case data.

## 3. Case model

A case is an append-only log plus a small snapshot row.

**cases (snapshot):** status, ownership state, lease owner, lease expiry, epoch, `wake_at`, priority, customer reference.

**case_events (log):** customer messages, agent results, plans, policy decisions, tool calls and results, model outputs, human actions, timer firings, summary refreshes. Each event has a sequence number and an audience tag (customer, desk, internal).

**case_facts (ledger):** structured facts such as IDs, amounts, statuses, deadlines, and promises made to the customer. Facts are verified against system data before they count as true.

**action_intents:** one row per external side effect, with a deterministic key. States: intended, sent, confirmed, failed, unknown.

Other tables: tool registry, workflow library with run outcomes, policy chunks with versions and embeddings, human overrides with reasons and embeddings.

Business metrics are SQL views over events, so the dashboard and the audit trail cannot disagree.

### Ownership states

| State            | Lease held | Meaning                                                |
| ---------------- | ---------- | ------------------------------------------------------ |
| AI_ACTIVE        | yes        | A worker is running a step                             |
| WAITING_EXTERNAL | no         | Waiting on a bank, partner, or customer; has `wake_at` |
| PENDING_APPROVAL | no         | Waiting on a human decision                            |
| HUMAN_OWNED      | no         | A human took over                                      |
| CLOSED           | no         | Done                                                   |

A lease is for active work only. Waiting never holds a lease.

## 4. Case lifecycle and the step loop

1. An event arrives (customer message, webhook, timer, human action). It is appended to the log and the case is marked runnable.
2. A worker claims the case using `SKIP LOCKED` and takes the lease, which bumps the epoch.
3. The worker rebuilds context, decides the next step, runs it, and appends the result. Every write checks the epoch.
4. The step ends in one of: closed, waiting on external with a `wake_at`, waiting on approval, handed to a human, or continue.

There is no separate job table. A runnable case is the job.

## 5. Planning and workflows

The base unit is the **tool**, not the agent. Agents from earlier designs become **domain packs**: a bundle of tools, policy documents, and risk rules for one area (UPI, wallet and KYC, merchant, travel, bills).

### Tool registry

Each tool has a name, a one-line description, typed inputs, typed outputs, a risk level (read, write, money-adjacent), the domain pack it belongs to, and a handler. Handlers for third parties (for example an IRCTC status lookup) sit behind the same interface as internal ones.

The planner never sees the whole registry. It sees the top matching **tool cards** for the query and domain. Full schemas load only when a step uses a tool.

### Plans

A plan is a small directed graph of steps. Each step names a registry tool, binds its inputs to ledger facts or earlier step outputs (never to raw customer text), and carries its risk level. Plan length is capped.

### Validation (code, not a model)

- Every tool exists and is allowed for this case
- Inputs and outputs type-check
- Total risk fits what this case and workflow level allow
- No write step lacks a guardrail gate
- No unbounded loops

### Workflow library

When a query arrives, retrieve saved workflows by similarity. If one fits, reuse it. If not, plan from scratch. After a run, score it.

A workflow is saved or promoted only when the outcome was **correct, compliant, and the customer was satisfied**. Satisfaction alone is not enough, since a customer can like an outcome that broke policy.

| Level | Autonomy                                                                         |
| ----- | -------------------------------------------------------------------------------- |
| 0     | Runs with a human watching and approving                                         |
| 1     | Runs alone for read-only workflows                                               |
| 2     | Runs alone with side effects, only after many clean runs (threshold to be tuned) |

Any bad outcome demotes a workflow.

## 6. Guardrails

Guardrails are deterministic code plus a risk check. They act at three points:

1. **Plan time:** is this plan allowed for this case?
2. **Before every step that writes or notifies:** do the facts re-fetched from systems support this action, and are limits and rules satisfied?
3. **Before the customer sees a reply:** no promises Paytm cannot keep, no leaked internals.

The risk check returns allow, block, or escalate. It can never approve. The policy engine has the final say on execution. Policy rules live in code and are not dependent on retrieval.

Amounts and identifiers always come from system data, never from the customer's words.

## 7. Tool gateway

Every side effect passes through one door. In order:

1. Validate the proposal
2. Run guardrails and risk
3. Record the intent
4. Call with a deterministic idempotency key (case ID plus action) and a timeout
5. Record the result

It also provides retries with backoff and jitter, a circuit breaker and bulkhead per downstream system, per-tool rate limits, and PII handling.

A timeout means **unknown**, never failure.

## 8. Concurrency and safety

Three layers, each solving a different problem:

| Layer                 | Protects against                 |
| --------------------- | -------------------------------- |
| Lease (Postgres, TTL) | Two workers doing the same work  |
| Fencing epoch         | A stale worker overwriting state |
| Idempotency key       | Duplicate external side effects  |

- The lease is claimed with one atomic update. The database clock decides expiry.
- Renewals check the epoch, so a dead worker cannot revive its lease.
- Every state write checks the epoch.
- Intent is recorded before the external call, so a retry after a crash reuses the same key.
- A human takeover bumps the epoch, which kills any in-flight AI writes.

A fencing epoch cannot stop a stale worker after it has called an external system. That is why idempotency keys carry the weight for side effects.

## 9. Time

Bank deadlines, SLA timers, and follow-ups are all `wake_at` values on the case. The timer scheduler finds due cases and marks them runnable. Because timers are data in Postgres, deadline chasing survives total restarts.

All deadlines go through a **virtual clock**, so a demo can jump days ahead.

## 10. Reconciler

A periodic job that resolves `unknown` action intents by asking the downstream system for the status of that key, then appends the outcome. It also sweeps for stuck cases. This depends on downstream systems supporting status lookup by reference, which must be confirmed against real integrations.

## 11. Context management

The context window is never the memory. A deterministic **context builder** takes a call type and a case ID and returns a prompt under a fixed token budget. Every build is saved as a manifest of included IDs.

### Slots, in priority order

1. **Pinned:** role, output format, hard rules, injection warnings. Never trimmed.
2. **Facts ledger:** never summarized.
3. **Current input**, plus a "what changed since last run" note after a wake-up.
4. **Recent turns**, verbatim.
5. **Warm summary:** rolling narrative from a small model, saved as a versioned event.
6. **Cold retrieval:** policy chunks, similar workflows with outcome scores, relevant overrides, customer history, each with source IDs and its own budget.

If over budget, drop from the bottom up. If it still does not fit, escalate instead of truncating blindly.

### Per call type

| Call               | Sees                                                               | Skips            |
| ------------------ | ------------------------------------------------------------------ | ---------------- |
| Triage             | Message, short customer snapshot                                   | Tools, history   |
| Planner            | Query, ledger, tool cards, similar workflows, policy, allowed risk | Raw tool outputs |
| Step runner        | The one step, its inputs, needed earlier outputs                   | Everything else  |
| Reasoning          | Ledger, extracted observations, cited policy                       | Raw payloads     |
| Customer reply     | Ledger, decision, tone rules, promises made                        | Internals        |
| Escalation summary | Ledger, event timeline, recommendation                             | Raw payloads     |

### Tool results

Full payloads are stored in the event log. Only extracted observations enter context, with a pointer to the full record. External content is wrapped as untrusted data, separated from instructions. Later steps can fetch more detail on demand.

### Other rules

- Long-lived cases are rebuilt from ledger, summary, recent events, and a delta on wake-up.
- PII is masked in context and restored only at the tool gateway.
- Stable prompt parts come first so provider prompt caching helps.
- Token budgets are set per call type and per case, tuned with the eval set.

## 12. Realtime layer

Two kinds of live data:

- **Durable events** (steps, decisions, messages, takeovers, approvals) are written to `case_events`, then pushed to clients. Fan-out uses Postgres `LISTEN/NOTIFY` carrying only a case ID and sequence number. Each API instance holds a dedicated listener connection outside any transaction-mode pooler.
- **Ephemeral signals** (typing, presence, "Munshi is checking IRCTC") never touch Postgres. They live in memory with a short TTL and fan out across instances through Redis.

Transport is WebSockets (Socket.io proposed), using WebSocket-only transport to avoid sticky sessions. Separate namespaces for customers and the Desk.

- **Resume:** clients send the last sequence number they saw on reconnect, and the server replays the gap from the log. The log is the source of truth, not the library's state recovery.
- **Commands** (customer messages, takeover, approve, hand-back) carry client-generated command IDs so retries cannot run twice. Results come back as durable events.
- **Visibility:** every event has an audience tag, and the customer namespace only ever receives customer-tagged events, enforced on the server.
- **No raw LLM token streaming to customers.** Stream status events while working, then deliver the vetted reply whole.
- **Collisions:** presence and "composing" indicators are polish. The epoch bump on takeover is the safety guarantee.
- Typing and presence updates are throttled. Connections per instance are capped.

## 13. Human layer

- The Desk reads the event log live.
- **Takeover** sets ownership to human and bumps the epoch.
- **Hand-back** appends a note and a new instruction, then makes the case runnable.
- **Approval** moves the case to PENDING_APPROVAL with no lease. Approving appends an event that wakes it.
- **Override** stores the reason and embedding. Similar future cases retrieve it as guidance. Overrides guide the model but never change guardrails.
- Escalation hands over a summary, a recommendation, and the exact thing needed from the human. SLA timers apply to escalations.

## 14. Failure handling

| Failure                           | Result                                                                                 |
| --------------------------------- | -------------------------------------------------------------------------------------- |
| Worker dies mid-step              | Lease expires, another worker resumes from the events                                  |
| Stale worker wakes late           | Its writes are rejected by the epoch check                                             |
| External call times out           | Marked unknown, reconciler checks by key, no duplicate                                 |
| Duplicate or out-of-order webhook | Deduplicated by event ID, applied by sequence                                          |
| Redis lost                        | Cache, rate limits, and ephemeral signals affected; no case data lost                  |
| LLM provider down                 | Fallback provider, then rules-only for simple cases, otherwise escalate with a summary |
| Downstream system slow            | Circuit breaker opens, other work continues, case waits                                |
| Planner produces a bad plan       | Validator rejects it, retry within a cap, then escalate                                |
| Poison case loops                 | Retry cap, then park and escalate                                                      |
| Human takes over mid-run          | Epoch bumps, in-flight AI writes fail                                                  |
| Full restart                      | Cases, timers, and deadlines resume from Postgres                                      |
| Replay                            | Saved model outputs are reused instead of calling the model again                      |

## 15. Scalability

- Workers are stateless and scale horizontally.
- The real limit is LLM throughput and cost, not Postgres. Use a global rate limiter, priority queues, and per-tenant fair claiming. Shed load at intake when saturated.
- Partition `case_events` by time when it grows.
- Honest guarantee: at-least-once execution with idempotent effects. Exactly-once is not claimed.
- Production path for durability: a workflow engine such as Temporal. It is mentioned, not built.

## 16. Observability and evaluation

- **Langfuse** for prompts, responses, tokens, cost, latency, prompt versions, and eval runs. The business audit trail stays in Postgres so the Desk works even if Langfuse is down. PII is masked before anything is sent.
- **OpenTelemetry** traces keyed by case ID, **Prometheus** metrics, **Grafana** dashboards.
- **Eval set:** scripted scenarios covering easy cases, ambiguous cases, fraud signals, angry customers, injection attempts, and queries the system has never seen. Reports resolution rate, wrong-action rate, and escalation correctness. Run automatically.
- **Mock world with fault injection:** random latency, timeouts, 500s, duplicate webhooks, out-of-order callbacks, and "succeeded but the response was lost".
- **Load test** with scripted concurrent cases, reporting throughput and p95 handling time.

## 17. Security and privacy

- Least-privilege tools. A tool is only available to a plan if its pack and risk level are allowed for the case.
- Models never hold credentials. Credentials live in the tool gateway.
- Untrusted content (customer text, partner responses) is always marked as data, never as instructions.
- PII is masked in prompts and in observability exports.
- Everything is auditable from the event log.

## 18. Non-goals

- Issuing refunds that belong to a bank or third party
- Exactly-once execution
- Autonomous money movement without guardrails and the workflow having earned its level
- Streaming unvetted model output to customers

## 19. Decision log

| Topic                         | Current position                                           | Status                                     |
| ----------------------------- | ---------------------------------------------------------- | ------------------------------------------ |
| Language                      | TypeScript everywhere                                      | Open (Python for agent layer is an option) |
| Queue                         | Postgres with `SKIP LOCKED`, no separate job table         | Proposed                                   |
| Redis role                    | Cache, rate limits, ephemeral realtime fan-out             | Proposed; BullMQ not used                  |
| Realtime transport            | WebSockets with Socket.io                                  | Proposed; raw `ws` is the alternative      |
| LangGraph                     | Optional, only inside a step                               | Open                                       |
| LangChain                     | Not used                                                   | Proposed                                   |
| Facts ledger writer           | LLM may propose entries, code verifies against system data | Open                                       |
| Langfuse hosting              | Hosted vs self-hosted                                      | Open                                       |
| Postgres topology             | One instance for the hackathon                             | Proposed                                   |
| Workflow promotion thresholds | Number of clean runs per level                             | To tune with the eval set                  |
| Mock fidelity                 | Mocks must support status lookup by reference              | Needs checking against real systems        |
| Policy content                | Illustrative in the demo, must reflect Paytm's real rules  | Needs real input                           |
