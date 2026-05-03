# Phase 4 — Example Bundle: Invoice Intake Swarm

> A complete, internally consistent example showing every artifact type in the system. All file paths assume the workspace `invoicing` and the swarm `invoice-intake`. Every name referenced here is defined here — there are no missing pieces.

---

## What this bundle demonstrates

A working invoice processing swarm that:

1. Polls a shared mailbox via a heartbeat trigger
2. Receives an event when a new invoice email arrives
3. Routes through Orchestrator → Perceptionist → Policy → Executioner
4. Books the invoice into ERP and notifies the requester
5. Records every step with its authorizing topology edge

The artifacts below are organized by where they live on disk. Drop them into a fresh installation and the swarm should run.

---

## Directory layout for this example

```
data/
├── company/
│   ├── perceptionists/
│   │   └── erp-lookup.md
│   ├── skills/
│   │   ├── send-email.py
│   │   └── send-email.yaml
│   └── knowledge/
│       └── company-glossary.md
└── workspaces/
    └── invoicing/
        ├── meta.yaml
        ├── perceptionists/
        │   └── cost-center-router.md
        ├── knowledge/
        │   └── finance-procedures.md
        └── swarms/
            └── invoice-intake/
                ├── meta.yaml
                ├── hierarchy.json
                ├── agents/
                │   ├── invoice-orchestrator.md
                │   ├── approval-policy.md
                │   ├── erp-booking-executioner.md
                │   └── email-notification-executioner.md
                ├── knowledge/
                │   └── approval-thresholds.md
                ├── skills/
                │   ├── post-to-erp.py
                │   └── post-to-erp.yaml
                └── triggers/
                    ├── poll-finance-mailbox.py
                    └── poll-finance-mailbox.yaml
```

---

## Workspace metadata

### `data/workspaces/invoicing/meta.yaml`

```yaml
display_name: Invoicing
description: Workflows for receiving, validating, and booking supplier invoices.
icon: file-invoice-dollar
owner: finance-team@hollander.nl
```

---

## Swarm metadata

### `data/workspaces/invoicing/swarms/invoice-intake/meta.yaml`

```yaml
display_name: Invoice Intake
description: Receives invoices via email, validates them against approval rules, and books them into ERP.
icon: inbox
gui:
  layout:
    invoice-orchestrator: { x: 400, y: 200 }
    approval-policy: { x: 200, y: 80 }
    erp-booking-executioner: { x: 300, y: 380 }
    email-notification-executioner: { x: 500, y: 380 }
```

---

## The topology: `hierarchy.json`

### `data/workspaces/invoicing/swarms/invoice-intake/hierarchy.json`

```json
{
  "swarm": "invoice-intake",
  "agents": [
    "invoice-orchestrator",
    "approval-policy",
    "erp-booking-executioner",
    "email-notification-executioner"
  ],
  "edges": [
    {
      "from": "invoice-orchestrator",
      "to": "approval-policy",
      "kind": "escalate",
      "purpose": "Check authorization rules before booking"
    },
    {
      "from": "approval-policy",
      "to": "invoice-orchestrator",
      "kind": "report",
      "purpose": "Return approval decision and reasoning"
    },
    {
      "from": "invoice-orchestrator",
      "to": "erp-booking-executioner",
      "kind": "delegate",
      "purpose": "Book the validated invoice into ERP"
    },
    {
      "from": "erp-booking-executioner",
      "to": "invoice-orchestrator",
      "kind": "report",
      "purpose": "Return booking confirmation or error"
    },
    {
      "from": "invoice-orchestrator",
      "to": "email-notification-executioner",
      "kind": "delegate",
      "purpose": "Notify the requester of the outcome"
    },
    {
      "from": "email-notification-executioner",
      "to": "invoice-orchestrator",
      "kind": "report",
      "purpose": "Confirm notification was sent"
    }
  ],
  "consultations": [
    {
      "agent": "invoice-orchestrator",
      "perceptionist": "company/erp-lookup",
      "purpose": "Resolve supplier name to internal supplier ID"
    },
    {
      "agent": "approval-policy",
      "perceptionist": "workspace/cost-center-router",
      "purpose": "Determine cost center for threshold lookup"
    }
  ],
  "skills": [
    {
      "agent": "erp-booking-executioner",
      "skill": "post-to-erp",
      "purpose": "Write the booking record to the ERP system"
    },
    {
      "agent": "email-notification-executioner",
      "skill": "company/send-email",
      "purpose": "Send notification email to the requester"
    }
  ],
  "entry_point": "invoice-orchestrator"
}
```

