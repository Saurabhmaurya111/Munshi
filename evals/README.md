# Evaluations

Scripted scenarios and scoring for Munshi. See [ARCHITECTURE.md](../ARCHITECTURE.md)
section 19 for case design, wrong actions, and gating rules.

## Layout

```
evals/
  schema.ts                 Zod scenario + thresholds + judge verdict schemas
  thresholds.json           Gate thresholds for the current dataset version
  rubrics/judge.md          Written LLM-judge rubrics
  scenarios/
    v2026-10/               Labelled offline cases (fake identifiers only)
apps/worker/test/evals/     Vitest runner, code scorers, LLM judge
```

## Run

Code-only (no LLM provider):

```sh
npm run eval
```

Code + LLM-as-judge (requires `SARVAM_API_KEY`):

```sh
npm run eval:judge
```

Both load `evals/scenarios/v{datasetVersion}/*.json`, run each case through
`runSupervisor` with a labelled (injected) classifier and mock tools, then
score with code checks. `eval:judge` also asks Sarvam to score the reply
against `evals/rubrics/judge.md`.

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

### Code checks

Plan validity (status / escalate / agents), tool selection (must-run,
must-not-run, optional order), and reply substrings.

A **wrong action** is a write or money-adjacent call the label forbids, or a
reply that states a status / amount / refund the mock backend did not return.
Target wrong-action rate on the eval set is **zero**. Injection success must
also stay at zero.

### LLM judge (optional)

Dimensions in [`rubrics/judge.md`](./rubrics/judge.md):

| Dimension | Gates the suite? |
|-----------|------------------|
| groundedness | Yes (fail rate max in `thresholds.json`) |
| etaHonesty | Yes |
| clarity | Reported only |
| tone | Reported only |

Tone alone never blocks a change. Calibrate the judge against human labels on
a sample before trusting scores; a judge disagreement with a human label is a
rubric bug, not a model win.

Other thresholds live in `thresholds.json` and are frozen for the dataset
version — do not loosen them to land a change.

## Adding a scenario

1. Copy an existing file under `scenarios/v2026-10/`.
2. Use fake customer and reference IDs only (no real PII, OTPs, or credentials).
3. Label the expected classification and mock tool facts so the case is
   deterministic.
4. Prefer code-scorable expects; use the LLM judge for groundedness / honesty /
   tone / clarity.
5. Run `npm run eval` (and `npm run eval:judge` when changing reply wording).

Every production failure, human override, or wrong action should become a new
eval case before the related workflow is promoted again.

`unseen` cases are held out for gating; do not tune prompts against them.

## Not covered yet

Retrieval precision / recall, voice audio, and Langfuse online evals are still
deferred. Failures found in production still become offline scenarios first.
