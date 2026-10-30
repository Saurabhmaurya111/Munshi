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
8. **Complexity must be earned.** Start with the simplest design that works, and add parts (specialist agents, multi-hop retrieval, bigger models) only when evaluation numbers justify them.

## 2. Scope and assumptions

Design choices follow from these. The figures are working assumptions, to be replaced with real ones.

### Who, what, and how much agency

- **User:** Paytm customers and merchants with a payment, wallet, KYC, settlement, or partner-service issue (for example a train booking made through Paytm).
- **Problem:** many requests are repetitive status checks and explanations, yet cases are long-running because they wait on banks and partners, and customers repeat their story at every handoff.
- **Outcome:** more routine cases resolved without a human, with correct and policy-compliant results, shorter handling time, and fewer repeat contacts.
- **What the AI handles:** understanding the case, investigating, explaining, raising and chasing disputes and tickets, wallet actions that Paytm owns, notifying the customer, and escalating.
- **What it does not handle:** anything the bank or a third party owns.

Agency is set by the risk of the action, and then earned per workflow (see section 6):

| Risk class | Examples | Autonomy |
|---|---|---|
| Read-only | Status lookups, policy retrieval | Autonomous once the workflow reaches level 1 |
| Low-risk write | Create a ticket, notify the customer, set a follow-up | Guardrail gate on every call; autonomous at level 2 |
| Money-adjacent | Wallet credit or reversal, filing a dispute for a customer | Guardrails plus risk check; amount thresholds route to human approval |
| Not available | UPI reversals, partner refunds | No tool exists |

### Working assumptions

| Bucket | Assumption |
|---|---|
| Data | A few hundred versioned policy and FAQ documents for the demo. Mostly English, with Hindi queries expected. Case history comes from the event log. |
| Inputs | Short messages. Some are about meaning ("my money is stuck"), others contain exact identifiers (transaction IDs, booking references). Usually one policy document is enough to decide. |
| Operating | Thousands of cases per day as the design target. First acknowledgement within seconds, a status answer within a few seconds. Full resolution can take days because it waits on external parties, so latency targets apply to each step, not to case closure. Traffic spikes are queued, not dropped. |
| Action risk | As in the table above. |

If evals show that decisions often need several documents, retrieval gets revisited (section 12).

## 3. System overview

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

## 4. Case model

A case is an append-only log plus a small snapshot row.

**cases (snapshot):** status, ownership state, lease owner, lease expiry, epoch, `wake_at`, priority, customer reference.

**case_events (log):** customer messages, agent results, plans, policy decisions, tool calls and results, model outputs, human actions, timer firings, summary refreshes. Each event has a sequence number and an audience tag (customer, desk, internal).

**case_facts (ledger):** structured facts such as IDs, amounts, statuses, deadlines, and promises made to the customer. Facts are verified against system data before they count as true.

**action_intents:** one row per external side effect, with a deterministic key. States: intended, sent, confirmed, failed, unknown.

Other tables: tool registry, workflow library with run outcomes, policy chunks with versions and embeddings, human overrides with reasons and embeddings.

Business metrics are SQL views over events, so the dashboard and the audit trail cannot disagree.

### Ownership states

| State | Lease held | Meaning |
|---|---|---|
| AI_ACTIVE | yes | A worker is running a step |
| WAITING_EXTERNAL | no | Waiting on a bank, partner, or customer; has `wake_at` |
| PENDING_APPROVAL | no | Waiting on a human decision |
| HUMAN_OWNED | no | A human took over |
| CLOSED | no | Done |

A lease is for active work only. Waiting never holds a lease.

## 5. Case lifecycle and the step loop

1. An event arrives (customer message, webhook, timer, human action). It is appended to the log and the case is marked runnable.
2. A worker claims the case using `SKIP LOCKED` and takes the lease, which bumps the epoch.
3. The worker rebuilds context, decides the next step, runs it, and appends the result. Every write checks the epoch.
4. The step ends in one of: closed, waiting on external with a `wake_at`, waiting on approval, handed to a human, or continue.

There is no separate job table. A runnable case is the job.

## 6. Planning and workflows

The base unit is the **tool**, not the agent. Agents from earlier designs become **domain packs**: a bundle of tools, policy documents, and risk rules for one area (UPI, wallet and KYC, merchant, travel, bills).

### Agent topology

Start with **one planner-executor agent** that uses the tool registry. Domain packs are only bundles of tools and policies it draws from.

