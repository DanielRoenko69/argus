# Post-Mortem: <Incident Title>

> **Sev:** Sev1 / Sev2 / Sev3
> **Date:** YYYY-MM-DD
> **Duration:** HH:MM (from detection to resolution)
> **Author:** <name>
> **Status:** Draft / Approved
> **Stakeholders informed:** ☐ Platform Owner ☐ Security Lead ☐ Compliance Lead

## TL;DR

One paragraph: what happened, what was impacted, what we did, what
needs to change. Reads independently — the reader should be able to
stop here and still have the picture.

## Impact

| What was affected      | Severity | Duration   | Customer impact |
|------------------------|----------|------------|-----------------|
| <service / component>  | <sev>    | <duration> | <#users / data> |

## Timeline

All times in CET. Use the audit log + Slack channel transcript as the
authoritative source.

| Time   | Event                                            |
|--------|--------------------------------------------------|
| HH:MM  | <first symptom / first alert>                    |
| HH:MM  | On-call paged (`<channel>`)                      |
| HH:MM  | Incident declared Sev<n>; Incident Commander = … |
| HH:MM  | Root cause identified                            |
| HH:MM  | Mitigation deployed                              |
| HH:MM  | Verified resolved; SLIs back to baseline         |

## Root Cause

The actual underlying cause, not just the trigger. Distinguish:
- **Trigger** — what initiated the failure
- **Contributing factors** — what made the trigger turn into an incident
- **Root cause** — the systemic gap that allowed it (often a missing
  guardrail, monitor, or process step)

Use the "Five Whys" framing if helpful.

## What Went Well

Things to **keep doing**. Don't skip this — celebrating what worked
prevents future regression of the things that helped.

## What Went Wrong

Process and tooling gaps. Be specific. Blameless: critique systems and
decisions, not people.

## Lessons Learned

What does this incident teach us about how Argus should evolve?
Patterns worth generalising.

## Action Items

| #  | Action                                | Owner   | Due       | Jira      | Done |
|----|---------------------------------------|---------|-----------|-----------|------|
| 1  | <prevent / detect / recover faster>   | <name>  | YYYY-MM-DD| ARGUS-1234 | ☐    |
| 2  | <update runbook section X>            |         |           |           | ☐    |
| 3  | <add alert / SLO / monitor>           |         |           |           | ☐    |

Action items must have a Jira ticket so follow-through is trackable.
The Platform Owner reviews open action items monthly.

## Detection Improvements

How would we detect this **faster** next time? Concrete answers
(alert rule, metric, log query). Not "monitor better."

## Prevention Improvements

How would we **prevent** this entirely next time? Concrete answers
(architectural change, test, schema constraint, CI check).

## Recovery Improvements

How would we **recover faster** next time? Concrete answers (runbook
section, automation script, backup).

## Compliance / Regulator Notification

For Sev1 incidents that touched customer data or critical
infrastructure (NIS2 Art. 23 / DORA Art. 19):

- ☐ 24-hour early-warning sent (date, recipient, reference number)
- ☐ 72-hour incident notification sent (date, reference)
- ☐ 1-month closing report sent (date)

Compliance Lead owns this section.

## Threat-Model Updates

If this incident exposed a new threat class or invalidated a mitigation
in `docs/THREAT_MODEL.md`, link the PR that updates the threat model.

---

## Approval

| Role             | Name | Date | Sign-off |
|------------------|------|------|----------|
| Author           |      |      |          |
| Platform Owner   |      |      |          |
| Security Lead    |      |      | (Sev1/2) |
| Compliance Lead  |      |      | (regulator-relevant) |
