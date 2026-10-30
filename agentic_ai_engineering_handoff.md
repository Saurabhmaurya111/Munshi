# Agentic AI Support Layer --- Engineering Handoff

## 1. Purpose

This document defines the scope, architecture, responsibilities,
interfaces, and implementation expectations for the engineer responsible
for the **Agentic AI layer** of a larger customer-support platform.

This is a sub-system of a larger application. Do not create a separate
product identity, standalone customer application, or duplicate platform
infrastructure.

The AI layer receives customer messages and trusted context from the
parent application, understands one or more support intents, routes work
to specialized agents, uses approved tools and knowledge sources, and
returns structured results to the parent application.

## 2. Technology decisions

Use the following technology choices:

  -----------------------------------------------------------------------
  Area                                Technology
  ----------------------------------- -----------------------------------
  Language/runtime                    TypeScript on Node.js

  Agent orchestration                 LangGraph.js

  LLM integration                     LangChain.js model integrations or
                                      provider SDKs

  Structured validation               Zod

  Relational database                 Existing PostgreSQL instance

  Vector search                       PostgreSQL with `pgvector`

  Knowledge retrieval                 Embeddings + PostgreSQL/pgvector

  API boundary                        Integrate through interfaces
                                      supplied by the parent backend

  Testing                             Vitest (or the repository's
                                      existing test framework)
  -----------------------------------------------------------------------

**Important:** Use TypeScript throughout the agent implementation. Do
not introduce a Python agent service unless the architecture owner
explicitly approves a change.

"Postgre vector" means PostgreSQL with the `pgvector` extension. Reuse
the parent project's PostgreSQL infrastructure where possible; do not
provision a second database without approval.

## 3. Scope and ownership

### 3.1 In scope --- Agentic AI engineer

The assigned engineer owns:

-   Supervisor graph and orchestration.
-   Intent detection and multi-intent classification.
-   Entity extraction and validation.
-   Deterministic routing and agent dispatch.
-   Specialized agent behavior.
-   Tool definitions and tool-call orchestration.
-   RAG ingestion/retrieval logic for support knowledge.
-   Agent state and conversation context handling.
-   Result aggregation and response generation.
-   Agent-level retries, timeouts, and error handling.
-   Agent evaluation, tests, traces, and audit events emitted by the AI
    layer.
-   Integration contracts with the parent backend.

### 3.2 Out of scope --- Parent application/backend team

Unless separately assigned, the AI engineer does not own:

-   Customer-facing web or mobile UI.
-   User registration, login, OTP delivery, or identity verification.
-   Source-of-truth customer, payment, bank, refund, recharge, or
    account systems.
-   Actual payment execution, settlement, or money movement.
-   Production refund execution.
-   Core complaint/ticket database and business workflows.
-   Notification delivery infrastructure.
-   Platform-wide authorization, secrets management, networking,
    deployment, or infrastructure.
-   Building a replacement for existing backend APIs.

The AI layer may call approved backend APIs through tools, but the
parent backend remains the source of truth for business records and
permissions.

## 4. Supported support domains

Implement the following five domains:

1.  **UPI payment issues**
    -   Payment failed.
    -   Payment pending.
    -   Amount debited but receiver not credited.
    -   Duplicate payment.
    -   Unknown or suspicious transaction.
    -   Transaction investigation and complaint handoff.
2.  **Refund tracking**
    -   Check refund status.
    -   Refund initiated but not received.
    -   Refund failed or delayed.
    -   Partial refund inquiry.
    -   Refund investigation and complaint handoff.
3.  **Mobile recharge**
    -   Recharge failed or pending.
    -   Recharge successful but benefit not received.
    -   Duplicate recharge.
    -   Wrong-number recharge guidance.
    -   Provider status investigation.
4.  **Account issues**
    -   Login and OTP troubleshooting.
    -   KYC guidance.
    -   Account access or blocked-account guidance.
    -   Suspicious activity routing.
    -   Do not bypass identity verification or change credentials
        directly.