Specialist agents (UPI, wallet and KYC, merchant, travel) are added only when evals show one agent is overloaded: too many tools in context, falling tool-selection accuracy, or conflicting policies across domains. Each specialist must earn its place with numbers. When added, specialists run in parallel under the orchestrator, return typed results with citations, and propose actions without executing them.

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

| Level | Autonomy |
|---|---|
| 0 | Runs with a human watching and approving |
| 1 | Runs alone for read-only workflows |
| 2 | Runs alone with side effects, only after many clean runs (threshold to be tuned) |

Any bad outcome demotes a workflow.

## 7. Guardrails

Guardrails are deterministic code plus a risk check. They act at three points:

1. **Plan time:** is this plan allowed for this case?
2. **Before every step that writes or notifies:** do the facts re-fetched from systems support this action, and are limits and rules satisfied?
3. **Before the customer sees a reply:** no promises Paytm cannot keep, no leaked internals.

The risk check returns allow, block, or escalate. It can never approve. The policy engine has the final say on execution. Policy rules live in code and are not dependent on retrieval.

Amounts and identifiers always come from system data, never from the customer's words.

## 8. Tool gateway

Every side effect passes through one door. In order:

1. Validate the proposal
2. Run guardrails and risk
3. Record the intent
4. Call with a deterministic idempotency key (case ID plus action) and a timeout
5. Record the result

It also provides retries with backoff and jitter, a circuit breaker and bulkhead per downstream system, per-tool rate limits, and PII handling.

**Permissions are enforced here, not in the prompt.** Each tool gets least-privilege access. Any tool that touches customer data is scoped to the authenticated customer or merchant of that case, and a plan cannot widen that scope. Higher-consequence tools sit behind deterministic policy and human approval.

A timeout means **unknown**, never failure.

## 9. Concurrency and safety

Three layers, each solving a different problem:

| Layer | Protects against |
|---|---|
| Lease (Postgres, TTL) | Two workers doing the same work |
| Fencing epoch | A stale worker overwriting state |
| Idempotency key | Duplicate external side effects |

- The lease is claimed with one atomic update. The database clock decides expiry.
- Renewals check the epoch, so a dead worker cannot revive its lease.
- Every state write checks the epoch.
- Intent is recorded before the external call, so a retry after a crash reuses the same key.
- A human takeover bumps the epoch, which kills any in-flight AI writes.

A fencing epoch cannot stop a stale worker after it has called an external system. That is why idempotency keys carry the weight for side effects.

## 10. Time

Bank deadlines, SLA timers, and follow-ups are all `wake_at` values on the case. The timer scheduler finds due cases and marks them runnable. Because timers are data in Postgres, deadline chasing survives total restarts.

All deadlines go through a **virtual clock**, so a demo can jump days ahead.

## 11. Reconciler

A periodic job that resolves `unknown` action intents by asking the downstream system for the status of that key, then appends the outcome. It also sweeps for stuck cases. This depends on downstream systems supporting status lookup by reference, which must be confirmed against real integrations.

## 12. Knowledge, retrieval and memory

### Retrieval

- **Hybrid retrieval** over versioned policy chunks: vector search (pgvector) for meaning plus keyword search (Postgres full-text) for exact identifiers and error codes. Results are merged and **reranked**, and only the top chunks reach the model.
- **Single-hop first.** One document is usually enough, so no graph-style or multi-hop retrieval until evals show cross-document questions.
- Customer-specific facts never come through retrieval. They come from system lookups.
- Every chunk carries a source ID, version, and effective date. Answers cite them, and each decision records which policy version it used.

### Freshness: policy ingestion pipeline

Detect changed documents (version bump or content hash), re-parse, re-chunk, re-embed only what changed, write as a new version, and switch the index atomically. Old versions are kept for replay and audit. A scheduled job flags documents past their review date. Without this, retrieval can be correct and still return outdated rules.

### Memory model

| Type | In Munshi | Used |
|---|---|---|
| Working | Current case: facts ledger, recent turns, tool observations | Yes |
| Semantic | Stable customer or merchant facts (account type, KYC status), read from source systems with short caching, not copied as a second truth | Yes |
| Episodic | Earlier cases and what was done, from the event log, so actions are not repeated and repeat contacts are recognised | Yes |
| Procedural | Workflow library and human overrides | Yes, and a differentiator |

## 13. Context management

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

| Call | Sees | Skips |
|---|---|---|
| Triage | Message, short customer snapshot | Tools, history |
| Planner | Query, ledger, tool cards, similar workflows, policy, allowed risk | Raw tool outputs |
| Step runner | The one step, its inputs, needed earlier outputs | Everything else |
| Reasoning | Ledger, extracted observations, cited policy | Raw payloads |
| Customer reply | Ledger, decision, tone rules, promises made | Internals |
| Escalation summary | Ledger, event timeline, recommendation | Raw payloads |

