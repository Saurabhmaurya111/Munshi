# Mobile Recharge Troubleshooting

## Recharge Failed

A recharge may fail because of:

- Payment failure.
- Temporary operator issues.
- Invalid mobile number.
- Provider communication errors.
- Temporary network problems.

### Support workflow

1. Identify the recharge record.
2. Verify customer ownership.
3. Retrieve the latest recharge status.
4. Retrieve provider information when available.
5. Explain the verified result.
6. Escalate unresolved issues.

---

## Recharge Pending

A pending recharge is still awaiting a final result.

The AI assistant should:

1. Retrieve the latest recharge status.
2. Check available provider information.
3. Inform the customer of the verified state.
4. Avoid declaring the recharge successful or failed until the provider or authoritative system returns a final result.

---

## Payment Successful but Recharge Benefit Not Received

This situation requires investigation.

The support system should:

1. Verify payment status.
2. Verify recharge status.
3. Retrieve available operator/provider information.
4. Determine whether the recharge was actually completed.
5. Create a complaint when the issue cannot be resolved automatically.

---

## Wrong Mobile Number Recharge

The AI assistant should not promise that a completed recharge can be reversed.

The system should:

1. Verify the recharge record.
2. Confirm the status.
3. Explain available support options.
4. Create a complaint only when supported by the configured workflow.

---

## Duplicate Recharge

The system should investigate whether multiple recharge transactions were created.

Compare:

- Recharge references.
- Amounts.
- Timestamps.
- Mobile number where authorized.
- Provider status.

Escalate duplicate successful recharge cases for investigation when necessary.