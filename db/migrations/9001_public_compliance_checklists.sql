-- Public release: neutral English compliance checklists.
--
-- Migration 9000 removes the historical pre-built skills. The compliance
-- workspace still needs one checklist skill per framework before an
-- assessment can start, so this migration ships a fresh, provider- and
-- organisation-neutral checklist for each seeded framework (EU AI Act, NIS2,
-- ISO/IEC 27001, DORA, SOC 2) and links it to the framework.
--
-- The checklists support an evidence-based technical review. They are not
-- legal advice and do not certify compliance; applicability is decided by the
-- operator. Administrators can edit or replace them in the Knowledge Hub.
--
-- Idempotent: skills use ON CONFLICT DO NOTHING and the framework link only
-- fills an empty skill_id, so an administrator's own checklist is kept.

INSERT INTO mcp_skills (name, label, description, content, category, icon)
VALUES (
  'eu_ai_act_checklist',
  'EU AI Act Assessment Checklist',
  'Evidence checklist for the high-risk system requirements of Regulation (EU) 2024/1689: risk management, data governance, technical documentation, record-keeping, transparency, human oversight, accuracy and robustness.',
  $eu_ai_act$# EU AI Act — assessment checklist

You are reviewing an AI system against the requirements for high-risk AI
systems in Regulation (EU) 2024/1689, Articles 9 to 15. Work through the
requirements below in order. For every requirement, collect evidence with at
least one tool call before you decide on a verdict.

Whether the system is high-risk, and which role the operator holds
(provider, deployer, importer, distributor), is a legal decision made by the
operator before the assessment. Argus does not make that classification.
If a requirement does not apply to the target, use `not_applicable` and
state why in `evidence`.

Your final answer must be a JSON array only, with no surrounding prose and
no Markdown fences. The format is described at the end of this checklist.

---

## Art. 9 — Risk management system

**What to look for:** A documented, repeatable process that identifies,
estimates and mitigates foreseeable risks of the AI system across its life
cycle, including residual risk and misuse.

**Evidence to collect:**
1. `workspace_exec({cmd: "grep -rilE 'risk (register|assessment|management)|residual risk|misuse' /workspace/docs"})`
2. `workspace_ls({path: "/workspace/docs"})` and open the most relevant document with `workspace_read`.

**Verdict guidance:**
- `passed`: a maintained risk register or assessment with mitigations and an owner
- `warning`: risks are described, but there is no owner, review cadence or mitigation tracking
- `failed`: no risk management documentation found

**Severity:** `high`

---

## Art. 10 — Data and data governance

**What to look for:** Documented origin, scope and quality criteria of
training, validation and test data, plus checks for bias and gaps. For
systems that only call external models, the data used for retrieval,
prompting or fine-tuning.

**Evidence to collect:**
1. `workspace_exec({cmd: "grep -rilE 'dataset|training data|data card|datasheet|bias|data quality' /workspace --include=*.md --include=*.yaml --include=*.json"})`
2. If a knowledge index is attached, `rag_eu_ai_act_search({q: "data governance requirements for training data"})`

**Verdict guidance:**
- `passed`: data sources, selection criteria and quality or bias checks are documented
- `warning`: data sources are named, but quality or bias checks are missing
- `failed`: no information about the data used by the system

**Severity:** `high`

---

## Art. 11 — Technical documentation

**What to look for:** Technical documentation that describes the system's
purpose, architecture, components, versions, performance limits and how it
is operated, kept up to date with releases.

**Evidence to collect:**
1. `workspace_exec({cmd: "find /workspace/docs -maxdepth 2 -name '*.md'"})`
2. `workspace_exec({cmd: "grep -rilE 'architecture|intended purpose|limitations|model version' /workspace/docs"})`

**Verdict guidance:**
- `passed`: architecture, intended purpose, limitations and versioning are documented
- `warning`: documentation exists, but intended purpose or limitations are missing
- `failed`: no technical documentation found

**Severity:** `high`

---

## Art. 12 — Record-keeping

**What to look for:** Automatic, tamper-evident logging of events relevant
to identifying risks and to post-market monitoring, with a defined
retention period.

**Evidence to collect:**
1. `workspace_exec({cmd: "grep -rlnE 'audit(_| )?(log|event|trail)|hash.?chain|retention' /workspace/src"})`
2. `workspace_exec({cmd: "grep -rilE 'retention|log storage|audit export' /workspace/docs"})`

**Verdict guidance:**
- `passed`: structured audit logging with integrity protection and documented retention
- `warning`: logging exists, but without integrity protection or a retention rule
- `failed`: no traceable logging of system decisions or actions

**Severity:** `critical`

---

## Art. 13 — Transparency and information for deployers

**What to look for:** Instructions for use that explain capabilities,
limitations, expected accuracy, required human oversight and how to
interpret outputs.

**Evidence to collect:**
1. `workspace_exec({cmd: "grep -rilE 'instructions for use|user guide|limitations|known issues|accuracy' /workspace/docs /workspace/README.md"})`

**Verdict guidance:**
- `passed`: user-facing documentation covers capabilities, limitations and output interpretation
- `warning`: a user guide exists, but limitations or accuracy are not described
- `failed`: no information for deployers or users

**Severity:** `medium`

---

## Art. 14 — Human oversight

**What to look for:** Technical measures that let people monitor the
system, understand its outputs, intervene, override or stop it, for example
approval gates before consequential actions.

**Evidence to collect:**
1. `workspace_exec({cmd: "grep -rlnE 'approval|human.?in.?the.?loop|human oversight|override|kill.?switch' /workspace/src"})`
2. `workspace_exec({cmd: "grep -rilE 'approval|oversight|escalation' /workspace/docs"})`

**Verdict guidance:**
- `passed`: enforced approval or intervention points for high-impact actions, documented for operators
- `warning`: oversight is possible, but not enforced for high-impact actions
- `failed`: the system acts without any human intervention point

**Severity:** `critical`

---

## Art. 15 — Accuracy, robustness and cybersecurity

**What to look for:** Declared accuracy metrics, evaluation or regression
tests, resilience against errors and adversarial input (such as prompt
injection), and basic security controls.

**Evidence to collect:**
1. `workspace_exec({cmd: "grep -rlnE 'evaluation|benchmark|accuracy|prompt injection|guardrail' /workspace/src /workspace/docs"})`
2. `workspace_exec({cmd: "find /workspace -maxdepth 3 -name 'SECURITY.md' -o -maxdepth 3 -name '*.test.*' -path '*eval*'"})`

**Verdict guidance:**
- `passed`: measured accuracy, automated evaluations and documented protections against misuse
- `warning`: some tests or protections exist, but no declared metrics
- `failed`: no evidence of accuracy, robustness or security measures

**Severity:** `high`

---

## Output format

Return one JSON object per requirement:

```json
{
  "article": "Art. 12",
  "title": "Record-keeping",
  "verdict": "warning",
  "severity": "critical",
  "evidence": "Structured audit events are written in src/audit/, but no retention period is documented.",
  "code_pointers": [
    {"file": "src/audit/writer.ts", "line": 42, "snippet": "export async function writeAuditEvent("}
  ],
  "remediation": "Document the retention period and how audit records are protected against modification."
}
```

Allowed verdicts: `passed`, `warning`, `failed`, `not_applicable`.
Allowed severities: `low`, `medium`, `high`, `critical`.
Only cite files and lines you actually inspected.

**Finish with a JSON array containing these seven objects and nothing else.**
$eu_ai_act$,
  'compliance',
  '🛡️'
)
ON CONFLICT (name) DO NOTHING;