### Tool results

Full payloads are stored in the event log. Only extracted observations enter context, with a pointer to the full record. External content is wrapped as untrusted data, separated from instructions. Later steps can fetch more detail on demand.

### Other rules

- Long-lived cases are rebuilt from ledger, summary, recent events, and a delta on wake-up.
- PII is masked in context and restored only at the tool gateway.
- Stable prompt parts come first so provider prompt caching helps.
- Token budgets are set per call type and per case, tuned with the eval set.

## 14. Realtime layer

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

## 15. Human layer

- The Desk reads the event log live.
- **Takeover** sets ownership to human and bumps the epoch.
- **Hand-back** appends a note and a new instruction, then makes the case runnable.
- **Approval** moves the case to PENDING_APPROVAL with no lease. Approving appends an event that wakes it.
- **Override** stores the reason and embedding. Similar future cases retrieve it as guidance. Overrides guide the model but never change guardrails.
- Escalation hands over a summary, a recommendation, and the exact thing needed from the human. SLA timers apply to escalations.

## 16. Failure handling

| Failure | Result |
|---|---|
| Worker dies mid-step | Lease expires, another worker resumes from the events |
| Stale worker wakes late | Its writes are rejected by the epoch check |
| External call times out | Marked unknown, reconciler checks by key, no duplicate |
| Duplicate or out-of-order webhook | Deduplicated by event ID, applied by sequence |
| Redis lost | Cache, rate limits, and ephemeral signals affected; no case data lost |
| LLM provider down | Fallback provider, then rules-only for simple cases, otherwise escalate with a summary |
| Downstream system slow | Circuit breaker opens, other work continues, case waits |
| Planner produces a bad plan | Validator rejects it, retry within a cap, then escalate |
| Poison case loops | Retry cap, then park and escalate |
| Human takes over mid-run | Epoch bumps, in-flight AI writes fail |
| Full restart | Cases, timers, and deadlines resume from Postgres |
| Replay | Saved model outputs are reused instead of calling the model again |

## 17. Scalability

- Workers are stateless and scale horizontally.
- The real limit is LLM throughput and cost, not Postgres. Use a global rate limiter, priority queues, and per-tenant fair claiming. Shed load at intake when saturated.
- Partition `case_events` by time when it grows.
- Honest guarantee: at-least-once execution with idempotent effects. Exactly-once is not claimed.
- Production path for durability: a workflow engine such as Temporal. It is mentioned, not built.

### Latency budget

Latency targets apply to each step, not to case closure. Split the budget across context and retrieval, planning (skipped when a saved workflow matches), tool calls, guardrails, and reply composition. Use traces to find the slowest stage and optimize it first. Every dependency has a timeout so one slow system cannot hold a request, and independent read-only tool calls run in parallel. Numeric targets are set from the first traces, and no figure is claimed before it is measured.

## 18. Observability and evaluation

Log what happened, evaluate where it fails, and use that to improve the design.

### What is logged

- Every model call: input manifest, output, tokens, cost, latency, prompt version
- Every retrieval: query, chunks returned, scores
- Every tool call: tool, arguments, result, retries, duration
- Every plan, guardrail decision, escalation, and human action

The business audit trail lives in Postgres, so the Desk works even if Langfuse is down. LLM-level traces go to **Langfuse** with PII masked first. **OpenTelemetry** traces are keyed by case ID, with **Prometheus** and **Grafana** for system metrics.

### Evals per component

Evals must point to something fixable, so each component has its own.

| Component | What can go wrong | Metrics | Method |
|---|---|---|---|
| Retrieval | Irrelevant or missing context | Context precision, context recall | Labelled queries, code |
| Answers and explanations | Ungrounded or wrong claims | Groundedness, citation correctness | LLM judge with rubric |
| Communication | Unclear, wrong tone, dishonest ETA | Clarity, tone, ETA honesty | LLM judge with rubric |
| Planner | Invalid, unsafe, or wrong-tool plan | Plan validity, tool selection accuracy, argument accuracy, unseen-query success | Code checks on labelled scenarios |
| Tools and gateway | Failures and unknown outcomes | Tool success rate, retry rate, unknown-intent rate, time to reconcile | Code, from logs |
| Guardrails | Missed blocks or false blocks | Wrong-action rate (target zero), false-block rate, injection success (target zero) | Scripted adversarial scenarios |
| Escalation | Too late or too early | Escalation correctness, missed-escalation rate | Labelled scenarios, human review |
| Overall | Poor outcomes | Resolution rate, handling time, cost per resolution, repeat-contact rate, CSAT, workflow reuse rate | SQL views over events |

