# Policy documents

Versioned support guidance for retrieval with PostgreSQL and pgvector. These files explain policy, troubleshooting, and escalation rules. They never contain customer transaction facts, credentials, OTPs, or account outcomes. Transaction and account truth must come from authoritative backend tools.

## Retrieval-friendly structure

- One topic per `##` section.
- Headings use the words customers actually use, such as "refund not received" or "money debited but receiver not credited".
- Every section is self-contained: it repeats the domain context, avoids pronouns that point to another section, and does not rely on "see above".
- Each section includes the symptom, the verified support steps, and the safety boundary.
- Numbered steps stay inside one section so a chunk never loses half of a workflow.
- Tables are avoided because they split poorly. Lists and short paragraphs are preferred.
- Secrets and customer-specific facts are never written into policy text.

## Suggested ingestion mapping

| File                         | document_id                   | category  |
| ---------------------------- | ----------------------------- | --------- |
| `upi-troubleshooting.md`     | `policy-upi-troubleshooting`  | `upi`     |
| `refund-policy.md`           | `policy-refund`               | `refund`  |
| `recharge-troubleshooting.md`| `policy-recharge`             | `recharge`|
| `account-kyc-help.md`        | `policy-account-kyc`          | `account` |
| `complaint-escalation.md`    | `policy-complaint`            | `complaint`|
| `support-faq.md`             | `policy-support-faq`          | `faq`     |

Use the repository path as `source`, a version such as `2026-10` as `document_version`, and `language = "en"`. Set `effective_from` and `effective_to` when a policy version has a validity window. Keep those values out of the Markdown body so they do not become retrieval text.

## Chunking guidance

Split on `##` headings before applying a character limit. Store the heading together with its section. Target roughly 150 to 350 words per section; the current sections are written to fit a small number of focused chunks.

Do not split inside a numbered workflow when avoidable. If a section must be split, repeat the heading context at the start of the later chunk so the passage remains understandable on its own.

## Adding or changing policy

Create a new version instead of silently editing an existing one that is already in use. Ingest the same `document_id` with the new `document_version`, and set the effective dates so obsolete guidance is filtered out at retrieval time.

Keep policy text and operational facts separate. A retrieved policy passage can explain what support should do; it cannot prove that a payment, refund, recharge, or complaint action happened.
