# Argus — EU-AI-Act Technical Documentation Workspace

> Status: Living documentation template; no conformity statement  
> Scope: Argus Core and first-party Spaces  
> Important: This document supports a future regulatory assessment. It does not establish that Argus or a customer deployment is compliant, high-risk, or exempt. Classification depends on the intended purpose, distribution model, configured modules and actual use.

## 1. Product description

Argus is a self-hosted control and execution platform for AI agents, MCP capabilities, knowledge sources and governed workflows. It can connect model providers and agent runtimes with internal tools while enforcing identity, authorisation, policies, human approvals, credential boundaries, audit and observability.

The platform consists of:

- **Argus Core:** identity, policy, credentials, MCP Fabric, RAG, approval, audit and observability;
- **Agent runtimes:** native Argus agents, LangGraph and future external runtime adapters;
- **Spaces:** role- and domain-specific product surfaces such as Dev or IT Ops;
- **Modules:** future installable packages declaring capabilities, data, policies and UI extensions.

Argus does not train or provide its own general-purpose AI model. Configured deployments call customer-selected third-party or self-hosted models directly.

## 2. Intended purpose

### Core intended purpose

Argus is intended to help organisations configure, run and supervise AI-assisted tasks while controlling access to models, data and tools.

The Core is not intended by itself to:

- make legally binding decisions about natural persons;
- rank or select applicants, employees, students, credit applicants or benefit recipients;
- perform biometric categorisation, emotion recognition or social scoring;
- autonomously operate safety-critical infrastructure without an independently validated control layer;
- replace qualified human judgement where law, contract or safety practice requires it.

Every Space and first-party module must define a narrower intended purpose and prohibited uses before release.

### Initial first-party Spaces

| Space | Intended purpose | Initial operating boundary |
|---|---|---|
| Dev | Build, test and operate agents and governed software-development workflows. | Human review before privileged repository, deployment or merge actions. |
| IT Ops | Investigate infrastructure incidents and prepare or perform governed remediation. | Read-only investigation first; writes require explicit policy and approval. |

HR, marketing, critical-infrastructure and other domain Spaces are not covered by a generic Core assessment. They require a separate use-case assessment.

## 3. Regulatory roles

The applicable role must be recorded for each distribution and deployment:

| Scenario | Likely role to assess | Required follow-up |
|---|---|---|
| Community downloads and configures Argus | Argus publisher and downstream deployer responsibilities vary by intended purpose and licence/distribution facts. | Legal review before public release; do not assume an open-source exemption. |
| Argus company sells a supported self-hosted distribution | Provider/manufacturer obligations may apply. | Product-level legal classification, contracts and technical file. |
| Customer operates Argus on its infrastructure | Customer will commonly be a deployer and data controller for its configured uses. | Clear instructions, logging, limitations and role allocation. |
| Argus offers managed hosting or support with data access | Argus may additionally be a processor and service provider. | DPA, subprocessor register, residency and incident obligations. |
| Customer substantially changes intended purpose or high-risk logic | Responsibilities can shift depending on the modification. | Contractual change-control and reclassification process. |

This table is a product-planning aid, not a final legal classification.

## 4. Risk classification

### 4.1 Technical action risk

Argus uses fields such as `risk_level` and `human_oversight_required` to control dangerous tool or workflow actions. These values express **operational security risk**, not the legal classification under the EU AI Act.

Examples of technically high or critical actions include:

- deleting or mutating infrastructure;
- writing to production databases;
- pushing code or triggering a deployment;
- sending externally visible messages;
- disclosing sensitive information;
- invoking tools with broad credentials.

### 4.2 AI-Act classification

AI-Act high-risk classification is use-case and intended-purpose based. A destructive Kubernetes action is not automatically a high-risk AI system under the Act. Conversely, an HR ranking feature may be high-risk even when it has no infrastructure write permission.

Each released Space/module must record:

1. intended purpose and reasonably foreseeable misuse;
2. whether it falls into a listed regulated area or product-safety context;
3. whether it materially influences a decision about a natural person;
4. provider, deployer, importer, distributor and processor roles where applicable;
5. required human oversight and operator competence;
6. the legal assessment owner and review date.

Current product defaults must never label a system „AI-Act high-risk“ solely from the internal `risk_level` column.

## 5. AI-system and model inventory

Model names must be read from the configured model/provider registry, not hardcoded into this document.

For every production model configuration, the deployment owner records:

| Field | Required evidence |
|---|---|
| Provider and model | Exact provider, model/version and endpoint type |
| Purpose | Agents, Spaces and tasks allowed to use the model |
| Residency | Processing location and configured regional endpoint |
| Credential owner | Organisation/team/agent profile and rotation owner |
| Data use | Provider terms for retention, training and abuse monitoring |
| Subprocessor/transfer basis | DPA, subprocessor information and transfer mechanism where applicable |
| Capabilities | Tool calling, structured output, vision and context limits |
| Evaluation | Pinned test dataset, quality/cost/latency baseline and last review |
| Exit | Fallback or migration path to another model/provider |

Argus currently provides model catalog, credential profiles, usage/cost records and direct provider access. Full continuous provider certification and promotion gates remain release work.

## 6. Data and knowledge sources

Argus can process:

- user prompts and agent responses;
- tool arguments and bounded/redacted results;
- RAG documents and embeddings;
- agent memory and session history;
- identities, roles and approval decisions;
- usage, cost, trace and audit metadata;
- optional repository, ticket, infrastructure and observability data.

For each Space and Knowledge Source, the deployment owner must record:

- purpose and legal basis determined by the controller;
- data-subject and data-category inventory;
- source owner and access-control mapping;
- model/embedding destination and residency;
- retention and deletion schedule;
- export and data-subject request process where applicable;
- DPIA requirement and result where applicable;
- prohibited document classes and secrets.

