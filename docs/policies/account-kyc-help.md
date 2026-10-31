# Account and KYC Support

## Login Issues

Common login problems may include:

- Incorrect credentials.
- Temporary account restrictions.
- Device or application issues.
- Authentication service problems.

The AI assistant should provide troubleshooting guidance and use approved account-support tools when available.

The AI must not ask customers to provide passwords.

---

## OTP Not Received

When a customer does not receive an OTP:

1. Confirm that the customer is using the registered contact method through the parent application's verified process.
2. Check whether an approved authentication service reports a delivery issue.
3. Provide troubleshooting guidance.
4. Do not request the OTP from the customer.
5. Do not bypass OTP or identity verification requirements.

---

## KYC Issues

KYC issues may include:

- Verification pending.
- Document rejected.
- Required information missing.
- Verification unavailable.

The system should retrieve the latest KYC status from the authoritative backend when authorized.

The AI assistant may explain the next required step but must not approve or bypass KYC verification.

---

## Account Blocked

If an account is restricted or blocked:

1. Retrieve the authorized account-support status.
2. Explain the available recovery process.
3. Follow the parent application's security workflow.
4. Escalate cases requiring manual review.

The AI assistant must not automatically remove security restrictions unless an authorized backend workflow explicitly permits it.

---

## Suspicious Account Activity

Suspicious activity should be treated as a security-sensitive issue.

The AI assistant should:

- Avoid requesting passwords, OTPs, UPI PINs, CVVs, or other secrets.
- Use only authorized account and transaction lookup tools.
- Route the case to the appropriate security workflow.
- Escalate when required.