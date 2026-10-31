# Evaluations

Scripted scenarios and scoring for Munshi. See [ARCHITECTURE.md](../ARCHITECTURE.md)
section 19 for case design, wrong actions, and gating rules.

## Layout

```
evals/
  schema.ts                 Zod scenario + thresholds schemas
  thresholds.json           Gate thresholds for the current dataset version
  scenarios/
    v2026-10/               Labelled offline cases (fake identifiers only)
apps/worker/test/evals/     Vitest runner, loader, and code scorers
```

## Run

```sh
npm run eval
```

This loads `evals/scenarios/v{datasetVersion}/*.json`, runs each case through
`runSupervisor` with a labelled (injected) classifier and mock tools, then
scores with code checks. No Postgres, Redis, or LLM provider is required.

## Scenario shape

Each JSON file must match `evals/schema.ts`:

- `id`, `version`, `tags`
- `input`: customer `message`, trusted `authenticatedContext`, optional `workflowLevel`
- `classification`: labelled intents (planner mode — avoids flaky live LLM calls)
- `mockTools`: deterministic tool results keyed by tool name
- `expect`: status, tools that must / must not run, escalate flag, reply substrings

Tags: `easy`, `ambiguous`, `unseen`, `fraud`, `injection`, `Hinglish`,
`missing-information`, `partial-failure`.

## Scoring and gates

Code checks cover plan validity (status / escalate / agents), tool selection
(must-run, must-not-run, optional order), and reply substrings.

A **wrong action** is a write or money-adjacent call the label forbids, or a
reply that states a status / amount / refund the mock backend did not return.
Target wrong-action rate on the eval set is **zero**. Injection success must
also stay at zero. Other thresholds live in `thresholds.json` and are frozen
for the dataset version — do not loosen them to land a change.

## Adding a scenario

1. Copy an existing file under `scenarios/v2026-10/`.
2. Use fake customer and reference IDs only (no real PII, OTPs, or credentials).
3. Label the expected classification and mock tool facts so the case is
   deterministic.
4. Prefer code-scorable expects. Subjective tone / groundedness judges are not
   in v1.
5. Run `npm run eval` and keep wrong-action rate at zero.

Every production failure, human override, or wrong action should become a new
eval case before the related workflow is promoted again.

`unseen` cases are held out for gating; do not tune prompts against them.

## Not in v1

LLM-as-judge rubrics, retrieval precision / recall, voice audio, and Langfuse
online evals are deferred. Failures found in production still become offline
scenarios first.
