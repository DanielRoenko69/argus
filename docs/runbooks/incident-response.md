# Incident Response Runbook

This runbook defines how Argus handles security and operational
incidents. It is the **authoritative on-call playbook** and is
referenced from `SECURITY.md` and the NIS2 / DORA / SOC 2 audit
checklists.

Review cadence: quarterly + after any Sev1/Sev2 incident.

---

## Severity Model

| Severity | Definition                                          | Page on-call | First-response SLA |
|----------|-----------------------------------------------------|--------------|--------------------|
| **Sev1** | Service down OR data leak OR active attack          | Immediately  | 15 minutes         |
| **Sev2** | Major degradation, partial outage, security warning | Immediately  | 1 hour             |
| **Sev3** | Single-component degraded, no user impact yet       | Business hrs | 4 business hours   |
| **Sev4** | Cosmetic / minor — handled in regular sprint        | No paging    | Next business day  |

**Sev1 examples:** Argus unavailable, provider credentials compromised,
unencrypted PII in logs, ransom-message in admin UI.

**Sev2 examples:** One LLM provider failing, audit-log writes failing
but rest of system OK, sustained high-error rate on one endpoint.

---

## Eskalation Matrix

```
       Detection
            │
            ▼
    Primary On-Call ─── 15 min no response ───▶ Secondary On-Call
    (Platform Owner)                            (Security Lead)
            │                                          │
            └────── Sev1 confirmed ─────┬──────────────┘
                                        ▼
                                Incident Commander
                                  (Platform Owner)
                                        │
                       ┌────────────────┼────────────────┐
                       ▼                ▼                ▼
                  Comms Lead      Tech Lead          Scribe
              (Slack / Status)  (root-cause)    (timeline log)
```

For **Sev1 with regulator implications** (PII leak, payment data, NIS2
"signifikanter Vorfall"):

1. Platform Owner notifies Compliance Lead within **1 hour**
2. Compliance Lead drafts the **24-hour early-warning** for BSI/BaFin
   (NIS2 Art. 23 / DORA Art. 19)
3. Final incident notification within **72 hours** of detection
4. Closing report within **1 month** of resolution

---

## Response Process

### 1. Detection (T+0)

Sources: PagerDuty alert (paging integration via Alertmanager →
Webhook), Langfuse anomaly detector, manual report.

The on-call acknowledges within the SLA above. Acknowledgement starts
the timer for the next phase.

### 2. Containment (T+0 → T+30 min)

Goal: stop the bleeding before understanding the root cause.

- For service degradation: scale out, fail over to backup region, or
  enable circuit breaker
- For active attack: rotate compromised credentials (`mcp_api_keys`,
  Anthropic/Azure/Gitea keys), disable affected accounts, enable
  emergency IP allowlist (`mcp_allowed_ips`)
- For data leak: cut the leak path first (revoke key, disable
  endpoint), preserve forensic logs

Document every action taken in the incident channel. The Scribe
captures the timeline.

### 3. Mitigation (T+30 min → T+4 h)

- Deploy a fix, hotfix, or workaround
- Verify the fix resolves the symptoms (not just masks them)
- Communicate status to stakeholders via the Comms Lead
- Update the public status page if customer-facing

### 4. Resolution & Recovery (T+resolution)

- Confirm normal operation (key SLIs return to baseline)
- Re-enable any temporarily disabled features
- Restore from backup if data was lost (see `docs/BCP.md` for RPO/RTO
  targets)
- Verify with affected stakeholders before declaring resolved

### 5. Post-Mortem (within 5 business days)

Every Sev1 and Sev2 incident gets a written post-mortem using the
template at `docs/runbooks/postmortem-template.md`. Sev3 gets a
short-form post-mortem if there's a learning; Sev4 doesn't need one.

The post-mortem is **blameless** — focus on systems and processes,
not individual error. Findings feed back into:
- New runbooks for unfamiliar failure modes
- Updates to `docs/THREAT_MODEL.md` if a new threat-class appeared
- CI checks, alerting rules, or automation that prevents recurrence

---

## Communication

| Channel                  | Purpose                                |
|--------------------------|----------------------------------------|
| `#argus-incidents` Slack | Real-time coordination during response |
| Argus Status Page      | Customer-facing status updates         |
| Compliance Lead email    | Regulator-relevant escalations         |
| Issue tracker            | Post-mortem + follow-up actions        |

The Comms Lead is responsible for keeping these synchronized. The
Incident Commander focuses on coordination, not communication.

---

## Tooling

- **Paging:** Alertmanager → webhook → PagerDuty (or Opsgenie depending
  on team), configured in your deployment's alerting stack.
- **Metrics / Alerting:** Prometheus + Grafana dashboards. Workflow
  spend-anomaly routes flag unusual direct-provider usage.
- **Tracing:** OpenTelemetry → Phoenix / Langfuse for LLM-call traces.
- **Audit:** `mcp_audit_log` table (immutable, hash-chained) for any
  forensic timeline reconstruction.
- **Recovery:** see `docs/BCP.md` for backup mechanisms and Restore
  procedures.

---

## On-Call Rotation

The on-call rotation is managed in your paging tool (PagerDuty, Opsgenie
or similar). Primary on-call covers business hours
(09:00–18:00 CET), secondary covers off-hours.

Hand-over happens at a fixed time in your on-call channel with a brief on:
- Any open incidents
- Anomalies seen in the past 24 h
- Planned maintenance / risky deploys in the next 24 h
