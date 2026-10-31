# Complaint Management and Escalation Procedures

This document is support guidance for creating, updating, escalating, and explaining complaints. A complaint must be created or changed only through an approved backend tool. The backend-generated complaint identifier is the authoritative ticket reference, and complaint status must come from the authoritative complaint service.

## When to create a complaint

Customers may ask "please raise a complaint", "I want to file a complaint", "create a ticket", "report this issue", or "I need this escalated".

Create a complaint when:

- An automated investigation cannot resolve the customer's issue.
- A transaction remains unresolved.
- A refund has failed or requires manual investigation.
- A recharge issue requires support intervention.
- A duplicate payment or duplicate recharge requires investigation.
- The customer reports suspicious activity.
- The support workflow explicitly requires escalation.

Do not tell the customer that a complaint exists until the backend returns a complaint identifier.

## What information a complaint must contain

A complaint should contain:

- A category.
- A concise issue description.
- Relevant verified references.
- Supporting information when available.
- Priority or severity when supported by the backend.

Use facts from authoritative lookups. Do not place passwords, OTPs, UPI PINs, CVVs, or other secrets in a complaint.

## Supported complaint categories

Supported complaint categories include:

- UPI payment issue.
- Refund issue.
- Mobile recharge issue.
- Account issue.
- Security or suspicious activity issue.

## Complaint status

A complaint may have statuses such as:

- Open.
- In Progress.
- Awaiting Customer Information.
- Escalated.
- Resolved.
- Closed.

Actual status values must come from the authoritative complaint service. Do not infer a status from the customer's description or from the age of the complaint.

## When to escalate a complaint

Escalation may be required when:

- An automated investigation cannot resolve the issue.
- Required transaction information is conflicting.
- A backend investigation reports an error.
- A refund requires manual review.
- A duplicate payment requires investigation.
- Suspicious activity is reported.
- A customer account requires security review.

Provide the escalation summary with verified facts, the current complaint reference, the reason for escalation, and the recommended next action.

## Adding information to an existing complaint

Customers may say "I have more details", "I want to add documents", "update my complaint", or "here is the missing information".

Support may add information only through an approved backend operation. Before adding information, validate that:

1. The complaint belongs to the authenticated customer, or the caller is otherwise authorized.
2. The information is relevant to the complaint.
3. The backend confirms the update.

Do not claim that information was added until the backend confirms the update.

## Closing a complaint

A complaint may be closed only through an authorized workflow after the appropriate resolution conditions are met. Support must not falsely mark a complaint as resolved.

Do not close a complaint because a customer stops responding, because a complaint is old, or because a related payment or refund status is merely pending.

## How to explain complaint status to a customer

When reporting complaint information to a customer:

- Use the verified ticket reference.
- Use the latest authoritative status.
- Clearly distinguish completed actions from pending actions.
- Explain what happens next when the workflow provides a next step.
- Do not invent investigation outcomes or resolution timelines.
