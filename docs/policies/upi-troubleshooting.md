# UPI Payment Troubleshooting

This document is support guidance for UPI payment failures, pending payments, debited-but-not-credited cases, duplicate payments, and unrecognized transactions. Transaction status, failure reason, bank reference, and reversal outcome must come from authoritative backend transaction tools. This guidance must never override a tool result or be used to claim that money moved.

## UPI payment failed

Customers may report "my UPI payment failed", "the transaction did not go through", "payment declined", "UPI payment unsuccessful", or "the payment was not completed".

A UPI payment may fail because of temporary network problems, bank service interruptions, insufficient available balance, authorization failure, invalid recipient details, or temporary payment-provider errors.

Support steps:

1. Identify the relevant transaction from a verified transaction reference, UPI reference, or authorized lookup.
2. Verify that the transaction belongs to the authenticated customer.
3. Retrieve the latest transaction status and the available failure reason from the authoritative transaction service.
4. Explain only the verified status and failure reason to the customer.
5. Recommend a retry only when the verified status and failure reason make a retry appropriate.
6. Create a complaint when the payment remains unresolved or requires investigation.

Do not state that a failed UPI payment was refunded, reversed, or returned unless the authoritative transaction or refund service confirms that outcome.

## UPI payment pending

Customers may report "my payment is pending", "the payment is stuck", "the transaction shows processing", "money is on hold", or "the payment has not completed yet".

A pending UPI payment has no final result. Support must not describe it as successful or failed until the authoritative transaction service returns a final status.

Support steps:

1. Retrieve the latest transaction status.
2. Check the available transaction reference.
3. Tell the customer that the payment is pending only when the authoritative system confirms that state.
4. Do not mark the transaction as successful or failed without confirmation.
5. Recheck or escalate according to the configured support workflow if the transaction remains unresolved.

## Money debited but receiver not credited

Customers may report "money was deducted but the receiver did not get it", "the amount left my account but did not reach the recipient", "UPI transfer is stuck", or "the beneficiary has not received the payment".

This issue requires transaction investigation. Support steps:

1. Verify that the transaction belongs to the authenticated customer.
2. Retrieve the latest transaction status.
3. Retrieve the available transaction reference and bank reference.
4. Determine the current authoritative state: pending, successful, failed, reversed, or unresolved.
5. Explain the verified outcome and any available reference to the customer.
6. If the transaction remains unresolved, create a complaint or escalation case according to the support workflow.

Do not promise that funds will be returned unless the payment system confirms the reversal or refund. Do not invent a reversal status or a settlement timeline.

## Duplicate UPI payment

Customers may report "I was charged twice", "the payment went through two times", "duplicate UPI transaction", or "more than one payment was made for the same purchase".

A duplicate payment issue occurs when a customer believes that more than one payment was made for the same intended purchase or transfer.

Support steps:

1. Retrieve the relevant transactions for the authenticated customer.
2. Compare transaction identifiers, timestamps, amounts, and recipients where permitted.
3. Confirm whether multiple transactions actually occurred.
4. Determine the authoritative status of each transaction.
5. Create a complaint when duplicate successful payments require investigation.

Do not promise that one of the payments will be reversed automatically. The bank or payment system determines the reversal outcome, and support must report only the confirmed result.

## Unrecognized or suspicious UPI transaction

Customers may report "I do not recognize this transaction", "there is a payment I did not make", "someone used my UPI", or "my account has suspicious activity".

An unrecognized transaction may indicate an account-security issue. Support steps:

1. Verify the customer's identity through the parent application's security process.
2. Retrieve the transaction using authorized backend tools.
3. Do not request passwords, UPI PINs, OTPs, CVVs, or other secrets.
4. Mark the issue for secure fraud or account-security handling when required.
5. Escalate according to the platform's security workflow.

Do not remove security restrictions or confirm a fraud outcome without an authorized backend workflow.