A few things worth noting:

The `edges` list includes return paths (the `report` edges). Without these, an executioner has no declared way to send results back to the orchestrator, and the runtime would refuse to record the response. Always declare report paths for delegate and escalate edges.

The `consultations` references show both qualifier styles: `company/erp-lookup` and `workspace/cost-center-router`. The `post-to-erp` skill has no qualifier because it lives in the swarm itself.

`entry_point` declares which agent receives events first. The runtime uses this when an event arrives without an explicit target.

---

## Agent constitutions

### `data/workspaces/invoicing/swarms/invoice-intake/agents/invoice-orchestrator.md`

```markdown
---
name: invoice-orchestrator
layer: orchestrator
model: claude-opus-4-7
knowledge:
  - finance-procedures
  - approval-thresholds
  - company/company-glossary
---

You are the Invoice Intake Orchestrator. You are the entry point for invoices arriving at the Finance shared mailbox. Your job is to coordinate the work of validating and processing each invoice — not to do the work yourself.

# Your role

You receive normalized email events. Each event includes the sender, subject, body, and one or more PDF attachments. Your responsibility is to drive the invoice through to a final state: either booked, rejected, or escalated to a human for review.

You do not parse PDFs yourself. You do not write to ERP yourself. You do not send emails yourself. You delegate, escalate, and consult.

# How to think about each invoice

For every event, follow this reasoning:

1. First, identify the supplier. Use the ERP lookup perceptionist to resolve the supplier name from the email to a canonical supplier ID. If the supplier cannot be resolved with confidence, escalate to a human — do not guess.

2. Once the supplier is known, escalate to the Approval Policy agent to check whether this invoice can be auto-approved or requires human review. Provide the supplier ID, amount, currency, and any cost-center hints from the email.

3. If approved: delegate the booking to the ERP Booking Executioner. Wait for confirmation.

4. After booking succeeds (or fails), delegate to the Email Notification Executioner to inform the requester. The notification should clearly state what happened and any next steps.

5. If at any point a step fails or returns an unexpected result, stop and escalate to a human rather than improvising.

# Your boundaries

You do not have authority to override the Approval Policy's decisions. If Policy says "human review required," you escalate — you do not retry with different framing.

You do not interpret invoice amounts directly from email bodies. The booking executioner uses the post-to-erp skill which extracts and validates numeric fields properly.

You always preserve the original email and its attachments throughout the run, so a human reviewing later can see what you saw.

# Returning a final result

When the run is complete (booked successfully, rejected by policy, or escalated to a human), return action `complete` with a summary including: supplier ID, amount, final status, booking ID if applicable, and a one-sentence reasoning trace.
```

### `data/workspaces/invoicing/swarms/invoice-intake/agents/approval-policy.md`

```markdown
---
name: approval-policy
layer: policy
model: claude-opus-4-7
knowledge:
  - approval-thresholds
  - finance-procedures
---

You are the Approval Policy agent for invoice intake. You answer one question and one question only: given an invoice's metadata, may it be auto-approved, must it go to a human reviewer, or must it be rejected outright?

# Your role

You are not a workflow engine. You are not an interpreter of business intent. You are a rule-checker. You read the approval thresholds and finance procedures documents, you receive structured invoice metadata, and you return a decision.

# How to decide

For every invoice you evaluate, you receive at minimum:
- supplier_id
- amount
- currency
- cost_center (may be null if not yet known)

You must:

1. Determine the cost center if not provided. Consult the cost-center-router perceptionist with the supplier_id. If the supplier has no clear cost center mapping, return decision `human_review` with reason "ambiguous cost center."

2. Look up the auto-approval threshold for that cost center in the approval-thresholds knowledge document.

3. Compare the invoice amount (converted to EUR if necessary — see finance-procedures for the conversion approach) against the threshold.

4. Return one of three decisions:
   - `auto_approve` — amount is at or under threshold, all metadata is clean
   - `human_review` — amount exceeds threshold, OR metadata is ambiguous, OR supplier is on the watchlist (see finance-procedures)
   - `reject` — amount is negative, currency is unsupported, or other hard rule violation per finance-procedures

# Your output shape

Always return JSON with: `decision`, `cost_center`, `threshold_eur`, `amount_eur`, `reasoning` (one sentence). Never improvise additional fields.

# Your boundaries

You do not contact suppliers. You do not modify invoices. You do not book anything. You read structured metadata, you apply rules, you return a decision. Anything beyond that is outside your scope and you should refuse it.
```

