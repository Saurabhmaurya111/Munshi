# UPI Payment Troubleshooting

## Purpose

This document provides troubleshooting guidance for common UPI payment issues.

Transaction records and payment status must always be retrieved from an authoritative transaction service. This document provides guidance only and must not be treated as the source of transaction truth.

---

## Payment Failed

A payment may fail because of:

- Temporary network problems.
- Bank service interruptions.
- Insufficient available balance.
- Authorization failure.
- Invalid recipient details.
- Temporary payment provider errors.

### Support workflow

1. Identify the relevant transaction.
2. Verify that the transaction belongs to the authenticated customer.
3. Retrieve the latest transaction status.
4. Review the available failure reason.
5. Provide the verified result to the customer.
6. Recommend retrying only when appropriate.
7. Create a complaint if the issue remains unresolved.

---

## Payment Pending

A pending transaction does not have a final result.

### Support workflow

1. Retrieve the latest transaction status.
2. Check the transaction reference.
3. Inform the customer that the transaction is pending when the authoritative system confirms that state.
4. Do not mark the transaction as successful or failed without confirmation.
5. Recheck or escalate according to the configured support workflow if the transaction remains unresolved.

---

## Amount Debited but Receiver Not Credited

This issue requires transaction investigation.

### Support workflow

1. Verify the authenticated customer's ownership of the transaction.
2. Retrieve the latest transaction status.
3. Retrieve available transaction and bank references.
4. Determine the current authoritative state.
5. Explain the verified outcome.
6. If the transaction remains unresolved, create a complaint or escalation case.

The AI assistant must not promise that funds will be returned unless the payment system confirms the reversal or refund.

---

## Duplicate Payment

A duplicate payment issue occurs when a customer believes that more than one payment was made for the same intended purchase or transfer.

### Support workflow

1. Retrieve relevant transactions for the authenticated customer.
2. Compare transaction identifiers, timestamps, amounts, and recipients where permitted.
3. Confirm whether multiple transactions actually occurred.
4. Determine the status of each transaction.
5. Create a complaint when duplicate successful payments require investigation.

---

## Unknown or Suspicious Transaction

An unknown transaction may indicate an account-security issue.

### Support workflow

1. Verify the customer's identity through the parent application's security process.
2. Retrieve the transaction using authorized backend tools.
3. Do not request passwords, UPI PINs, OTPs, or CVVs.
4. Mark the issue for secure fraud or account-security handling when required.
5. Escalate according to the platform's security workflow.