5.  **Complaint management**
    -   Create a complaint through an approved backend tool.
    -   Retrieve complaint status.
    -   Add permitted information to an existing complaint.
    -   Escalate unresolved or high-risk cases.
    -   Return the backend-generated ticket reference.

The agent must not claim an action succeeded until the relevant tool/API
confirms success.

## 5. Target architecture

``` text
Parent application / authenticated backend
                 |
                 v
        Agent API boundary
                 |
                 v
          Supervisor graph
                 |
       Intent classification
                 |
      Deterministic validation
                 |
       Task planning / routing
                 |
       +---------+----------+
       |         |          |
       v         v          v
    UPI agent  Refund    Recharge
               agent       agent
       |         |          |
       +---------+----------+
                 |
       Account / Complaint agents
                 |
                 v
        Approved tool interfaces
                 |
        Parent backend APIs
                 |
                 v
       Result aggregation node
                 |
                 v
      Structured response to parent
```

Knowledge retrieval is a shared capability available to relevant agents:

``` text
Approved support documents
          |
     Ingestion pipeline
          |
    Chunking + metadata
          |
      Embeddings
          |
 PostgreSQL + pgvector
          |
   Similarity retrieval
          |
  Relevant passages + citations
          |
     Agent response
```

The diagram is a logical architecture. The implementation may use
LangGraph subgraphs, nodes, conditional edges, and dynamic fan-out as
appropriate.

## 6. Supervisor responsibilities

The Supervisor is responsible for coordinating work, not for
implementing every domain's business logic.

It must:

1.  Receive the customer message and trusted context from the parent
    backend.
2.  Detect all supported intents in the message.
3.  Extract relevant entities, such as amount, transaction reference,
    date, recharge number, or complaint reference.
4.  Validate the classification against an allowlist of supported
    intents and agent names.
5.  Identify missing information and request clarification when
    required.
6.  Build one task per detected intent.
7.  Dispatch independent tasks concurrently.
8.  Preserve dependencies where one task depends on another.
9.  Collect each task's outcome, including partial failures.
10. Aggregate results into one clear response.
11. Return structured output to the parent application.

### Multi-intent requirement

The Supervisor must support multiple intents in one message.

Example:

> "My UPI payment of ₹2,000 failed yesterday, and my ₹500 refund has not
> arrived."

Expected classification:

``` json
{
  "intents": [
    {
      "intent": "UPI_PAYMENT_ISSUE",
      "agent": "upi_agent",
      "entities": {
        "amount": 2000,
        "relative_date": "yesterday"
      }
    },
    {
      "intent": "REFUND_STATUS",
      "agent": "refund_agent",
      "entities": {
        "amount": 500
      }
    }
  ]
}
```

This is an illustrative classification only. Amount and date are not
sufficient to identify a transaction uniquely. The agent must use
trusted customer context and approved backend lookup APIs, and ask for
clarification if multiple records match.

Independent tasks should run in parallel. Dependent tasks must run in
the correct order. For example, create a complaint only after the
relevant investigation determines that a complaint is appropriate.

## 7. Hybrid intent classification

Use a hybrid strategy:

### Stage A --- LLM classification

Use an LLM to interpret natural language, identify multiple intents, and
extract entities. Prefer provider-supported structured output with a Zod
schema.

### Stage B --- Deterministic validation

Validate the LLM result in TypeScript:

-   Intent is in the supported intent registry.
-   Agent name is in the agent allowlist.
-   Intent-to-agent mapping is valid.
-   Entity values have the expected types and sensible bounds.
-   Required information is present or marked as missing.
-   The request is within the AI layer's supported scope.

Never allow the LLM to supply an arbitrary function name, URL, SQL
query, API endpoint, or tool implementation.

### Stage C --- Routing

Route only validated tasks. Routing decisions must be deterministic code
based on validated structured data, not free-form LLM text.

### Fallback behavior

If classification is malformed, unsupported, ambiguous, or low
confidence:

-   Do not execute tools.
-   Ask a concise clarifying question, or return a safe
    unsupported-request response.
-   Record a structured classification failure for evaluation and
    observability.

## 8. Specialized agents