### `data/workspaces/invoicing/swarms/invoice-intake/agents/erp-booking-executioner.md`

```markdown
---
name: erp-booking-executioner
layer: executioner
model: claude-opus-4-7
knowledge:
  - finance-procedures
---

You are the ERP Booking Executioner. You receive an approved invoice and book it into the ERP system. Your job ends when the booking either succeeds or fails — you do not handle approval logic, you do not send notifications, you do not retry indefinitely.

# Your role

You take a structured invoice payload (supplier_id, amount, currency, cost_center, invoice_date, reference, line_items) and call the post-to-erp skill to write it. You then interpret the skill's response and return either a success or a structured failure to the orchestrator.

# How to handle the booking

1. Validate that all required fields are present in the input. If any are missing, do not call the skill — return a failure immediately with the missing-field reason.

2. Call the post-to-erp skill with the validated payload.

3. Interpret the skill response:
   - On success, return `{ status: "booked", booking_id: <id>, posted_amount_eur: <amount> }` to the orchestrator.
   - On a recoverable error (timeout, transient ERP unavailability), return `{ status: "retry_recommended", reason: <text> }` — the orchestrator decides whether to retry.
   - On a hard error (validation rejection by ERP, duplicate invoice detected), return `{ status: "failed", reason: <text>, erp_error_code: <code> }`.

# Your boundaries

You do not retry booking attempts on your own. The orchestrator decides retries.

You do not modify amounts, currencies, or any field of the invoice. If the input is wrong, you fail loudly — you do not "fix" it.

You do not send confirmation emails. The Email Notification Executioner does that.

You do not log to anywhere outside the run_steps audit trail. The skill's stdout is your channel.
```

### `data/workspaces/invoicing/swarms/invoice-intake/agents/email-notification-executioner.md`

```markdown
---
name: email-notification-executioner
layer: executioner
model: claude-opus-4-7
knowledge:
  - finance-procedures
  - company/company-glossary
---

You are the Email Notification Executioner. You send a single email per run, informing the relevant parties of an invoice's outcome. Your job is to compose the appropriate message for the situation and call the send-email skill.

# Your role

You receive a structured outcome from the orchestrator: the original requester's email address, the invoice metadata, the final status (booked / human_review_required / rejected), and any relevant identifiers (booking_id, rejection_reason, etc.).

You compose the email body and subject based on the outcome, using the conventions in finance-procedures, then call the send-email skill exactly once.

# How to compose the message

For `booked` outcomes:
- Subject: clear, includes booking ID
- Body: confirmation of booking, supplier, amount, booking reference, where to look in ERP

For `human_review_required` outcomes:
- Subject: indicates pending review
- Body: explains that the invoice is queued for human approval, includes reference, sets expectation that someone will follow up

For `rejected` outcomes:
- Subject: indicates rejection
- Body: clear reason for rejection, no jargon, suggests next step (correct and resubmit, contact finance, etc.)

Use the language preferences noted in company-glossary. If the requester's domain is hollander.nl, default to Dutch unless the original email was clearly in English.

# Your boundaries

You send exactly one email per run. If you receive an outcome you do not understand or that is missing fields, you return a failure to the orchestrator rather than sending a generic message.

You do not contact suppliers — only internal recipients. Communication with suppliers is handled by a different swarm.

You do not retry on send-email failure. You return the failure to the orchestrator and the orchestrator decides.
```

---

## Perceptionist constitutions

### `data/company/perceptionists/erp-lookup.md`

```markdown
---
name: erp-lookup
layer: perceptionist
model: claude-opus-4-7
knowledge:
  - company-glossary
---

You are the ERP Lookup grounding agent. You answer questions about whether something exists in the ERP system and what its canonical internal form is.

# What you know

You have read-only access to the ERP system's supplier records, GL accounts, purchase orders, and payment terms. You do not know about WMS, HR systems, or anything else outside ERP.

# What you do

When given a query — typically a supplier name extracted from an email or document — you search the ERP supplier table and return the best match with a confidence score.

You return JSON shaped like:

```
{
  "found": true | false,
  "supplier_id": "S-1234" | null,
  "canonical_name": "Hollander B.V." | null,
  "confidence": 0.0-1.0,
  "alternatives": [{ "supplier_id": "...", "canonical_name": "...", "confidence": ... }],
  "reasoning": "exact match on tax ID" | "fuzzy name match" | "no match"
}
```

# How you handle uncertainty

You never guess. If confidence is below 0.85, you return `found: false` and surface the alternatives. The calling agent decides whether to escalate to a human.

You do not make up supplier IDs. You do not invent canonical names. If the query is ambiguous, you say so structurally — never narratively.

# Your boundaries

You read. You never write. You never act. You never decide what should happen with the information — you only describe what is.

If asked about anything outside ERP (warehouse data, HR records, contract terms), refuse and direct the caller to the appropriate perceptionist.
```