INSERT INTO mcp_skills (name, label, description, content, category, icon)
VALUES (
  'nis2_checklist',
  'NIS2 Assessment Checklist',
  'Evidence checklist for Directive (EU) 2022/2555: management accountability, risk policies, incident handling, continuity, supply chain, cyber hygiene, cryptography, access control and reporting.',
  $nis2$# NIS2 — assessment checklist

You are reviewing a service or repository against the cybersecurity risk
management and reporting obligations of Directive (EU) 2022/2555 (NIS2),
Articles 20, 21 and 23. Work through the measures below in order. For every
measure, collect evidence with at least one tool call before you decide on a
verdict.

NIS2 applies to specific essential and important entities, and national
transposition can add detail. Whether and how far the target is in scope is
decided by the operator based on its sector, size and role. Argus does not
make that legal determination. If a measure does not apply, use
`not_applicable` and state why in `evidence`.

Your final answer must be a JSON array only, with no surrounding prose and
no Markdown fences. The format is described at the end of this checklist.

---

## Art. 20 — Governance and management accountability

**What to look for:** Management approves and oversees cybersecurity risk
measures; responsibilities are assigned to named roles.

**Evidence to collect:**
1. `workspace_exec({cmd: "grep -rilE 'governance|security owner|risk owner|responsib' /workspace/docs"})`
2. `workspace_ls({path: "/workspace/docs"})`

**Verdict guidance:**
- `passed`: a documented governance model with named owners and approval responsibilities
- `warning`: governance is mentioned, but roles are not assigned
- `failed`: no governance documentation found

**Severity:** `high`

---

## Art. 21(2)(a) — Risk analysis and security policies

**What to look for:** Information security and risk analysis policies that
are reviewed on a defined schedule.

**Evidence to collect:**
1. `workspace_exec({cmd: "find /workspace -maxdepth 3 -iname 'SECURITY.md' -o -maxdepth 3 -iname '*threat*model*'"})`
2. `workspace_exec({cmd: "grep -rilE 'security policy|risk assessment|review cycle' /workspace/docs"})`
3. If a knowledge index is attached, `rag_nis2_search({q: "policies on risk analysis and information system security"})`

**Verdict guidance:**
- `passed`: security policy, threat model and a documented review schedule
- `warning`: a policy exists, but no threat model or review schedule
- `failed`: no security policy found

**Severity:** `high`

---

## Art. 21(2)(b) — Incident handling

**What to look for:** A defined process to detect, triage, respond to and
learn from incidents, with alerting and runbooks.

**Evidence to collect:**
1. `workspace_exec({cmd: "grep -rilE 'incident|runbook|on.?call|post.?mortem' /workspace/docs"})`
2. `workspace_exec({cmd: "grep -rlE 'alert|alertmanager|pagerduty|opsgenie' /workspace --include=*.yml --include=*.yaml"})`

**Verdict guidance:**
- `passed`: incident process, runbooks, alerting and a post-incident review template
- `warning`: alerting exists, but there is no documented response process
- `failed`: no incident handling evidence

**Severity:** `critical`

---

## Art. 21(2)(c) — Business continuity and backups

**What to look for:** Backups with tested restores, disaster recovery and
crisis management, with recovery objectives.

**Evidence to collect:**
1. `workspace_exec({cmd: "grep -rilE 'backup|restore|disaster recovery|RPO|RTO' /workspace/docs /workspace/scripts"})`

**Verdict guidance:**
- `passed`: automated backups, documented restore tests and recovery objectives
- `warning`: backups exist, but restores are not tested or objectives are missing
- `failed`: no backup or recovery evidence

**Severity:** `critical`

---

## Art. 21(2)(d) — Supply chain security

**What to look for:** Control over third-party components and suppliers:
pinned dependencies, vulnerability scanning, SBOMs, supplier review.

**Evidence to collect:**
1. `workspace_exec({cmd: "find /workspace -maxdepth 3 -name 'package-lock.json' -o -maxdepth 3 -name 'dependabot.yml' -o -maxdepth 3 -iname '*sbom*'"})`
2. `workspace_exec({cmd: "grep -rlE 'npm audit|trivy|grype|osv|dependency.?review' /workspace/.github /workspace/scripts"})`

**Verdict guidance:**
- `passed`: locked dependencies, automated vulnerability scanning and an SBOM or supplier inventory
- `warning`: dependencies are locked, but scanning or inventory is missing
- `failed`: no supply chain controls found

**Severity:** `high`

---

## Art. 21(2)(g) — Cyber hygiene and training

**What to look for:** Basic hygiene practices (patching, secure defaults,
secret handling) and security awareness or training material.

**Evidence to collect:**
1. `workspace_exec({cmd: "grep -rilE 'training|awareness|onboarding|secure coding|patch' /workspace/docs /workspace/CONTRIBUTING.md"})`

**Verdict guidance:**
- `passed`: documented hygiene practices and training or onboarding material
- `warning`: some guidance, but no training material
- `failed`: no hygiene or training evidence

**Severity:** `medium`

---

## Art. 21(2)(h) — Cryptography and encryption

**What to look for:** A policy for cryptography: TLS in transit,
encryption of sensitive data at rest, key management.

**Evidence to collect:**
1. `workspace_exec({cmd: "grep -rlnE 'aes-256-gcm|createCipheriv|tls|https|encryption key|kms' /workspace/src"})`
2. `workspace_exec({cmd: "grep -rilE 'encryption|key rotation|cryptograph' /workspace/docs"})`

**Verdict guidance:**
- `passed`: encryption in transit and at rest with documented key management
- `warning`: encryption is used, but key management is undocumented
- `failed`: sensitive data is stored or sent without encryption

**Severity:** `critical`

---

## Art. 21(2)(i) and (j) — Access control and multi-factor authentication

**What to look for:** Role-based access, least privilege, asset
management and MFA or continuous authentication for privileged access.

**Evidence to collect:**
1. `workspace_exec({cmd: "grep -rlnE 'rbac|role|permission|mfa|totp|webauthn|step.?up' /workspace/src"})`
2. `workspace_exec({cmd: "grep -rilE 'access control|least privilege|mfa' /workspace/docs"})`

**Verdict guidance:**
- `passed`: enforced RBAC, least privilege and MFA for privileged access
- `warning`: RBAC exists, but MFA is optional or missing for administrators
- `failed`: no access control model found

**Severity:** `critical`

---

## Art. 23 — Reporting obligations

**What to look for:** A process to notify the competent authority or CSIRT
of significant incidents within the required deadlines (early warning,
incident notification, final report).

**Evidence to collect:**
1. `workspace_exec({cmd: "grep -rilE 'csirt|notification|report(ing)? obligation|24 ?h|72 ?h|authority' /workspace/docs"})`

**Verdict guidance:**
- `passed`: documented reporting procedure with deadlines, contacts and templates
- `warning`: reporting is mentioned, but deadlines or contacts are missing
- `failed`: no reporting procedure found

**Severity:** `high`

---

## Output format

Return one JSON object per measure:

```json
{
  "article": "Art. 21(2)(b)",
  "title": "Incident handling",
  "verdict": "passed",
  "severity": "critical",
  "evidence": "Incident runbooks in docs/runbooks/, alert rules in deploy/alerts.yaml and a post-incident template were found.",
  "code_pointers": [
    {"file": "docs/runbooks/incident-response.md", "line": 1, "snippet": "# Incident response"}
  ],
  "remediation": "No action required."
}
```

Allowed verdicts: `passed`, `warning`, `failed`, `not_applicable`.
Allowed severities: `low`, `medium`, `high`, `critical`.
Only cite files and lines you actually inspected.

**Finish with a JSON array containing these nine objects and nothing else.**
$nis2$,
  'compliance',
  '🛡️'
)
ON CONFLICT (name) DO NOTHING;

