# Account and KYC Support

This document is support guidance for login problems, OTP delivery issues, KYC verification, blocked accounts, and suspicious account activity. Identity, authentication, KYC status, and account restrictions must come from the parent application and authoritative backend systems. Support must never bypass identity verification or change credentials directly.

Security rules for every account case:

- Never ask a customer for a password, OTP, UPI PIN, CVV, or other secret.
- Never approve, bypass, or reverse KYC verification.
- Never remove a security restriction unless an authorized backend workflow explicitly permits it.
- Use only authorized account and transaction lookup tools.

## Cannot log in

Customers may report "I cannot log in", "login failed", "my account will not open", "the app does not let me sign in", or "I am locked out".

Common login problems include incorrect credentials, temporary account restrictions, device or application issues, and authentication service problems.

Support steps:

1. Confirm the customer is using the parent application's verified login recovery process.
2. Check whether an approved authentication service reports a delivery or service issue.
3. Provide troubleshooting guidance.
4. Use approved account-support tools when available.
5. Escalate cases that require manual identity review.

Do not request the customer's password or attempt to sign in on the customer's behalf.

## OTP not received

Customers may report "I did not get the OTP", "OTP not received", "the code never arrived", "OTP delivery failed", or "I cannot verify my number".

Support steps:

1. Confirm that the customer is using the registered contact method through the parent application's verified process.
2. Check whether an approved authentication service reports a delivery issue.
3. Provide troubleshooting guidance.
4. Do not request the OTP from the customer.
5. Do not bypass OTP or identity verification requirements.
6. Escalate when delivery continues to fail and the security workflow requires review.

## KYC verification pending or rejected

Customers may report "my KYC is pending", "KYC verification failed", "my document was rejected", "KYC is not approved", or "I need to complete KYC".

KYC issues may include verification pending, document rejected, required information missing, or verification unavailable.

Support steps:

1. Retrieve the latest KYC status from the authoritative backend when authorized.
2. Explain the next required step.
3. Ask only for information the approved KYC workflow permits.
4. Escalate when the verification requires manual review.

Do not approve, reject, or bypass KYC verification. Do not claim that KYC is complete unless the authoritative system confirms it.

## Account blocked or restricted

Customers may report "my account is blocked", "my account is restricted", "I cannot send money", "my wallet is frozen", or "my account is under review".

Support steps:

1. Retrieve the authorized account-support status.
2. Explain the available recovery process.
3. Follow the parent application's security workflow.
4. Escalate cases requiring manual review.

Do not automatically remove security restrictions. Do not promise a restoration time unless the authoritative system provides one.

## Suspicious account activity

Customers may report "someone accessed my account", "there is activity I do not recognize", "my account was hacked", or "I received a suspicious login alert".

Suspicious activity should be treated as a security-sensitive issue. Support steps:

1. Verify the customer's identity through the parent application's security process.
2. Avoid requesting passwords, OTPs, UPI PINs, CVVs, or other secrets.
3. Use only authorized account and transaction lookup tools.
4. Route the case to the appropriate security workflow.
5. Escalate when required.

Do not confirm a fraud outcome or remove restrictions without the authorized security workflow.