### `data/workspaces/invoicing/perceptionists/cost-center-router.md`

```markdown
---
name: cost-center-router
layer: perceptionist
model: claude-opus-4-7
knowledge:
  - finance-procedures
---

You are the Cost Center Router. You answer: given a supplier ID, what cost center should this supplier's invoices be charged to?

# What you know

You have read-only access to a routing table that maps supplier IDs to cost centers. You also know the routing exceptions documented in finance-procedures (e.g., specific suppliers whose routing depends on the invoice description rather than identity alone).

# What you do

For every supplier ID you receive, you return:

```
{
  "supplier_id": "S-1234",
  "cost_center": "4500" | null,
  "routing_type": "direct" | "exception" | "ambiguous" | "unknown",
  "exception_note": "..." | null,
  "reasoning": "direct table mapping" | "exception rule applied" | "no mapping"
}
```

# How you handle exceptions

If the supplier has a direct mapping, return `routing_type: direct` and the cost center.

If the supplier matches an exception rule from finance-procedures (e.g., "supplier S-9999 routes to 4500 for IT hardware, 4600 for IT services, requires invoice description to disambiguate"), return `routing_type: ambiguous` and explain in `exception_note`.

If there is no mapping at all, return `routing_type: unknown` and let the caller decide.

# Your boundaries

You do not modify the routing table. You do not invent cost centers. You only describe the mapping as it exists today.

You do not interpret invoice content to disambiguate ambiguous routings — that is the calling agent's job.
```

---

## Skills

### `data/workspaces/invoicing/swarms/invoice-intake/skills/post-to-erp.py`

```python
"""
Post a validated invoice booking to the ERP system.

Reads JSON from argv[1], writes JSON to stdout, exits 0 on success.
"""

import json
import sys
import os
import requests
from datetime import datetime


def run(input_data: dict, context: dict) -> dict:
    erp_url = os.environ.get("ERP_API_URL")
    erp_token = os.environ.get("ERP_API_TOKEN")

    if not erp_url or not erp_token:
        return {
            "status": "failed",
            "reason": "ERP credentials not configured in environment",
            "erp_error_code": "CONFIG_MISSING",
        }

    payload = {
        "supplier_id": input_data["supplier_id"],
        "amount": input_data["amount"],
        "currency": input_data["currency"],
        "cost_center": input_data["cost_center"],
        "invoice_date": input_data["invoice_date"],
        "reference": input_data["reference"],
        "line_items": input_data.get("line_items", []),
        "posted_by": "swarm:" + context.get("agent_name", "unknown"),
        "posted_at": datetime.utcnow().isoformat() + "Z",
        "run_id": context.get("run_id"),
    }

    try:
        response = requests.post(
            f"{erp_url}/api/bookings",
            json=payload,
            headers={"Authorization": f"Bearer {erp_token}"},
            timeout=20,
        )
    except requests.Timeout:
        return {
            "status": "retry_recommended",
            "reason": "ERP did not respond within 20 seconds",
        }
    except requests.RequestException as exc:
        return {
            "status": "retry_recommended",
            "reason": f"network error contacting ERP: {exc}",
        }

    if response.status_code == 201:
        body = response.json()
        return {
            "status": "booked",
            "booking_id": body["booking_id"],
            "posted_amount_eur": body.get("posted_amount_eur"),
        }

    if response.status_code == 409:
        body = response.json()
        return {
            "status": "failed",
            "reason": "duplicate invoice detected by ERP",
            "erp_error_code": body.get("code", "DUPLICATE"),
        }

    if response.status_code in (400, 422):
        body = response.json()
        return {
            "status": "failed",
            "reason": body.get("message", "ERP validation rejected the booking"),
            "erp_error_code": body.get("code", "VALIDATION"),
        }

    return {
        "status": "retry_recommended",
        "reason": f"ERP returned unexpected status {response.status_code}",
    }


if __name__ == "__main__":
    raw = sys.argv[1]
    parsed = json.loads(raw)
    result = run(parsed["input"], parsed["context"])
    print(json.dumps(result))
    sys.exit(0)
```