Each specialized agent should have a clearly bounded responsibility and
a small, explicit tool set.

  -----------------------------------------------------------------------------
  Agent                   Responsibilities        Example tools
  ----------------------- ----------------------- -----------------------------
  UPI agent               Investigate payment     `getTransactions`,
                          state and explain       `getTransactionStatus`,
                          verified outcomes       `getBankReference`

  Refund agent            Investigate refund      `getRefundStatus`,
                          lifecycle               `getRefundDetails`

  Recharge agent          Investigate             `getRechargeStatus`,
                          recharge/provider state `getRechargeDetails`

  Account agent           Provide account         `getAccountSupportStatus`,
                          troubleshooting and     `searchAccountHelpArticles`
                          safe guidance           

  Complaint agent         Create, retrieve,       `createComplaint`,
                          update permitted        `getComplaintStatus`,
                          details, and escalate   `addComplaintDetails`,
                          tickets                 `escalateComplaint`
  -----------------------------------------------------------------------------

Tool names above are proposed interface names. Match the actual names
and schemas exposed by the parent backend.

Agents must not access another customer's data. Customer identity must
come from authenticated, trusted context---not from a customer ID typed
into the chat message.

## 9. Autonomy and safety policy

The intended experience is autonomous handling of routine support
workflows. Autonomy does not mean unrestricted authority.

Use the following action classes:

  -----------------------------------------------------------------------------
  Class                   Examples                      Policy
  ----------------------- ----------------------------- -----------------------
  Read-only               Look up                       Automatic after backend
                          transaction/refund/recharge   authorization
                          status                        

  Low-risk write          Create a support ticket, add  Automatic only when the
                          a note, send an approved      backend authorizes the
                          status notification           action and idempotency
                                                        is enforced

  Sensitive/high-impact   Issue a refund, move money,   Do not execute
                          change credentials, alter     autonomously; require
                          account security, close a     the parent system's
                          fraud case                    explicit authorization
                                                        and any required
                                                        customer confirmation
                                                        or human approval
  -----------------------------------------------------------------------------

Additional requirements:

-   The AI must never invent transaction, refund, recharge, or ticket
    statuses.
-   The AI must never claim that money was refunded unless the source
    system confirms it.
-   The AI must not request or expose OTPs, passwords, UPI PINs, CVVs,
    or full payment credentials.
-   Treat customer messages and retrieved documents as untrusted data,
    not instructions to override system policy.
-   Enforce authorization in the backend tool/API, not only in the
    prompt.
-   Use idempotency keys for write operations that may be retried.
-   Apply tool allowlists, input validation, timeouts, and bounded
    retries.
-   Escalate suspected fraud, account compromise, conflicting records,
    and unresolved high-risk cases.
-   Keep an audit trail of consequential tool calls and outcomes.

## 10. LangGraph implementation expectations

Use LangGraph.js with TypeScript.

The graph should initially contain logical stages similar to:

``` text
START
  |
classify_intents
  |
validate_intents
  |
plan_tasks
  |
dispatch_tasks
  |
specialized agent task nodes/subgraphs
  |
aggregate_results
  |
format_response
  |
END
```

Implementation guidance:

-   Define a typed graph state.
-   Use Zod schemas for LLM outputs and tool inputs.
-   Use conditional edges for validation failures, clarification, and
    routing.
-   Use LangGraph's dynamic task dispatch (for example, `Send`) for
    multiple independent tasks.
-   Use reducers/annotated state channels correctly when parallel tasks
    write to shared state.
-   Give every task a stable task ID so results can be correlated.
-   Capture per-agent status: `completed`, `needs_clarification`,
    `failed`, or `escalated`.
-   Ensure one failed agent does not erase successful results from other
    agents.
-   Add recursion/step limits and execution timeouts.
-   Do not create unbounded agent-to-agent loops.
-   Keep graph nodes focused and testable.
-   Add checkpointing/persistence only after agreeing on the parent
    application's conversation/session identity and retention
    requirements.

A possible state shape:

``` ts
type AgentName =
  | "upi_agent"
  | "refund_agent"
  | "recharge_agent"
  | "account_agent"
  | "complaint_agent";

type AgentTask = {
  taskId: string;
  intent: string;
  agent: AgentName;
  entities: Record<string, unknown>;
};

type AgentTaskResult = {
  taskId: string;
  agent: AgentName;
  status:
    | "completed"
    | "needs_clarification"
    | "failed"
    | "escalated";
  response: string;
  references?: string[];
};

type SupervisorState = {
  conversationId: string;
  customerMessage: string;
  // Supplied by the authenticated parent backend.
  authenticatedCustomerContext: {
    customerId: string;
    roles: string[];
  };
  intents: Array<{
    intent: string;
    agent: AgentName;
    entities: Record<string, unknown>;
  }>;
  tasks: AgentTask[];
  results: AgentTaskResult[];
  finalResponse?: string;
};
```

This is a starting contract. Refine it with the parent backend team
before treating it as a stable API.

## 11. RAG and PostgreSQL pgvector

Use PostgreSQL with `pgvector` for approved support knowledge.

### Knowledge sources

Only ingest approved, versioned content, such as:

-   Support FAQs.
-   UPI troubleshooting procedures.
-   Refund and reversal policies.
-   Recharge troubleshooting guides.
-   Account and KYC help articles.
-   Complaint and escalation procedures.

### Ingestion pipeline

``` text
Approved source documents
        |
Text extraction / normalization
        |
Chunking with source metadata
        |
Embedding generation
        |
PostgreSQL + pgvector storage
        |
Similarity search
        |
Relevant chunks returned to agent
```

### Metadata to retain

At minimum:

-   `document_id`
-   `document_title`
-   `source`
-   `content`
-   `chunk_index`
-   `document_version`
-   `effective_from` / `effective_to` where applicable
-   `category`
-   `language`
-   embedding vector

Use metadata filters to prevent obsolete or irrelevant content from
being retrieved. Return source references with retrieved passages so the
agent can ground its answer.

Do not store customer payment credentials, OTPs, or unnecessary personal
data in the vector database. Transaction and account facts must be
retrieved from authoritative backend APIs, not inferred from RAG
content.

## 12. Integration contract with the parent backend

The AI layer should expose a clear interface and consume only approved
backend tools.

### Suggested request

``` json
{
  "conversationId": "conversation-123",
  "message": "My payment failed and my refund is pending.",
  "authenticatedContext": {
    "customerId": "customer-456",
    "roles": ["customer"]
  }
}
```

The parent backend must authenticate the caller and construct the
trusted context. Do not trust a customer ID supplied directly in an
untrusted request body.

### Suggested response

``` json
{
  "conversationId": "conversation-123",
  "status": "completed",
  "message": "I checked both issues. Here are the verified results...",
  "tasks": [
    {
      "taskId": "task-1",
      "agent": "upi_agent",
      "status": "completed",
      "summary": "Verified payment status..."
    },
    {
      "taskId": "task-2",
      "agent": "refund_agent",
      "status": "needs_clarification",
      "summary": "More information is needed to identify the refund."
    }
  ],
  "requiresCustomerInput": true
}
```

The exact API shape, authentication mechanism, streaming behavior, and
error envelope must be agreed with the parent backend team.

## 13. Reliability and error handling

Implement:

-   Per-tool timeout.
-   Bounded retries for transient failures only.
-   Exponential backoff with jitter where appropriate.
-   Idempotency for write operations.
-   Structured error codes.
-   Partial success handling for multi-intent requests.
-   Safe fallback when the LLM provider is unavailable.
-   Clear distinction between business failures and infrastructure
    failures.
-   Correlation IDs across graph execution and backend calls.

Do not retry non-idempotent writes blindly. A timeout after a write may
mean the backend completed the action even though the response was lost;
check operation status using an idempotency key before retrying.

## 14. Observability and auditability

For each graph execution, capture:

-   Conversation and correlation IDs.
-   Graph run ID.
-   Classification result and validation outcome.
-   Selected agents and task IDs.
-   Tool name and duration.
-   Tool outcome and structured error code.
-   Retrieval document references.
-   Final task statuses.
-   Escalation decisions.
-   Model/provider and prompt version where appropriate.