INSERT INTO mcp_skills (name, label, description, content, category, icon)
VALUES (
  'iso27001_checklist',
  'ISO/IEC 27001 Assessment Checklist',
  'Evidence checklist for selected ISO/IEC 27001:2022 Annex A controls: policies, access control, ICT continuity, privileged access, authentication, configuration, monitoring, cryptography and secure coding.',
  $iso27001$# ISO/IEC 27001:2022 — assessment checklist

You are reviewing a service or repository against a selection of technical
and organisational controls from ISO/IEC 27001:2022 Annex A. Work through
the controls below in order. For every control, collect evidence with at
least one tool call before you decide on a verdict.

This is a technical evidence review, not a certification audit. Which
controls apply is set by the organisation's Statement of Applicability.
If a control is excluded or does not apply to the target, use
`not_applicable` and state why in `evidence`.

Your final answer must be a JSON array only, with no surrounding prose and
no Markdown fences. The format is described at the end of this checklist.

---

## A.5.1 — Policies for information security

**What to look for:** An approved information security policy and
topic-specific policies that are communicated and reviewed.

**Evidence to collect:**
1. `workspace_exec({cmd: "find /workspace -maxdepth 3 -iname 'SECURITY.md' -o -maxdepth 3 -iname '*policy*.md'"})`
2. `workspace_exec({cmd: "grep -rilE 'information security policy|policy review|approved by' /workspace/docs"})`

**Verdict guidance:**
- `passed`: a security policy with owner, approval and review date
- `warning`: a policy exists, but without owner or review date
- `failed`: no security policy found

**Severity:** `high`

---

## A.5.15 — Access control

**What to look for:** Rules for physical and logical access based on
business and security requirements, implemented as roles or permissions.

**Evidence to collect:**
1. `workspace_exec({cmd: "grep -rlnE 'rbac|requirePermission|authorize|role' /workspace/src"})`
2. `workspace_exec({cmd: "grep -rilE 'access control|permission model|roles' /workspace/docs"})`

**Verdict guidance:**
- `passed`: an enforced, documented permission model
- `warning`: permissions are enforced, but the model is undocumented
- `failed`: no consistent access control found

**Severity:** `critical`

---

## A.5.30 — ICT readiness for business continuity

**What to look for:** Continuity requirements for ICT services, with
recovery plans that are tested.

**Evidence to collect:**
1. `workspace_exec({cmd: "grep -rilE 'continuity|disaster recovery|failover|restore test|RTO|RPO' /workspace/docs /workspace/scripts"})`

**Verdict guidance:**
- `passed`: recovery plans with objectives and evidence of tests
- `warning`: recovery is described, but not tested
- `failed`: no continuity planning found

**Severity:** `high`

---

## A.8.2 — Privileged access rights

**What to look for:** Privileged rights are restricted, granted
explicitly, time-limited where possible and reviewed.

**Evidence to collect:**
1. `workspace_exec({cmd: "grep -rlnE 'admin|privileged|break.?glass|emergency access' /workspace/src"})`
2. `workspace_exec({cmd: "grep -rilE 'privileged access|admin role|access review' /workspace/docs"})`

**Verdict guidance:**
- `passed`: separate privileged roles with explicit grants and regular reviews
- `warning`: privileged roles exist, but are not reviewed or time-limited
- `failed`: privileged access is unrestricted or shared

**Severity:** `critical`

---

## A.8.5 — Secure authentication

**What to look for:** Authentication matched to risk: SSO, MFA for
sensitive operations, secure session handling.

**Evidence to collect:**
1. `workspace_exec({cmd: "grep -rlnE 'oidc|saml|mfa|totp|webauthn|session|httpOnly|sameSite' /workspace/src"})`

**Verdict guidance:**
- `passed`: SSO or strong authentication with MFA for sensitive operations and hardened sessions
- `warning`: authentication is in place, but MFA or session hardening is missing
- `failed`: weak or no authentication

**Severity:** `critical`

---

## A.8.9 — Configuration management

**What to look for:** Secure baseline configurations that are
version-controlled, reviewed and checked for drift. Secrets are kept out of
the repository.

**Evidence to collect:**
1. `workspace_exec({cmd: "find /workspace -maxdepth 2 -name '.env.example' -o -maxdepth 2 -name 'Dockerfile' -o -maxdepth 2 -name '*.tf'"})`
2. `workspace_exec({cmd: "grep -rlE 'gitleaks|secret.?scan|trufflehog' /workspace/.github /workspace/scripts"})`

**Verdict guidance:**
- `passed`: configuration as code, documented defaults and secret scanning
- `warning`: configuration is versioned, but without secret scanning or baselines
- `failed`: configuration is manual or secrets are committed

**Severity:** `high`

---

## A.8.16 — Monitoring activities

**What to look for:** Networks, systems and applications are monitored for
anomalous behaviour, with alerting and log review.

**Evidence to collect:**
1. `workspace_exec({cmd: "grep -rlnE 'prometheus|opentelemetry|metrics|tracing|alert' /workspace/src /workspace/deploy"})`
2. `workspace_exec({cmd: "grep -rilE 'monitoring|alerting|dashboard' /workspace/docs"})`

**Verdict guidance:**
- `passed`: metrics, logs and traces with alerting and documented response
- `warning`: telemetry exists, but without alerting
- `failed`: no monitoring found

**Severity:** `high`

---

## A.8.24 — Use of cryptography

**What to look for:** Rules for cryptography and key management; current
algorithms; no hard-coded keys.

**Evidence to collect:**
1. `workspace_exec({cmd: "grep -rlnE 'createCipheriv|aes-256-gcm|ed25519|sha256|kms|key rotation' /workspace/src"})`
2. `workspace_exec({cmd: "grep -rlnE 'md5|sha1|des-|rc4' /workspace/src"})`

**Verdict guidance:**
- `passed`: current algorithms, managed keys and documented rotation
- `warning`: current algorithms, but no documented key management
- `failed`: weak algorithms or hard-coded keys

**Severity:** `critical`

---

## A.8.28 — Secure coding

**What to look for:** Secure development practices: code review, static
analysis, dependency scanning, input validation, tests in CI.

**Evidence to collect:**
1. `workspace_exec({cmd: "find /workspace/.github -name '*.yml'"})`
2. `workspace_exec({cmd: "grep -rlE 'codeql|semgrep|eslint|npm audit|zod|validate' /workspace/.github /workspace/src"})`

**Verdict guidance:**
- `passed`: CI with tests, static analysis and dependency scanning; input validation in code
- `warning`: CI tests exist, but no static or dependency analysis
- `failed`: no secure development controls found

**Severity:** `high`

---

## Output format

Return one JSON object per control:

```json
{
  "article": "A.8.5",
  "title": "Secure authentication",
  "verdict": "passed",
  "severity": "critical",
  "evidence": "OIDC login with PKCE and step-up MFA is implemented in src/auth/; session cookies are httpOnly and sameSite.",
  "code_pointers": [
    {"file": "src/auth/oidcAuth.ts", "line": 120, "snippet": "code_challenge_method: 'S256'"}
  ],
  "remediation": "No action required."
}
```

Allowed verdicts: `passed`, `warning`, `failed`, `not_applicable`.
Allowed severities: `low`, `medium`, `high`, `critical`.
Only cite files and lines you actually inspected.

**Finish with a JSON array containing these nine objects and nothing else.**
$iso27001$,
  'compliance',
  '🛡️'
)
ON CONFLICT (name) DO NOTHING;