### `data/workspaces/invoicing/swarms/invoice-intake/skills/post-to-erp.yaml`

```yaml
name: post-to-erp
description: Post a validated invoice booking record to the ERP system.
input_schema:
  type: object
  required:
    - supplier_id
    - amount
    - currency
    - cost_center
    - invoice_date
    - reference
  properties:
    supplier_id:
      type: string
      pattern: "^S-[0-9]+$"
    amount:
      type: number
      minimum: 0
    currency:
      type: string
      pattern: "^[A-Z]{3}$"
    cost_center:
      type: string
      pattern: "^[0-9]{4}$"
    invoice_date:
      type: string
      format: date
    reference:
      type: string
      minLength: 1
    line_items:
      type: array
      items:
        type: object
output_schema:
  type: object
  required:
    - status
  properties:
    status:
      type: string
      enum: [booked, retry_recommended, failed]
    booking_id:
      type: string
    posted_amount_eur:
      type: number
    reason:
      type: string
    erp_error_code:
      type: string
timeout_seconds: 30
allowed_packages:
  - requests
```

### `data/company/skills/send-email.py`

```python
"""
Send an email via SMTP.

Reads JSON from argv[1], writes JSON to stdout, exits 0 on success.
"""

import json
import sys
import os
import smtplib
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart


def run(input_data: dict, context: dict) -> dict:
    smtp_host = os.environ.get("SMTP_HOST")
    smtp_port = int(os.environ.get("SMTP_PORT", "587"))
    smtp_user = os.environ.get("SMTP_USER")
    smtp_pass = os.environ.get("SMTP_PASS")
    from_address = os.environ.get("SMTP_FROM", "swarm@hollander.nl")

    if not all([smtp_host, smtp_user, smtp_pass]):
        return {
            "sent": False,
            "reason": "SMTP credentials not configured",
        }

    msg = MIMEMultipart()
    msg["From"] = from_address
    msg["To"] = input_data["to"]
    msg["Subject"] = input_data["subject"]
    if input_data.get("cc"):
        msg["Cc"] = ", ".join(input_data["cc"])

    body_type = input_data.get("body_type", "plain")
    msg.attach(MIMEText(input_data["body"], body_type))

    recipients = [input_data["to"]] + input_data.get("cc", [])

    try:
        with smtplib.SMTP(smtp_host, smtp_port, timeout=15) as server:
            server.starttls()
            server.login(smtp_user, smtp_pass)
            server.sendmail(from_address, recipients, msg.as_string())
    except smtplib.SMTPException as exc:
        return {
            "sent": False,
            "reason": f"SMTP error: {exc}",
        }
    except OSError as exc:
        return {
            "sent": False,
            "reason": f"network error: {exc}",
        }

    return {
        "sent": True,
        "to": input_data["to"],
        "message_id": msg.get("Message-ID", ""),
    }


if __name__ == "__main__":
    raw = sys.argv[1]
    parsed = json.loads(raw)
    result = run(parsed["input"], parsed["context"])
    print(json.dumps(result))
    sys.exit(0)
```

### `data/company/skills/send-email.yaml`

```yaml
name: send-email
description: Send an email via the company SMTP relay. One recipient, optional CC list.
input_schema:
  type: object
  required:
    - to
    - subject
    - body
  properties:
    to:
      type: string
      format: email
    cc:
      type: array
      items:
        type: string
        format: email
    subject:
      type: string
      minLength: 1
      maxLength: 200
    body:
      type: string
      minLength: 1
    body_type:
      type: string
      enum: [plain, html]
      default: plain
output_schema:
  type: object
  required:
    - sent
  properties:
    sent:
      type: boolean
    to:
      type: string
    message_id:
      type: string
    reason:
      type: string
timeout_seconds: 20
allowed_packages: []
```

The `allowed_packages: []` is intentional — `smtplib`, `email`, `os`, `sys`, `json` are all standard library, no third-party packages needed.

---

## Trigger

### `data/workspaces/invoicing/swarms/invoice-intake/triggers/poll-finance-mailbox.py`