Objective checks (right tool, valid arguments, schema) use code. Subjective ones (groundedness, tone, helpfulness) use LLM judges with written rubrics, calibrated against human labels on a sample.

### Offline and online

- **Offline:** a scripted eval set (easy, ambiguous, fraud signals, angry customers, injection attempts, unseen queries) runs on every prompt, model, or rule change, with thresholds that gate the change.
- **Online:** live metrics from event views, sampled LLM-judge scoring, new workflows running at level 0 with a human watching, and human override rate as a signal.

Failures found in production become new eval scenarios.

### Fault injection and load

The mock world injects random latency, timeouts, 500s, duplicate webhooks, out-of-order callbacks, and "succeeded but the response was lost". A load test with scripted concurrent cases reports throughput and p95 handling time.

## 19. Security and privacy

- **Authentication and authorization on every request.** Customer sessions only see their own cases. Desk roles (agent, approver, admin) are enforced on the server.
- **Least-privilege tools,** scoped to the authenticated customer in the tool gateway (section 8). A tool is available to a plan only if its pack and risk level are allowed for the case.
- **Encryption** in transit and at rest.
- **Secrets** live in a secrets manager, never in prompts, code, or events. Models never hold credentials.
- **Untrusted content** (customer text, retrieved documents, partner and tool responses) is always marked as data, never as instructions.
- **PII** is masked in prompts, logs, and observability exports.
- **Audit:** from the event log we can answer who triggered a case, what data was accessed, which tools ran with which arguments, which policy version applied, and who approved a risky action.

## 20. Optimization

Optimization starts from traces and evals, never guesses. Find the bottleneck first.

- **Latency.** Slow retrieval: faster index, fewer candidates, lighter reranker. Slow model calls: a smaller model where evals still pass. Slow tools: remove unneeded calls, run independent ones in parallel, cache read-only results briefly.
- **Cost.** Route simple work (triage, extraction, summaries) to small models and keep strong models for planning and hard reasoning. Put stable prompt parts first for prompt caching. Saved workflows skip the planning call, so reuse lowers cost. Per-case token budgets cap runaway spend.
- **Semantic caching, carefully.** Safe only for generic policy answers. Never cache replies that contain case-specific or customer-specific data. The cache key includes the policy version, and entries are invalidated when policy changes.
- **Quality.** Find where quality is lost (retrieval, planner, tool flow, or model) before changing anything. Move to a stronger model only if the model is the bottleneck.
- **Failure patterns.** As domains grow, a single agent may carry too many tools and conflicting policies. Then specialist agents behind the orchestrator earn their complexity, with eval numbers as the proof.

## 21. Non-goals

- Issuing refunds that belong to a bank or third party
- Exactly-once execution
- Autonomous money movement without guardrails and the workflow having earned its level
- Streaming unvetted model output to customers

## 22. Decision log

| Topic | Current position | Status |
|---|---|---|
| Language | TypeScript everywhere | Open (Python for agent layer is an option) |
| Queue | Postgres with `SKIP LOCKED`, no separate job table | Proposed |
| Redis role | Cache, rate limits, ephemeral realtime fan-out | Proposed; BullMQ not used |
| Realtime transport | WebSockets with Socket.io | Proposed; raw `ws` is the alternative |
| LangGraph | Optional, only inside a step | Open |
| LangChain | Not used | Proposed |
| Facts ledger writer | LLM may propose entries, code verifies against system data | Open |
| Langfuse hosting | Hosted vs self-hosted | Open |
| Postgres topology | One instance for the hackathon | Proposed |
| Workflow promotion thresholds | Number of clean runs per level | To tune with the eval set |
| Mock fidelity | Mocks must support status lookup by reference | Needs checking against real systems |
| Policy content | Illustrative in the demo, must reflect Paytm's real rules | Needs real input |
| Agent topology | Single planner-executor first, specialists only when evals justify | Proposed |
| Retrieval | Hybrid (vector plus keyword) with reranker, single-hop first | Proposed |
| Reranker | Hosted model vs small local model | Open |
| Semantic caching | Generic policy answers only, never case-specific data | Proposed |
| Policy version per case | Record the version used per decision; whether in-flight cases stay pinned to their starting version | Open |
| Languages | English and Hindi assumed | Needs checking |
| Latency targets | Set from first traces | To tune |
| Monorepo tooling | Turborepo with pnpm workspaces, keep package count small | Proposed |