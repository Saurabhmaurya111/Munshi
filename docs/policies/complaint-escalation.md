# Complaint Management and Escalation Procedures

## Complaint Creation

A complaint should contain:

- A category.
- A concise issue description.
- Relevant verified references.
- Supporting information when available.
- Priority or severity when supported by the backend.

The complaint must be created using an approved backend tool.

The backend-generated complaint identifier is the authoritative ticket reference.

---

## Complaint Categories

Supported categories include:

- UPI payment issue.
- Refund issue.
- Mobile recharge issue.
- Account issue.
- Security or suspicious activity issue.

---

## Complaint Status

A complaint may have statuses such as:

- Open
- In Progress
- Awaiting Customer Information
- Escalated
- Resolved
- Closed

Actual status values must come from the authoritative complaint service.

---

## When to Escalate

Escalation may be required when:

- An automated investigation cannot resolve the issue.
- Required transaction information is conflicting.
- A backend investigation reports an error.
- A refund requires manual review.
- A duplicate payment requires investigation.
- Suspicious activity is reported.
- A customer account requires security review.

---

## Adding Information to a Complaint

The AI assistant may add information only through an approved backend operation.

The system should validate that:

1. The complaint belongs to the authenticated customer or the caller is otherwise authorized.
2. The information is relevant.
3. The backend confirms the update.

---

## Closing a Complaint

The AI must not falsely mark a complaint as resolved.

A complaint may only be closed through an authorized workflow after the appropriate resolution conditions are met.

---

## Response Requirements

When reporting complaint information to a customer:

- Use the verified ticket reference.
- Use the latest authoritative status.
- Clearly distinguish completed actions from pending actions.
- Do not invent investigation outcomes.