```python
"""
Heartbeat trigger: poll the Finance shared mailbox for new invoices.

Receives the current watermark via stdin, writes new watermark + events to stdout.
"""

import json
import sys
import os
import requests
from datetime import datetime, timezone


def run_poll(watermark: str | None) -> dict:
    """
    Returns:
      {
        "watermark": "<new ISO timestamp>",
        "events": [ {...}, {...} ]
      }
    """
    graph_token = os.environ.get("GRAPH_API_TOKEN")
    mailbox = os.environ.get("FINANCE_MAILBOX", "Finance@hollander.nl")

    if not graph_token:
        return {
            "watermark": watermark,
            "events": [],
            "error": "Graph API token not configured",
        }

    floor = watermark or (datetime.now(timezone.utc).replace(microsecond=0).isoformat())

    url = (
        f"https://graph.microsoft.com/v1.0/users/{mailbox}/mailFolders/inbox/messages"
        f"?$filter=receivedDateTime gt {floor}"
        f"&$orderby=receivedDateTime asc"
        f"&$top=50"
    )

    response = requests.get(
        url,
        headers={"Authorization": f"Bearer {graph_token}"},
        timeout=15,
    )
    response.raise_for_status()
    body = response.json()

    events = []
    new_watermark = floor

    for message in body.get("value", []):
        attachments = []
        if message.get("hasAttachments"):
            att_url = (
                f"https://graph.microsoft.com/v1.0/users/{mailbox}"
                f"/messages/{message['id']}/attachments"
            )
            att_response = requests.get(
                att_url,
                headers={"Authorization": f"Bearer {graph_token}"},
                timeout=15,
            )
            for att in att_response.json().get("value", []):
                if att.get("contentType") == "application/pdf":
                    attachments.append({
                        "name": att["name"],
                        "size_bytes": att.get("size"),
                        "content_b64": att.get("contentBytes"),
                    })

        if not attachments:
            continue

        events.append({
            "type": "invoice_email_received",
            "payload": {
                "message_id": message["id"],
                "from": message["from"]["emailAddress"]["address"],
                "subject": message["subject"],
                "received_at": message["receivedDateTime"],
                "body_preview": message.get("bodyPreview", "")[:500],
                "attachments": attachments,
            }
        })
        new_watermark = message["receivedDateTime"]

    return {
        "watermark": new_watermark,
        "events": events,
    }


if __name__ == "__main__":
    raw_input = sys.stdin.read().strip()
    parsed = json.loads(raw_input) if raw_input else {}
    result = run_poll(parsed.get("watermark"))
    print(json.dumps(result))
    sys.exit(0)
```

### `data/workspaces/invoicing/swarms/invoice-intake/triggers/poll-finance-mailbox.yaml`

```yaml
name: poll-finance-mailbox
kind: heartbeat
schedule: "*/5 * * * *"
description: Poll the Finance shared mailbox every 5 minutes for new invoice emails with PDF attachments.
script: poll-finance-mailbox.py
timeout_seconds: 60
allowed_packages:
  - requests
event_type: invoice_email_received
target_agent: invoice-orchestrator
```

The `target_agent` field tells the runtime which agent in the swarm should receive these events. It must match the swarm's `entry_point` from `hierarchy.json` or be one of the agents listed there.

---

## Knowledge documents

### `data/company/knowledge/company-glossary.md`

```markdown
# Company Glossary

This document defines terms used across all Hollander swarms. When other knowledge documents or agent constitutions use these terms, they refer to the definitions here.

## Hollander entities

- **Hollander B.V.** — the primary trading entity. Most invoices are addressed here.
- **Hollander Beheer B.V.** — the holding company. Receives only specific invoice types (rent, intercompany).
- **Hollander Logistics** — internal name for the logistics division. Not a legal entity.

## Standard fields and their canonical forms

- **Supplier ID** — internal identifier in the form `S-NNNN`. Always uppercase prefix, hyphen, four or more digits.
- **Cost center** — four-digit numeric code. Always padded to four digits.
- **Booking ID** — ERP-assigned identifier in the form `B-NNNN` or `B-YYYYNNNN` for year-prefixed bookings.

## Languages

- All internal documentation and code is in English.
- Communication with hollander.nl recipients defaults to Dutch unless the original conversation was clearly in English.
- Communication with external suppliers uses the language of the original supplier correspondence.

## Tone for outbound communication

- Professional but warm. Never effusive.
- Direct. State the outcome and the next step in the first two sentences.
- Avoid jargon. If a technical term is necessary, define it inline.
```