Avoid logging secrets, OTPs, full payment credentials, or unnecessary
personal data. Apply retention and access controls defined by the parent
application.

## 15. Testing and evaluation

Build tests at four levels.

### Unit tests

-   Intent schema validation.
-   Intent-to-agent mapping.
-   Entity validation.
-   Routing logic.
-   Aggregation behavior.
-   Tool input validation.

### Graph tests

-   Single-intent request.
-   Multiple independent intents.
-   Parallel task completion.
-   One agent fails while another succeeds.
-   Missing information triggers clarification.
-   Unsupported intent does not dispatch a tool.
-   Dependent tasks execute in the correct order.

### Tool integration tests

Use mocked backend APIs initially. Verify authorization context,
idempotency, timeout handling, and error mapping.

### Evaluation dataset

Create a versioned dataset containing:

-   Clear single-intent messages.
-   Multiple-intent messages.
-   Ambiguous messages.
-   Misspellings and informal language.
-   Hindi/English mixed-language messages if in scope.
-   Unsupported requests.
-   Prompt injection attempts.
-   Fraud and account-compromise scenarios.

Measure:

-   Intent precision, recall, and F1.
-   Multi-intent detection accuracy.
-   Correct agent-routing rate.
-   Entity extraction accuracy.
-   Tool-call success rate.
-   Unsupported-action rate.
-   Grounded-answer rate.
-   Escalation accuracy.
-   End-to-end latency.

Do not evaluate only on happy-path examples.

## 16. Suggested implementation milestones

  Milestone   Deliverable
  ----------- ----------------------------------------------------------------
  M1          TypeScript project setup, schemas, shared graph state
  M2          Hybrid classifier and deterministic validation
  M3          Supervisor routing and multi-intent task planning
  M4          Parallel dispatch and result aggregation
  M5          Specialized agent skeletons and mocked tools
  M6          Backend API tool integrations
  M7          PostgreSQL/pgvector knowledge ingestion and retrieval
  M8          Memory/checkpointing and conversation continuity
  M9          Safety policies, audit events, retries, and observability
  M10         Evaluation suite, integration tests, and handoff documentation

## 17. Definition of done

The AI layer is ready for integration when:

-   It is implemented in TypeScript using LangGraph.js.
-   It supports all five agreed support domains.
-   It detects and routes multiple intents.
-   Independent tasks execute concurrently.
-   Partial failures are represented accurately.
-   LLM output is validated before routing.
-   Tools use approved backend interfaces.
-   Customer identity and permissions come from trusted context.
-   Sensitive actions are protected by policy and backend authorization.
-   RAG uses PostgreSQL with `pgvector` and returns source references.
-   The agent never fabricates transaction or action outcomes.
-   Unit, graph, integration, and evaluation tests pass.
-   Logs and traces are useful without exposing sensitive data.
-   API contracts and operational limitations are documented.

## 18. Working principles

1.  Build the smallest testable graph first; do not start with a complex
    autonomous multi-agent loop.
2.  Keep business truth in backend systems, not in the LLM.
3.  Use the LLM for language understanding and planning within a bounded
    action space.
4.  Use deterministic code for validation, authorization boundaries,
    routing, and policy enforcement.
5.  Prefer a small number of capable, well-tested agents over
    unnecessary agent proliferation.
6.  Make every tool call explicit, typed, observable, and testable.
7.  Preserve partial results and explain uncertainty honestly.
8.  Coordinate interface changes with the parent backend team.
9.  Reuse existing project conventions and infrastructure rather than
    introducing duplicate services.
10. Never claim a payment, refund, recharge, complaint, or account
    action succeeded without authoritative confirmation.

------------------------------------------------------------------------

**Handoff outcome:** The assigned engineer owns the TypeScript/LangGraph
agentic layer, its RAG capability using PostgreSQL/pgvector, and its
integration contracts. The parent application remains responsible for
customer-facing product behavior, identity, source-of-truth business
systems, and execution of protected financial operations.
