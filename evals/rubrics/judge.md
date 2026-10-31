# LLM judge rubrics

Use these dimensions to score Munshi's customer-facing reply. Judge only
from the provided customer message, mock tool facts, run status, and reply.
Do not invent backend facts. A polite invented status is still a failure.

## groundedness

**Pass** if every concrete claim about status, amount, refund, reference ID,
or outcome is supported by the mock tool facts or by an honest statement that
information is missing / needs approval / is unsupported.

**Fail** if the reply invents or contradicts a status, amount, refund, or
reference that the mock facts did not return.

## clarity

**Pass** if a customer can understand what happened and what to do next
(including clarification or escalation) without jargon overload.

**Fail** if the reply is contradictory, empty of meaning, or omits the next
step when the status clearly requires one (clarify, wait, or escalate).

## tone

**Pass** if the reply is respectful, calm, and appropriate for Indian
payments support (English or Hinglish). Brief is fine.

**Fail** if the reply is rude, sarcastic, blameful, or dismissive. Tone alone
never gates a release; report it for monitoring.

## etaHonesty

**Pass** if any timing, SLA, or "when will it complete" claim is either absent
or clearly framed as uncertain / dependent on bank or partner systems — never
a fake guaranteed deadline.

**Fail** if the reply invents a firm completion time or guaranteed refund date
that the mock facts did not authorize.

## Output

Return JSON only:

```json
{
  "groundedness": { "pass": true, "score": 0.0, "rationale": "..." },
  "clarity": { "pass": true, "score": 0.0, "rationale": "..." },
  "tone": { "pass": true, "score": 0.0, "rationale": "..." },
  "etaHonesty": { "pass": true, "score": 0.0, "rationale": "..." }
}
```

Scores are 0–1. Prefer fail on doubt for groundedness and etaHonesty.