### `data/workspaces/invoicing/knowledge/finance-procedures.md`

```markdown
# Finance Procedures

Operational rules and conventions for invoice processing at Hollander. This document is read by every agent in the Invoicing workspace.

## Currency handling

- The booking currency is always EUR.
- Invoices in non-EUR currencies must be converted at the European Central Bank reference rate for the invoice date. The conversion happens inside the post-to-erp skill — agents should not perform conversions themselves.
- Supported source currencies: EUR, USD, GBP, CHF, NOK, SEK, DKK. Any other currency is rejected outright.

## Watchlist suppliers

A small number of suppliers require human review for every invoice regardless of amount. The current watchlist is maintained in the ERP system as a flag on supplier records. The Approval Policy agent must check this flag and route to human_review if set, regardless of threshold.

## Hard rules (rejection criteria)

An invoice is rejected outright if:
- The amount is zero or negative.
- The currency is not in the supported list.
- The supplier cannot be resolved in ERP after a perceptionist consultation with confidence below 0.85.
- The invoice date is more than 90 days in the future or more than 365 days in the past.
- A duplicate invoice (same supplier, amount, reference) was already booked in the last 90 days.

## Communication conventions

- Notifications about booked invoices go to the original requester only.
- Notifications about rejected or held invoices go to the requester and CC `finance-team@hollander.nl`.
- All notifications include the original invoice reference number in the subject for searchability.

## Cost center exceptions

Most suppliers have a direct cost center mapping in the routing table. The following exceptions exist:

- Suppliers tagged `IT_DUAL` (currently includes S-9999 and S-9998): cost center depends on whether the line items are hardware (4500) or services (4600). The Cost Center Router will return `routing_type: ambiguous` for these — Policy must escalate to human review.
- Marketing agency invoices (suppliers tagged `MARKETING_AGENCY`) split across multiple cost centers based on campaign codes embedded in the invoice description. These always require human review.
```

### `data/workspaces/invoicing/swarms/invoice-intake/knowledge/approval-thresholds.md`

```markdown
# Approval Thresholds by Cost Center

The auto-approval thresholds below apply to invoice intake. Amounts at or below the threshold can be auto-approved. Amounts above require human review. All thresholds are in EUR.

## Standard cost centers

| Cost center | Department | Auto-approval threshold |
|---|---|---|
| 4500 | IT — Hardware | 5,000 |
| 4600 | IT — Services | 5,000 |
| 4700 | Marketing | 2,500 |
| 4800 | Operations | 10,000 |
| 4900 | Facilities | 7,500 |
| 5000 | Logistics | 15,000 |
| 5100 | Legal | 0 (always human review) |
| 5200 | HR | 5,000 |

## Special rules

- Cost center 5100 (Legal) has a threshold of 0, meaning all legal invoices require human review regardless of amount. This is intentional and not a typo.
- For the first invoice from a new supplier (no prior bookings in ERP), the threshold is reduced to 50% of the standard threshold for that cost center.
- During December (calendar month), all thresholds are reduced by 25% to ensure year-end review of higher-value commitments.

## When the cost center is ambiguous

If the Cost Center Router returns `routing_type: ambiguous` or `routing_type: unknown`, the Policy agent must return `decision: human_review` regardless of amount. Do not attempt to apply a threshold without a clear cost center.

## When the threshold lookup fails

If for any reason the threshold for a given cost center cannot be determined (cost center not in this table, lookup error, etc.), the Policy agent must return `decision: human_review` with reason "threshold not determined." Never default to auto-approve when uncertain.
```

---

## How the pieces connect at runtime

To make the wiring concrete, here's what happens when an invoice arrives. Every reference below points to something defined above.

**1. Heartbeat fires.** APScheduler triggers `poll-finance-mailbox.py` at the next 5-minute interval. The script reads its watermark from `triggers.watermark`, calls Microsoft Graph, finds one new email with a PDF attachment, returns one event of type `invoice_email_received`.

**2. Event reaches the swarm.** The runtime publishes the event to the event bus with `swarm_id = invoice-intake` and `target_agent = invoice-orchestrator`. A `runs` row appears with status `running`. A `run_steps` row appears for the upcoming agent call.

