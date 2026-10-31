# Refund and Reversal Support Policy

## Purpose

This document defines support guidance for refund and reversal inquiries.

The authoritative refund system is the source of truth for refund status and amount.

---

## Refund Statuses

A refund may have one of the following states:

### Initiated

The refund process has been created but has not completed.

### Processing

The refund is being processed by the relevant system or provider.

### Completed

The authoritative refund system confirms that the refund was completed.

### Failed

The refund process could not be completed and may require further investigation.

### Not Found

No matching refund record was found using the supplied or authorized lookup information.

---

## Refund Tracking Workflow

When a customer asks about a refund:

1. Identify the refund reference or related transaction.
2. Verify ownership using authenticated customer context.
3. Retrieve the latest refund status.
4. Return only the verified status.
5. Provide any available reference information.
6. Escalate when the refund requires manual investigation.

---

## Delayed Refund

If a customer reports that a refund has not been received:

1. Check whether a refund record exists.
2. Retrieve the latest status.
3. Determine whether it is processing, completed, failed, or unresolved.
4. If the authoritative system reports completion but the customer reports a problem, create an investigation case when configured.
5. Do not claim that a new refund has been issued unless the authoritative system confirms it.

---

## Partial Refund

A partial refund means that the refunded amount is lower than the original transaction amount.

The system should:

1. Retrieve the original transaction.
2. Retrieve refund records associated with it.
3. Compare verified amounts.
4. Clearly distinguish original amount, refunded amount, and any remaining disputed amount.
5. Create a complaint if additional investigation is required.

---

## Failed Refund

A failed refund requires investigation.

The AI should retrieve the available failure information and follow the configured escalation workflow.

Do not repeatedly execute refund actions unless the parent backend explicitly authorizes the operation and supports idempotency.