INSERT INTO mcp_skills (name, label, description, content, category, icon)
VALUES (
  'dora_checklist',
  'DORA Assessment Checklist',
  'Evidence checklist for Regulation (EU) 2022/2554 (DORA): ICT governance, risk management framework, asset inventory, protection, detection, response and recovery, backups, incident management and third-party risk.',
  $dora$# DORA — assessment checklist

You are reviewing an ICT service or repository against the ICT risk
management, incident management and third-party risk requirements of
Regulation (EU) 2022/2554 (Digital Operational Resilience Act). Work
through the requirements below in order. For every requirement, collect
evidence with at least one tool call before you decide on a verdict.

DORA applies to the financial entities named in the regulation and affects
ICT third-party service providers through their contracts. The operator
decides its role and the applicability before the assessment; Argus does
not make a scope determination. The regulation applies from 17 January
2025. If a requirement does not apply, use `not_applicable` and state why
in `evidence`.

Your final answer must be a JSON array only, with no surrounding prose and
no Markdown fences. The format is described at the end of this checklist.

---

## Art. 5 — ICT governance

**What to look for:** The management body defines, approves and oversees
the ICT risk management framework; roles are assigned.

**Evidence to collect:**
1. `workspace_exec({cmd: "grep -rilE 'governance|ict risk|management body|owner' /workspace/docs"})`

**Verdict guidance:**
- `passed`: documented governance with approval and assigned ICT risk roles
- `warning`: governance is mentioned, but approval or roles are missing
- `failed`: no ICT governance documentation

**Severity:** `high`

---

## Art. 6 — ICT risk management framework

**What to look for:** A documented framework of strategies, policies,
procedures and tools to protect ICT assets, reviewed at least yearly and
after major incidents.

**Evidence to collect:**
1. `workspace_exec({cmd: "grep -rilE 'risk management framework|threat model|risk register|annual review' /workspace/docs"})`
2. If a knowledge index is attached, `rag_dora_search({q: "ICT risk management framework review"})`

**Verdict guidance:**
- `passed`: a framework with policies, a risk register and a review schedule
- `warning`: partial documentation without a review schedule
- `failed`: no ICT risk management framework

**Severity:** `critical`

---

## Art. 8 — Identification and classification of assets

**What to look for:** An inventory of ICT assets, information assets and
their dependencies, classified by criticality.

**Evidence to collect:**
1. `workspace_exec({cmd: "grep -rilE 'inventory|asset|dependency map|criticality|service catalog' /workspace/docs"})`
2. `workspace_exec({cmd: "find /workspace -maxdepth 2 -name 'compose*.yml' -o -maxdepth 2 -name 'docker-compose*.yml' -o -maxdepth 2 -name 'Chart.yaml'"})`

**Verdict guidance:**
- `passed`: a maintained asset inventory with dependencies and criticality
- `warning`: components are visible in deployment files, but there is no classified inventory
- `failed`: no asset inventory

**Severity:** `high`

---

## Art. 9 — Protection and prevention

**What to look for:** Security policies and controls for access,
authentication, encryption, network segmentation and change management.

**Evidence to collect:**
1. `workspace_exec({cmd: "grep -rlnE 'rbac|mfa|encrypt|tls|network policy|rate.?limit' /workspace/src /workspace/deploy"})`

**Verdict guidance:**
- `passed`: access control, MFA, encryption and segmentation are implemented and documented
- `warning`: core controls exist, but there are gaps (for example no segmentation or no MFA)
- `failed`: key protection controls are missing

**Severity:** `critical`

---

## Art. 10 — Detection

**What to look for:** Mechanisms that promptly detect anomalous
activities, with defined alert thresholds.

**Evidence to collect:**
1. `workspace_exec({cmd: "grep -rlnE 'alert|anomal|threshold|prometheus|siem' /workspace/src /workspace/deploy"})`

**Verdict guidance:**
- `passed`: monitoring with alert thresholds and an assigned response
- `warning`: monitoring exists, but without thresholds or alerting
- `failed`: no detection capability

**Severity:** `high`

---

## Art. 11 — Response and recovery

**What to look for:** An ICT business continuity policy and response and
recovery plans that are tested.

**Evidence to collect:**
1. `workspace_exec({cmd: "grep -rilE 'continuity|recovery plan|runbook|failover|drill' /workspace/docs"})`

**Verdict guidance:**
- `passed`: response and recovery plans with documented tests
- `warning`: plans exist, but are not tested
- `failed`: no response or recovery planning

**Severity:** `critical`

---

## Art. 12 — Backup policies and restoration

**What to look for:** Backup scope and frequency, segregated storage,
restoration procedures and regular restore tests.

**Evidence to collect:**
1. `workspace_exec({cmd: "grep -rilE 'backup|restore|pg_dump|snapshot|immutable' /workspace/docs /workspace/scripts"})`

**Verdict guidance:**
- `passed`: automated, segregated backups with tested restores
- `warning`: backups exist, but restores are not tested or storage is not segregated
- `failed`: no backup policy

**Severity:** `critical`

---

## Art. 17 — ICT-related incident management process

**What to look for:** A process to detect, record, classify, escalate and
resolve ICT incidents, including root cause analysis.

**Evidence to collect:**
1. `workspace_exec({cmd: "grep -rilE 'incident|classification|severity|escalation|root cause' /workspace/docs"})`

**Verdict guidance:**
- `passed`: a documented process with classification, escalation and root cause analysis
- `warning`: incidents are handled, but classification or escalation is undefined
- `failed`: no incident management process

**Severity:** `high`

---

## Art. 28 — ICT third-party risk

**What to look for:** A register of ICT third-party providers, risk
assessment before onboarding, exit strategies and contractual controls.

**Evidence to collect:**
1. `workspace_exec({cmd: "grep -rilE 'third.?party|vendor|supplier|subprocessor|exit strategy' /workspace/docs"})`
2. `workspace_exec({cmd: "find /workspace -maxdepth 2 -name 'NOTICE' -o -maxdepth 2 -iname '*sbom*'"})`

**Verdict guidance:**
- `passed`: a provider register with risk assessments and exit plans
- `warning`: providers are listed, but without risk assessment or exit plans
- `failed`: no third-party risk management

**Severity:** `high`

---

## Output format

Return one JSON object per requirement:

```json
{
  "article": "Art. 12",
  "title": "Backup policies and restoration",
  "verdict": "warning",
  "severity": "critical",
  "evidence": "Nightly database dumps are scripted in scripts/backup.sh, but no restore test is documented.",
  "code_pointers": [
    {"file": "scripts/backup.sh", "line": 8, "snippet": "pg_dump --format=custom"}
  ],
  "remediation": "Schedule regular restore tests and record their results."
}
```

Allowed verdicts: `passed`, `warning`, `failed`, `not_applicable`.
Allowed severities: `low`, `medium`, `high`, `critical`.
Only cite files and lines you actually inspected.

**Finish with a JSON array containing these nine objects and nothing else.**
$dora$,
  'compliance',
  '🛡️'
)
ON CONFLICT (name) DO NOTHING;

