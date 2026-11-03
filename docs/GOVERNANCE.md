# Governance — Argus

> Status: Maintainer governance for the pre-company/open-source phase  
> This document defines ownership and decision paths. It supports future NIS2, DORA, ISO 27001, SOC 2 and AI-Act mappings but does not by itself satisfy or certify any framework.

## 1. Current operating model

Argus is currently maintained as an independent project. Until a company and a wider maintainer team exist, one person may hold multiple roles. This concentration must be visible; it must not be presented as segregation of duties.

Before a commercial or public production release, named role holders, legal entity, security contact, privacy contact and escalation channels must be recorded in the release dossier.

## 2. Roles

### Platform Owner

**Current holder:** Project maintainer

Responsibilities:

- product direction, roadmap and scope;
- architecture and release decisions;
- ownership of product risk register;
- incident coordination until explicitly delegated;
- approval of changes to platform trust boundaries;
- ensuring that documented controls match the actual product.

### Security Owner

**Current holder:** Project maintainer during the pre-company phase

Responsibilities:

- `SECURITY.md`, threat model and secure-development requirements;
- vulnerability intake, triage, remediation and disclosure;
- review of authentication, authorisation, credentials, audit and encryption changes;
- release SBOM, dependency/security scans and signing evidence;
- CRA-readiness and security-incident escalation process.

Long-term target: separate this role from day-to-day product ownership where staffing permits.

### Privacy and Regulatory Owner

**Current holder:** Project maintainer during the pre-company phase

Responsibilities:

- legal register and external-counsel coordination;
- intended-purpose and Space/module classification records;
- privacy-by-design reviews and data inventory;
- DPA/subprocessor, residency, retention and deletion documentation;
- maintenance of `docs/eu-ai-act-technical-documentation.md`;
- preventing unverified compliance claims.

This role is a coordination role and does not replace a qualified data-protection officer, legal counsel, auditor or conformity-assessment body where one is required.

### Release Owner

**Current holder:** Project maintainer

Responsibilities:

- release checklist and version evidence;
- migration, upgrade, backup and restore validation;
- P0 E2E result collection;
- supported-version and support-period declaration;
- image digest, SBOM and third-party notice publication.

### Module Publisher

**Current holder:** Not yet applicable

Future responsibilities:

- module identity, source, signature and licence;
- capability, data and network declaration;
- Space-specific intended purpose and restrictions;
- security updates and compatibility lifecycle;
- no bypass of Core identity, policy, credentials, approval or audit.

## 3. Decision authorities

| Decision | Required authority before public release |
|---|---|
| Product roadmap | Platform Owner |
| Routine bug fix | Maintainer/reviewer according to CODEOWNERS |
| Trust-boundary or auth change | Platform Owner + Security Owner review record |
| New model, data or external integration | Platform Owner + Security + Privacy/Regulatory review |
| New first-party Space/module | Platform Owner + Security + Privacy/Regulatory review |
| Regulatory or compliance claim | Privacy/Regulatory Owner + qualified external review |
| Risk-classification change | Technical risk: Platform/Security; legal classification: Regulatory + external review |
| Credential or encryption policy | Security Owner |
| Production release | Release Owner after all applicable release gates pass |
| Security exception | Security Owner, documented scope, reason, owner and expiry |

In the one-maintainer phase, the same person may sign multiple columns, but each decision record must show the separate questions that were reviewed.

## 4. Required records

The repository is the source of truth until a separate governed system is introduced.

| Record | Minimum content | Location/status |
|---|---|---|
| Architecture decisions | context, options, decision, consequences | ADR structure planned |
| Risk register | risk, impact, owner, treatment, due date, evidence | repository artifact planned |
| Security advisories | affected versions, severity, fix, disclosure timeline | private advisory + published notice |
| Release dossier | digest, SBOM, tests, migrations, known limitations | per-release artifact planned |
| Regulatory product card | intended purpose, roles, data, classification, oversight | per Space/module planned |
| Incident record | timeline, impact, notifications, remediation | `docs/runbooks/` template |
| Third-party inventory | package/source, version/SHA, licence, modifications | `THIRD_PARTY_NOTICES.md` planned |

No document may refer to a fictional internal Jira, Confluence, executive, insurer or corporate review as if that process had occurred.

## 5. Change governance

Security- or governance-relevant changes should be traceable through:

1. an issue or written change intent;
2. source change and review record;
3. automated test and security evidence;
4. migration and rollback notes where applicable;
5. release notes;
6. runtime audit for privileged production changes.

Changes to these areas require explicit review:

- `src/auth/`, credentials, encryption and sessions;
- MCP bundle and policy enforcement;
- approval, audit and trace integrity;
- model/provider data flows;
- RAG ingestion, ACLs, retention and deletion;
- runtime/module boundaries;
- externally visible compliance or security claims.

## 6. Review cadence

| Review | Cadence | Triggered additionally by |
|---|---|---|
| Threat model | quarterly during active development | trust-boundary change or severe incident |
| Product risk register | monthly before launch, quarterly afterward | new Space/module or material provider change |
| Privacy/data inventory | per release | new data source, provider, residency or purpose |
| Vulnerability posture | each release and continuous dependency monitoring | critical advisory |
| Business continuity | at least annually; drills according to release tier | architecture/SLA change or disaster |
| Regulatory register | quarterly | new law/guidance, market or intended purpose |

Review dates represent actual completed reviews only. Planned exercises must be labelled as planned, not passed.

## 7. Incident and regulatory escalation

Argus maintains separate decision paths for:

- product security vulnerability;
- customer operational incident;
- personal-data breach;
- potentially reportable CRA vulnerability or severe incident;
- customer-specific NIS2/DORA notification support;
- AI-system serious incident where applicable.

Notification duties and deadlines are determined from the applicable role and facts. No single generic „24-hour compliance notification“ is used for every framework.

## 8. Company-formation gate

Before the project is operated as a startup:

- [ ] legal entity and responsible contacts established;
- [ ] employment/IP provenance and contributor rights reviewed;
- [ ] product name and trademarks cleared;
- [ ] root licence and commercial boundary chosen;
- [ ] DCO/CLA strategy chosen;
- [ ] security and privacy intake addresses active;
- [ ] DPA, subprocessor and support terms drafted where needed;
- [ ] CRA manufacturer/open-source-steward role assessed;
- [ ] cyber-insurance decision documented without claiming nonexistent coverage;
- [ ] independent security and legal reviews scheduled for the first supported release.

## 9. Sign-off

Updates require Platform Owner approval. Changes affecting security or regulatory statements additionally require the corresponding owner review. Once the company has more than one qualified role holder, critical release and exception decisions should use genuine separation of duties.

