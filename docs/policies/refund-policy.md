# Refund and Reversal Support Policy

This document is support guidance for refund status, delayed refunds, partial refunds, failed refunds, and reversal inquiries. The authoritative refund and transaction systems are the only source of truth for refund status, refund amount, and completion. Support must never infer a refund outcome from customer text, a payment failure, or a complaint status.

## How to check refund status

Customers may ask "where is my refund", "has my refund been processed", "refund status check", "my refund is pending", or "I have not received my refund".

Support steps:

1. Identify the refund reference or the related transaction.
2. Verify ownership using the authenticated customer context.
3. Retrieve the latest refund status from the authoritative refund service.
4. Return only the verified status and amount when available.
5. Provide any available refund or transaction reference.
6. Escalate when the refund requires manual investigation.

## What refund statuses mean

A refund may have one of these states:

- Initiated: the refund process has been created but has not completed.
- Processing: the refund is being processed by the relevant system or provider.
- Completed: the authoritative refund system confirms that the refund was completed.
- Failed: the refund process could not be completed and may require further investigation.
- Not found: no matching refund record was found using the supplied or authorized lookup information.

The exact status returned by the refund service is the source of truth. If the status is not found, do not claim that a refund exists. Use additional authorized identifiers or escalate according to the support workflow.

## Refund not received or delayed

Customers may report "my refund has not arrived", "the refund is late", "it has been too long", or "the refund shows completed but I did not receive it".

Support steps:

1. Check whether a refund record exists.
2. Retrieve the latest refund status.
3. Determine whether the refund is processing, completed, failed, or unresolved.
4. If the authoritative system reports completion but the customer reports a problem, create an investigation case when configured.
5. Do not claim that a new refund has been issued unless the authoritative system confirms it.

## Partial refund

Customers may report "I received less than I expected", "the refund amount is lower than the payment", "only part of my money came back", or "the refund is incomplete".

A partial refund means that the refunded amount is lower than the original transaction amount.

Support steps:

1. Retrieve the original transaction.
2. Retrieve the refund records associated with the transaction.
3. Compare the verified amounts.
4. Clearly distinguish the original amount, the refunded amount, and any remaining disputed amount.
5. Create a complaint if additional investigation is required.

Do not calculate or promise a remaining amount from customer-provided figures when authoritative amounts are unavailable.

## Failed refund

Customers may report "my refund failed", "the refund was rejected", "the refund did not process", or "the refund shows an error".

A failed refund requires investigation. Support should retrieve the available failure information and follow the configured escalation workflow.

Do not repeatedly execute refund actions unless the parent backend explicitly authorizes the operation and supports idempotency. Do not claim a failed refund will be retried unless the refund system confirms a new attempt.

## Refund and UPI reversal are different

A refund is issued by the merchant or refund system. A UPI reversal is handled by the bank or payment system. Support may investigate a UPI payment dispute and raise or follow up a complaint, but must not state that a reversal or partner refund has been issued unless the authoritative system confirms it.

Do not promise that a UPI payment will be reversed, and do not treat a complaint reference as proof that money has been returned.