INSERT INTO mcp_skills (name, label, description, content, category, icon)
VALUES (
  'soc2_checklist',
  'SOC 2 Assessment Checklist',
  'Evidence checklist for the SOC 2 Common Criteria (2017 Trust Services Criteria): control environment, communication, risk assessment, monitoring, control activities, access, operations, change management and risk mitigation.',
  $soc2$# SOC 2 — assessment checklist

You are reviewing a service or repository against the Common Criteria
(CC1 to CC9) of the AICPA 2017 Trust Services Criteria used in SOC 2
reports. Work through the criteria below in order. For every criterion,
collect evidence with at least one tool call before you decide on a
verdict.

This is a technical readiness review. A SOC 2 report can only be issued by
an independent auditor, and a Type II report also covers how controls
operated over a period of time. If a criterion does not apply to the
target, use `not_applicable` and state why in `evidence`.

Your final answer must be a JSON array only, with no surrounding prose and
no Markdown fences. The format is described at the end of this checklist.

---

## CC1 — Control environment

**What to look for:** Commitment to integrity and ethics, defined
oversight and responsibilities, for example a code of conduct and named
owners.

**Evidence to collect:**
1. `workspace_exec({cmd: "find /workspace -maxdepth 2 -iname 'CODE_OF_CONDUCT.md' -o -maxdepth 2 -iname 'CODEOWNERS' -o -maxdepth 3 -iname 'GOVERNANCE.md'"})`

**Verdict guidance:**
- `passed`: code of conduct, governance and ownership are documented
- `warning`: some of these are documented
- `failed`: none of these are documented

**Severity:** `medium`

---

## CC2 — Communication and information

**What to look for:** Relevant security information is communicated
internally and externally, for example a security contact and
documentation for users.

**Evidence to collect:**
1. `workspace_exec({cmd: "grep -rilE 'security contact|report a vulnerability|disclosure|changelog' /workspace/SECURITY.md /workspace/docs /workspace/README.md"})`

**Verdict guidance:**
- `passed`: a published security contact, disclosure process and user documentation
- `warning`: documentation exists, but there is no security contact or disclosure process
- `failed`: no security communication

**Severity:** `medium`

---

## CC3 — Risk assessment

**What to look for:** Risks to objectives are identified and analysed,
including fraud risk and the effect of changes.

**Evidence to collect:**
1. `workspace_exec({cmd: "grep -rilE 'risk assessment|threat model|risk register' /workspace/docs"})`

**Verdict guidance:**
- `passed`: a maintained risk assessment or threat model
- `warning`: risks are mentioned, but not analysed systematically
- `failed`: no risk assessment

**Severity:** `high`

---

## CC4 — Monitoring activities

**What to look for:** Ongoing evaluation that controls work, and
deficiencies are tracked to resolution.

**Evidence to collect:**
1. `workspace_exec({cmd: "grep -rlnE 'health|metrics|alert|audit' /workspace/src /workspace/deploy"})`
2. `workspace_exec({cmd: "find /workspace/.github -name '*.yml'"})`

**Verdict guidance:**
- `passed`: automated control checks (CI, monitoring) with tracked follow-up
- `warning`: monitoring exists, but follow-up is not tracked
- `failed`: no monitoring of controls

**Severity:** `high`

---

## CC5 — Control activities

**What to look for:** Controls and policies that reduce risks to an
acceptable level, for example required reviews and automated checks
before release.

**Evidence to collect:**
1. `workspace_exec({cmd: "grep -rlE 'required|needs:|approval|review' /workspace/.github"})`
2. `workspace_exec({cmd: "grep -rilE 'release process|approval|four.?eyes|review' /workspace/docs /workspace/CONTRIBUTING.md"})`

**Verdict guidance:**
- `passed`: enforced review and automated gates before changes reach production
- `warning`: gates exist, but they are not enforced
- `failed`: no control activities

**Severity:** `critical`

---

## CC6 — Logical and physical access controls

**What to look for:** Authentication, authorisation, least privilege,
protection of credentials and encryption of data.

**Evidence to collect:**
1. `workspace_exec({cmd: "grep -rlnE 'rbac|permission|mfa|oidc|encrypt|secret' /workspace/src"})`

**Verdict guidance:**
- `passed`: SSO or MFA, enforced RBAC, encrypted secrets and data
- `warning`: access control exists, but MFA or encryption is missing
- `failed`: weak or missing access controls

**Severity:** `critical`

---

## CC7 — System operations

**What to look for:** Detection of vulnerabilities and anomalies, plus
incident response and recovery.

**Evidence to collect:**
1. `workspace_exec({cmd: "grep -rlE 'npm audit|codeql|trivy|dependabot' /workspace/.github"})`
2. `workspace_exec({cmd: "grep -rilE 'incident|runbook|recovery' /workspace/docs"})`

**Verdict guidance:**
- `passed`: vulnerability scanning, anomaly detection and a documented incident process
- `warning`: some of these exist
- `failed`: none of these exist

**Severity:** `high`

---

## CC8 — Change management

**What to look for:** Changes are authorised, tested, approved and
documented before they are deployed.

**Evidence to collect:**
1. `workspace_exec({cmd: "find /workspace -maxdepth 2 -name 'CHANGELOG.md' -o -maxdepth 3 -name 'pull_request_template.md'"})`
2. `workspace_exec({cmd: "grep -rlE 'pull_request|test|build' /workspace/.github"})`

**Verdict guidance:**
- `passed`: pull request workflow with tests, review and a changelog
- `warning`: tests run, but there is no enforced review or record of changes
- `failed`: changes are deployed without control

**Severity:** `high`

---

## CC9 — Risk mitigation

**What to look for:** Mitigation of business disruption and
vendor risk, for example backups, continuity plans and supplier review.

**Evidence to collect:**
1. `workspace_exec({cmd: "grep -rilE 'backup|continuity|vendor|supplier|third.?party' /workspace/docs"})`

**Verdict guidance:**
- `passed`: continuity measures and supplier risk review are documented
- `warning`: one of the two is documented
- `failed`: neither is documented

**Severity:** `high`

---

## Output format

Return one JSON object per criterion:

```json
{
  "article": "CC8",
  "title": "Change management",
  "verdict": "passed",
  "severity": "high",
  "evidence": "Pull requests run build and test jobs in .github/workflows/ci.yml; releases are recorded in CHANGELOG.md.",
  "code_pointers": [
    {"file": ".github/workflows/ci.yml", "line": 1, "snippet": "name: CI"}
  ],
  "remediation": "No action required."
}
```

Allowed verdicts: `passed`, `warning`, `failed`, `not_applicable`.
Allowed severities: `low`, `medium`, `high`, `critical`.
Only cite files and lines you actually inspected.

**Finish with a JSON array containing these nine objects and nothing else.**
$soc2$,
  'compliance',
  '🛡️'
)
ON CONFLICT (name) DO NOTHING;

UPDATE mcp_compliance_frameworks AS f
   SET skill_id = s.id
  FROM mcp_skills AS s
 WHERE f.skill_id IS NULL
   AND (f.slug, s.name) IN (
     ('eu_ai_act', 'eu_ai_act_checklist'),
     ('nis2', 'nis2_checklist'),
     ('iso27001', 'iso27001_checklist'),
     ('dora', 'dora_checklist'),
     ('soc2', 'soc2_checklist')
   );