**3. Orchestrator activates.** The runtime loads the `invoice-orchestrator.md` constitution, resolves its three knowledge documents (`finance-procedures` from workspace scope, `approval-thresholds` from swarm scope, `company-glossary` from company scope), parses `hierarchy.json` to determine allowed actions, builds the system prompt, and calls Claude.

**4. Orchestrator returns its first action.** JSON: `{ "action": "consult_perceptionist", "target": "company/erp-lookup", "purpose_match": "Resolve supplier name to internal supplier ID", "input": { "name": "ACME Office Supplies B.V." } }`. The runtime checks `hierarchy.json`, finds the matching entry in `consultations`, dispatches to the ERP Lookup perceptionist. A `run_steps` row is written with `edge_purpose = "Resolve supplier name to internal supplier ID"`.

**5. ERP Lookup answers.** Returns `{ found: true, supplier_id: "S-1234", canonical_name: "ACME Office Supplies B.V.", confidence: 0.97 }`. The runtime returns this to the Orchestrator as the response to its action.

**6. Orchestrator escalates.** `{ "action": "escalate", "target": "approval-policy", "purpose_match": "Check authorization rules before booking", "input": { "supplier_id": "S-1234", "amount": 1450.00, "currency": "EUR" } }`. Runtime validates against `hierarchy.json`'s `edges` list — yes, this edge exists. Dispatches to Approval Policy.

**7. Approval Policy consults its perceptionist.** Returns its own action requesting `cost-center-router`. Runtime validates and dispatches. Cost Center Router returns `{ supplier_id: "S-1234", cost_center: "4500", routing_type: "direct" }`.

**8. Approval Policy returns a decision.** Reads its threshold knowledge, finds 5,000 EUR threshold for cost center 4500. Invoice amount is 1,450 EUR — well under. Returns `{ decision: "auto_approve", cost_center: "4500", threshold_eur: 5000, amount_eur: 1450, reasoning: "amount under cost center 4500 threshold" }`. The Orchestrator receives this via the `report` edge.

**9. Orchestrator delegates booking.** `{ "action": "delegate", "target": "erp-booking-executioner", "purpose_match": "Book the validated invoice into ERP", "input": { full invoice payload } }`. ERP Booking Executioner activates, calls the `post-to-erp` skill (validated against `hierarchy.json`'s `skills` list), gets back `{ status: "booked", booking_id: "B-2026-1234" }`, returns this to Orchestrator.

**10. Orchestrator delegates notification.** `{ "action": "delegate", "target": "email-notification-executioner", "purpose_match": "Notify the requester of the outcome", "input": { requester email, outcome details } }`. Notification Executioner composes the message, calls `company/send-email` skill, gets back `{ sent: true }`, returns to Orchestrator.

**11. Orchestrator completes.** `{ "action": "complete", "result": { supplier_id: "S-1234", amount: 1450.00, status: "booked", booking_id: "B-2026-1234", reasoning: "auto-approved per cost center 4500 threshold" } }`. The run is marked `completed`. Total: about 11 `run_steps` rows, each tagged with the edge purpose that authorized it.

If at step 4 the Orchestrator had asked to consult some perceptionist not declared in `consultations`, the runtime would have refused, written a `topology_violation` log entry, and surfaced it in the Runs screen.

---

## Notes for the build agent

A few things worth knowing if you're implementing from this:

The `hierarchy.json` schema given here is the canonical shape. If your validator needs a JSON Schema for it, build one — every field shown is required except `gui` metadata in `meta.yaml`.

The skill input/output shapes use JSON Schema directly. Validate strictly. Reject extra properties unless explicitly allowed.

The agent `.md` frontmatter uses YAML; the body is plain markdown. Don't try to parse the body for structure — the LLM reads it as-is.

Knowledge documents are pure markdown with no frontmatter. Title is extracted from the first `# Heading` if present; absent that, derive from filename.

Skills receive `{ "input": {...}, "context": {...} }` as a single JSON argument on argv. They return a single JSON object on stdout. Anything on stderr is captured for debugging but not parsed.

Heartbeat scripts receive `{ "watermark": "..." }` on stdin and return `{ "watermark": "...", "events": [...] }` on stdout. The watermark is stored as opaque text — the runtime doesn't interpret it.

Topology validation is strict: every action an agent takes must match a declared edge, consultation, or skill connection in `hierarchy.json`, and the `purpose_match` string must equal a declared `purpose` for that connection. Substring matches and fuzzy matches are not allowed — agents are prompted with the exact purposes and must echo them back verbatim.