Privacy defaults should minimise stored content, use redacted previews for observability and prevent indefinite retention without a documented purpose.

## 7. Control mapping

This mapping describes available or planned evidence. It is not a conformity assessment.

| Requirement area | Argus evidence/control | Current status | Remaining release work |
|---|---|---|---|
| Risk management | technical risk engine, approval policies, threat model, agent limits | Partial | per-Space lifecycle risk file, owners and periodic review evidence |
| Data governance | RAG ownership concepts, PII redaction, credential isolation | Partial | full data inventory, ACL-aware ingestion, deletion/export tests and DPIA support |
| Technical documentation | architecture, product inventory, threat model and this workspace | Partial | versioned release technical file and validated statements |
| Record keeping | native traces, immutable audit events, approval history | Available, not release-certified | retention configuration, integrity/export drills and access review |
| Transparency | agent/chat UI and trace visibility | Partial | explicit AI-interaction notice and generated-content metadata where applicable |
| Human oversight | agent/workflow approval gates, risk-scored runtime approvals, stop/deactivate paths | Available, not release-certified | role competence, timeout/escalation, negative E2E and bypass testing |
| Accuracy/robustness | retries, limits, health, observability and evaluations | Partial | versioned datasets, candidate gates, chaos/soak and provider canaries |
| Cybersecurity | RBAC, scoped keys, encryption, redaction, rate limits and threat model | Partial | release SBOM/signing, vulnerability lifecycle and external security review |
| Post-market monitoring | incidents, alerts, feedback and regression concepts | Partial | formal product monitoring plan and regulatory escalation matrix |

## 8. Human oversight

Human oversight is implemented as an enforceable control, not merely a UI prompt.

Available mechanisms include:

- per-agent oversight configuration;
- deterministic risk assessment for tool actions;
- persisted approval requests and decisions;
- expiring/single-use approval semantics;
- actor identity and decision comment;
- workflow interruption and resume;
- agent/API-key disable paths;
- immutable audit and trace correlation.

Required E2E evidence before a production claim:

1. an unauthorised user cannot approve;
2. an approval for one action cannot authorise altered arguments;
3. an expired or consumed approval cannot be replayed;
4. a runtime restart cannot skip the approval;
5. a module/runtime cannot execute the tool outside MCP Fabric;
6. cancellation and emergency stop terminate further tool execution;
7. approval UI presents sufficient context for an informed decision.

## 9. Transparency

Article 50 transparency rules apply from 2 August 2026 for covered systems. Argus must therefore provide configurable product-level support for:

- a clear notice at the beginning of an interactive AI session unless the AI nature is already obvious;
- provider/model and agent identity in appropriate operator views;
- disclosure metadata for externally published AI-generated content where required;
- accessible and distinguishable notices;
- audit evidence that the configured notice/policy was active.

The customer remains responsible for the final use and publication context. Argus must provide clear defaults and documentation rather than silently delegating this requirement.

Official source: [European Commission — AI transparency rules](https://digital-strategy.ec.europa.eu/en/factpages/quick-facts-transparency-rules-ai-systems)

## 10. Logging, retention and evidence

Relevant evidence can include:

- initiator identity and runtime/agent identity;
- applied role, policy, bundle and capability;
- model/provider and configuration version;
- redacted input/output references;
- tool name, argument hash, risk factors and decision;
- approver identity, reason and timestamp;
- execution result, error and cancellation state;
- trace/span correlation;
- cost and token usage;
- feedback and evaluation scores.

Retention must be configurable by evidence category and customer purpose. „Keep forever“ is not an acceptable universal default for data containing or linkable to personal information.

## 11. Known limitations

- no complete automated P0 E2E certification across installation, OIDC, Agent, RAG, MCP, approval and observability;
- OIDC state and multi-replica behaviour still require release hardening;
- model/provider canaries are not continuously certified for every supported provider;
- RAG ingestion, source ownership, deletion and embedding schema require further hardening;
- evaluation datasets and promotion gates are planned;
- external runtime and module contracts are planned, not currently stable public APIs;
- root licence and third-party notice strategy are not yet final;
- this regulatory documentation has not been reviewed by external counsel or a conformity-assessment expert;
- the external product name still requires trademark and collision review.

## 12. Release dossier checklist

For every supported release:

- [ ] exact source revision, image digest and SBOM;
- [ ] supported deployment modes and support period;
- [ ] system/Space/module versions;
- [ ] intended purpose and prohibited uses;
- [ ] provider/model inventory template;
- [ ] data-flow and residency diagram;
- [ ] risk assessment and threat-model review;
- [ ] P0 E2E and negative security results;
- [ ] evaluation baselines and known limitations;
- [ ] human-oversight and stop-procedure evidence;
- [ ] retention, export, deletion and restore evidence;
- [ ] vulnerability and incident contacts;
- [ ] licences and third-party notices;
- [ ] legal classification owner and review date.

## 13. Official working sources

- [EU AI Act legal text](https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=celex%3A32024R1689)
- [European Commission — Navigating the AI Act](https://digital-strategy.ec.europa.eu/en/faqs/navigating-ai-act)
- [High-risk classification guidance](https://digital-strategy.ec.europa.eu/en/policies/guidelines-ai-high-risk-systems)
- [Article 50 transparency guidance](https://digital-strategy.ec.europa.eu/en/library/guidelines-transparency-obligations-providers-and-deployers-ai-systems)
- [GDPR privacy by design/default](https://commission.europa.eu/law/law-topic/data-protection/information-business-and-organisations/obligations/what-does-data-protection-design-and-default-mean_en)

