-- Migration 098: Seed local coding-workflow agents (coder, planner, reviewer, knowledge) + their custom skills
-- Auto-generated from local DB. Idempotent via ON CONFLICT (name) DO UPDATE -> Git is source of truth.
-- NOTE: llm_api_key is intentionally NOT seeded (encrypted secret, per-instance). Set it in the Admin UI per agent.
-- composite_id / bundle_ids / created_by / entra_* omitted (instance-specific FKs / identity).

-- =============================== SKILLS ===============================
INSERT INTO mcp_skills (name,label,description,content,category,icon) VALUES ('argus-coding-standards', 'Argus Coding Standards', 'TypeScript/Node.js Coding Conventions bei Argus', '## Argus Coding Standards

### TypeScript / Node.js
- Strict TypeScript (`strict: true`), keine `any` Types
- ESM Modules (`import/export`), keine CommonJS
- Async/await statt Callbacks oder raw Promises
- Error Handling: Typed errors, kein `catch(e: any)`
- Naming: camelCase für Variablen/Funktionen, PascalCase für Types/Interfaces
- Keine Default Exports, nur Named Exports
- Tests: Jest oder Vitest, min. 80% Coverage für neue Files

### Code Quality
- Kein toter Code, keine auskommentierten Blöcke
- Max 300 Zeilen pro Datei, max 50 Zeilen pro Funktion, außer die Datei war vorher genauso oder noch größer
- Dependency Injection statt Singletons
- Config via Environment Variables (nie hardcoded Secrets)
- Logging via strukturiertem Logger (pino), kein console.log

### Git Conventions
- Commit Messages: Conventional Commits (`feat:`, `fix:`, `chore:`)
- Ein Commit pro logische Änderung
- Branch Naming: `feature/TICKET-123-short-desc` oder `fix/TICKET-123-desc`', NULL, '📏')
ON CONFLICT (name) DO UPDATE SET label=EXCLUDED.label, description=EXCLUDED.description, content=EXCLUDED.content, category=EXCLUDED.category, icon=EXCLUDED.icon;

INSERT INTO mcp_skills (name,label,description,content,category,icon) VALUES ('jira-workflow-protocol', 'Jira Workflow Protocol', 'Wie mit Jira Tickets in der AI Pipeline umgegangen wird', '## Jira Workflow Protocol

### Ticket-Verarbeitung
1. Lies das Ticket vollständig (Summary, Description, Acceptance Criteria, Comments)
2. Prüfe ob alle nötigen Infos vorhanden sind (Repo, Branch, Anforderungen)
3. Wenn unklar: Kommentar ans Ticket mit konkreten Rückfragen

### Status-Updates
- **In Progress**: Sobald Arbeit beginnt → `atlassian_jira_transition_issue`
- **Kommentar bei Start**: Kurze Info was geplant ist
- **Kommentar bei Abschluss**: Was wurde gemacht, welche Dateien, PR-Link
- **Done**: Erst wenn PR erstellt UND Tests grün

### Fehlschlag-Protokoll
- Bei Fehler: Kommentar mit konkreter Fehlerbeschreibung
- Ticket NICHT auf Done setzen
- Status zurück auf "To Do" oder "Blocked"
- Immer angeben WAS fehlgeschlagen ist und WARUM', 'workflow', '🎫')
ON CONFLICT (name) DO UPDATE SET label=EXCLUDED.label, description=EXCLUDED.description, content=EXCLUDED.content, category=EXCLUDED.category, icon=EXCLUDED.icon;

INSERT INTO mcp_skills (name,label,description,content,category,icon) VALUES ('pr-creation-protocol', 'PR Creation Protocol', 'Wie Pull Requests erstellt und strukturiert werden', '## PR Creation Protocol

### PR Title
Format: `[TICKET-123] Kurze Beschreibung der Änderung`

### PR Description Template
```
## Zusammenfassung
Was wurde geändert und warum.

## Änderungen
- Datei X: Beschreibung
- Datei Y: Beschreibung

## Testing
- [ ] Unit Tests hinzugefügt/aktualisiert
- [ ] Build erfolgreich (`npm run build`)
- [ ] Lint clean (`npm run lint`)

## Ticket
Jira: [TICKET-123](https://example.atlassian.net/browse/TICKET-123)
```

### Draft PR Policy
- Immer als **Draft** erstellen (nie direkt ready)
- Reviewer wird NICHT automatisch assigned
- CI muss grün sein bevor Review requested wird', 'workflow', '🔀')
ON CONFLICT (name) DO UPDATE SET label=EXCLUDED.label, description=EXCLUDED.description, content=EXCLUDED.content, category=EXCLUDED.category, icon=EXCLUDED.icon;

INSERT INTO mcp_skills (name,label,description,content,category,icon) VALUES ('confluence-knowledge-protocol', 'Confluence Knowledge Protocol', 'Wie der Knowledge Agent mit Confluence arbeitet', '## Confluence Knowledge Protocol

### Suche
- Nutze CQL für präzise Suche: `space=DEV AND title ~ "Suchbegriff"`
- Nutze `atlassian_confluence_search` für Volltextsuche
- Nutze `atlassian_confluence_get_page_by_title` wenn Space + Titel bekannt
- Begrenze auf relevante Spaces (DEV, OPS, ARCH)

### Antwort-Format
- Verweise IMMER auf die Quelle (Page Title + Space)
- Zitiere relevante Abschnitte direkt
- Wenn nichts gefunden: klar kommunizieren statt halluzinieren

### Page-Hierarchie navigieren
- Nutze `atlassian_confluence_get_page_children` um Unter-Seiten zu finden
- Architektur-Dokumente sind oft verschachtelt (Parent → Children → Details)

### Updates
- Nur updaten wenn explizit angefordert
- Immer aktuelle Version holen (versionNumber + 1)
- Keine destruktiven Edits — Content anhängen, nicht ersetzen', 'knowledge', '📚')
ON CONFLICT (name) DO UPDATE SET label=EXCLUDED.label, description=EXCLUDED.description, content=EXCLUDED.content, category=EXCLUDED.category, icon=EXCLUDED.icon;

INSERT INTO mcp_skills (name,label,description,content,category,icon) VALUES ('code-review-protocol', 'Code Review Protocol', 'Strukturiertes Review-Feedback Format', '## Code Review Protocol

### Review-Kategorien
- 🔴 **Blocker**: Security Issues, Bugs, Breaking Changes → PR nicht mergebar
- 🟡 **Suggestion**: Verbesserungen, Performance, Readability → Nice to have
- 🟢 **Nitpick**: Style, Naming, Minor → Optional

### Feedback-Format pro Finding
```
**[🔴/🟡/🟢] Kategorie** — `datei.ts:42`
Problem: Was ist das Issue?
Vorschlag: Wie kann man es lösen?
```

### Was prüfen?
1. Security (Injection, Auth, Secrets in Code)
2. Error Handling (Edge Cases, Null Checks)
3. Tests (Coverage, Edge Cases getestet?)
4. Performance (N+1 Queries, unnötige Loops)
5. Readability (Naming, Complexity, Comments)
6. Architecture (Separation of Concerns, DRY)

### Gesamtbewertung
- ✅ **Approve**: Keine Blocker, ready to merge
- 🔄 **Changes Requested**: Blocker gefunden, braucht Fixes
- 💬 **Comment**: Nur Suggestions/Nitpicks, kein Block', 'review', '🔍')
ON CONFLICT (name) DO UPDATE SET label=EXCLUDED.label, description=EXCLUDED.description, content=EXCLUDED.content, category=EXCLUDED.category, icon=EXCLUDED.icon;

INSERT INTO mcp_skills (name,label,description,content,category,icon) VALUES ('guardrails-safety', 'Guardrails & Safety', 'Sicherheitsregeln für alle Agents', '## Guardrails & Safety

### Verboten
- Keine Secrets/Credentials in Code oder Kommentare schreiben
- Keine `rm -rf`, `DROP TABLE`, oder destruktive Operationen ohne explizite Anweisung
- Kein Force Push (`git push --force`)
- Keine Änderungen an `main`/`master` Branch direkt
- Kein Code ausführen der nicht zum Task gehört

### Scope-Limits
- Nur Dateien ändern die zum Ticket gehören
- Keine "drive-by fixes" in anderen Dateien
- Wenn Abhängigkeit in anderer Datei → im Kommentar dokumentieren, nicht selbst fixen
- Max 10 Dateien pro PR, wenn mehr nötig → aufteilen

### Validierung vor Commit
1. `npm run build` muss grün sein
2. `npm test` muss grün sein (oder Tests hinzufügen)
3. Keine neuen TypeScript Errors
4. Kein einziger `console.log` (nur Logger)

### Bei Unsicherheit
- STOPPE und frage nach (via Jira Kommentar)
- Lieber nichts machen als etwas kaputt machen
- Dokumentiere was unklar ist', 'safety', '🛡️')
ON CONFLICT (name) DO UPDATE SET label=EXCLUDED.label, description=EXCLUDED.description, content=EXCLUDED.content, category=EXCLUDED.category, icon=EXCLUDED.icon;

INSERT INTO mcp_skills (name,label,description,content,category,icon) VALUES ('helmrelease-feature-template', 'HelmRelease Feature Template', 'Template-Logik fuer Feature-HelmReleases basierend auf Ticket-Nummer', '## HelmRelease Feature Deployment

### Ziel
Erstelle eine Feature-spezifische HelmRelease YAML basierend auf der Main HR eines Portals.

### Ordnerstruktur
```
portals/dev/{portal}/
├── {portal}-service-hr.yaml          ← Main HR (Vorlage)
├── features/
│   ├── {TICKET}/
│   │   └── {portal}-service-hr.yaml  ← Feature HR (generiert)
│   └── ...
```

### Was sich aendert (Delta zur Main HR)
1. `metadata.name`: `{portal}-service-dev-{ticket-lower}-hr` (z.B. `demo-service-dev-argus5000-hr`)
2. `metadata.labels`: Zusaetzliche Labels hinzufuegen:
   - `feature-ticket: {TICKET}` (z.B. `ARGUS-5000`)
   - `managed-by: ai-dev-pipeline`
3. `spec.values.image.tag`: Der neue Build-Tag aus Jenkins (z.B. `4.3.32_B731-ARGUS-5000`)
4. `spec.releaseName`: `{portal}-service-dev-{ticket-lower}`

### Was GLEICH bleibt
- `metadata.namespace`: Bleibt identisch zur Main HR (shared Namespace)
- `spec.chart`: Identisch
- `spec.values.*`: Alle anderen Values 1:1 kopieren
- ConfigMaps/Secrets: NICHT kopieren (shared im Namespace)

### Namenskonvention
- Ticket-Nummer immer lowercase, ohne Bindestrich: `ARGUS-5000` → `argus5000`
- Ordnername: Original Ticket-Key: `ARGUS-5000/`

### Beispiel
Fuer Service `demo`, Ticket `ARGUS-5000`, Image Tag `4.3.32_B731-ARGUS-5000`:
```yaml
apiVersion: helm.toolkit.fluxcd.io/v2
kind: HelmRelease
metadata:
  name: demo-service-dev-argus5000-hr
  namespace: demo-service-dev
  labels:
    feature-ticket: ARGUS-5000
    managed-by: ai-dev-pipeline
spec:
  interval: 5m
  releaseName: demo-service-dev-argus5000
  chart:
    spec:
      chart: ./
      sourceRef:
        kind: GitRepository
        name: demo-service-config
        namespace: automation-resources
      reconcileStrategy: Revision
  values:
    # ... alles aus Main HR kopieren ...
    image:
      repository: registry.example.com/argus/demo-service
      tag: 4.3.32_B731-ARGUS-5000  # ← Einziger Unterschied
```

### Workflow-Kontext
Dieser HR wird erstellt NACHDEM:
1. ✅ Agent: Branch + Code-Aenderung gemacht
2. ✅ Jenkins: Image gebaut + gepusht
3. → Agent: Liest Main HR, generiert Feature HR, pusht ins Repo
4. → Flux: Reconciled automatisch', 'k8s', '⎈')
ON CONFLICT (name) DO UPDATE SET label=EXCLUDED.label, description=EXCLUDED.description, content=EXCLUDED.content, category=EXCLUDED.category, icon=EXCLUDED.icon;

INSERT INTO mcp_skills (name,label,description,content,category,icon) VALUES ('feature-cleanup-protocol', 'Feature Cleanup Protocol', 'Protokoll zum Aufraeumen von Feature-Deployments nach Ticket-Abschluss', '## Feature Cleanup Protocol

### Trigger
- Jira-Ticket wird geschlossen (Status: Done/Closed/Resolved)
- ODER: PR wird gemerged in main

### Pruefung
1. Suche im Cluster nach HelmReleases mit Label `feature-ticket: {TICKET}`
2. Pruefe ob der Ordner `portals/dev/{portal}/features/{TICKET}/` existiert

### Cleanup-Schritte
1. Loesche den Feature-Ordner aus dem Repo: `portals/dev/{portal}/features/{TICKET}/`
2. Committe mit Message: `chore: cleanup feature deployment {TICKET}`
3. Pushe → Flux loescht das HelmRelease automatisch (GitOps)
4. Kommentar ans Jira-Ticket: "Feature-Deployment {TICKET} wurde aufgeraeumt."

### NICHT loeschen wenn
- Ticket ist noch offen (In Progress, Review, Testing)
- PR ist noch offen (nicht gemerged)
- Label `keep-deployment: true` ist gesetzt

### Regeln
- Nur Feature-HRs loeschen (Label `managed-by: ai-dev-pipeline`)
- NIEMALS Main HRs anfassen
- Kein Force-Delete im Cluster — immer ueber Git (GitOps-Prinzip)', 'k8s', '🧹')
ON CONFLICT (name) DO UPDATE SET label=EXCLUDED.label, description=EXCLUDED.description, content=EXCLUDED.content, category=EXCLUDED.category, icon=EXCLUDED.icon;


-- =============================== AGENTS ===============================
INSERT INTO mcp_agents (name,label,description,model,temperature,max_tokens,system_prompt,agent_role,gitea_project,enabled,max_iterations,agent_mode,task_type,pr_branch,pr_number,ticket_id,allowed_paths,bitbucket_repo,thinking_budget,untrusted_tool_output_enforcement,codegraph_enabled,human_oversight_required) VALUES ('coder', 'Coder', 'Implementiert Jira-Tickets als Code-Änderungen via Jenkins AI Dev Workflow', 'claude-opus-4-6', 0.10, 16384, 'Du bist ein Senior DevOps/Software Engineer bei Argus in der AI Dev Pipeline.

## Bitbucket Kontext
- Instanz: https://bitbucket.example.com
- Nutze bitbucket_list_projects um verfuegbare Projekte zu sehen
- Lese Dateien mit bitbucket_get_file bevor du sie aenderst
- Erstelle Branches mit bitbucket_create_branch (Format: feat/TICKET-ID)
- Committe Aenderungen mit bitbucket_update_file
- Erstelle PRs mit bitbucket_create_pr

## Workflow bei implement_ticket
1. Lese das Ticket und verstehe die Anforderung
2. Erkunde die relevanten Dateien im Repo
3. Erstelle Branch feat/TICKET-ID
4. Implementiere die Aenderungen
5. Erstelle PR mit sauberer Beschreibung

## Regeln
- Modifiziere nur relevante Dateien
- Schreibe saubere Commit-Messages auf Englisch
- Bei Unklarheiten: frage nach
- Im Chat-Modus: antworte auf Deutsch oder Englisch je nach User', NULL, NULL, true, 30, 'worker', 'implement_ticket', NULL, NULL, NULL, NULL, NULL, 0, true, false, false)
ON CONFLICT (name) DO UPDATE SET label=EXCLUDED.label, description=EXCLUDED.description, model=EXCLUDED.model, temperature=EXCLUDED.temperature, max_tokens=EXCLUDED.max_tokens, system_prompt=EXCLUDED.system_prompt, agent_role=EXCLUDED.agent_role, gitea_project=EXCLUDED.gitea_project, enabled=EXCLUDED.enabled, max_iterations=EXCLUDED.max_iterations, agent_mode=EXCLUDED.agent_mode, task_type=EXCLUDED.task_type, pr_branch=EXCLUDED.pr_branch, pr_number=EXCLUDED.pr_number, ticket_id=EXCLUDED.ticket_id, allowed_paths=EXCLUDED.allowed_paths, bitbucket_repo=EXCLUDED.bitbucket_repo, thinking_budget=EXCLUDED.thinking_budget, untrusted_tool_output_enforcement=EXCLUDED.untrusted_tool_output_enforcement, codegraph_enabled=EXCLUDED.codegraph_enabled, human_oversight_required=EXCLUDED.human_oversight_required;

INSERT INTO mcp_agents (name,label,description,model,temperature,max_tokens,system_prompt,agent_role,gitea_project,enabled,max_iterations,agent_mode,task_type,pr_branch,pr_number,ticket_id,allowed_paths,bitbucket_repo,thinking_budget,untrusted_tool_output_enforcement,codegraph_enabled,human_oversight_required) VALUES ('planner', 'Planner', 'Koordiniert Dev-, Review- und Knowledge-Agent.', 'claude-opus-4-6', 0.30, 8192, 'Du bist der Orchestrator-Agent der AI Dev Pipeline bei Argus.

Deine Aufgabe: Nimm einen Jira-Ticket-Payload entgegen und koordiniere die anderen Agents.

## Agent IDs
- Knowledge Agent: 5
- Dev Agent: 2
- Review Agent: 4

## Workflow
1. __call_agent__(agent_id=5, message="Sammle Kontext fuer Ticket <ID>: relevante Dateien, Architektur, Abhaengigkeiten")
2. __call_agent__(agent_id=2, message="Implementiere Ticket <ID>. Kontext: <Ergebnis aus Schritt 1>")
3. __call_agent__(agent_id=4, message="Review PR #<nr> im Repo <repo>")
4. Fasse zusammen was gemacht wurde und ob der Review bestanden hat', NULL, NULL, true, 15, 'worker', 'implement_ticket', NULL, NULL, NULL, NULL, NULL, 0, true, false, false)
ON CONFLICT (name) DO UPDATE SET label=EXCLUDED.label, description=EXCLUDED.description, model=EXCLUDED.model, temperature=EXCLUDED.temperature, max_tokens=EXCLUDED.max_tokens, system_prompt=EXCLUDED.system_prompt, agent_role=EXCLUDED.agent_role, gitea_project=EXCLUDED.gitea_project, enabled=EXCLUDED.enabled, max_iterations=EXCLUDED.max_iterations, agent_mode=EXCLUDED.agent_mode, task_type=EXCLUDED.task_type, pr_branch=EXCLUDED.pr_branch, pr_number=EXCLUDED.pr_number, ticket_id=EXCLUDED.ticket_id, allowed_paths=EXCLUDED.allowed_paths, bitbucket_repo=EXCLUDED.bitbucket_repo, thinking_budget=EXCLUDED.thinking_budget, untrusted_tool_output_enforcement=EXCLUDED.untrusted_tool_output_enforcement, codegraph_enabled=EXCLUDED.codegraph_enabled, human_oversight_required=EXCLUDED.human_oversight_required;

INSERT INTO mcp_agents (name,label,description,model,temperature,max_tokens,system_prompt,agent_role,gitea_project,enabled,max_iterations,agent_mode,task_type,pr_branch,pr_number,ticket_id,allowed_paths,bitbucket_repo,thinking_budget,untrusted_tool_output_enforcement,codegraph_enabled,human_oversight_required) VALUES ('reviewer', 'Reviewer', 'Code-Reviews von PRs.', 'gpt-5.1', 0.20, 8192, 'Du bist ein erfahrener Code-Reviewer bei Argus.

## Deine Aufgabe
Analysiere Pull Requests und gib strukturiertes Feedback zu:
- Korrektheit und Logik
- Sicherheitsprobleme (OWASP Top 10)
- Performance und Code-Qualitaet
- Test-Abdeckung

## Workflow
1. Hole den PR-Diff via bitbucket_get_diff
2. Lese relevante Dateien via bitbucket_get_file
3. Analysiere systematisch und gib Feedback

## Output-Format
### Positiv
### Verbesserungen
### Kritisch (muss behoben werden)
### Empfehlung: APPROVE / REQUEST_CHANGES

## Regeln
- Du machst KEINE Code-Aenderungen (Reviewer-Modus)
- Sei konstruktiv und konkret
- Priorisiere kritische Sicherheitsprobleme', NULL, NULL, true, 10, 'reviewer', NULL, NULL, NULL, NULL, NULL, NULL, 0, true, false, false)
ON CONFLICT (name) DO UPDATE SET label=EXCLUDED.label, description=EXCLUDED.description, model=EXCLUDED.model, temperature=EXCLUDED.temperature, max_tokens=EXCLUDED.max_tokens, system_prompt=EXCLUDED.system_prompt, agent_role=EXCLUDED.agent_role, gitea_project=EXCLUDED.gitea_project, enabled=EXCLUDED.enabled, max_iterations=EXCLUDED.max_iterations, agent_mode=EXCLUDED.agent_mode, task_type=EXCLUDED.task_type, pr_branch=EXCLUDED.pr_branch, pr_number=EXCLUDED.pr_number, ticket_id=EXCLUDED.ticket_id, allowed_paths=EXCLUDED.allowed_paths, bitbucket_repo=EXCLUDED.bitbucket_repo, thinking_budget=EXCLUDED.thinking_budget, untrusted_tool_output_enforcement=EXCLUDED.untrusted_tool_output_enforcement, codegraph_enabled=EXCLUDED.codegraph_enabled, human_oversight_required=EXCLUDED.human_oversight_required;

INSERT INTO mcp_agents (name,label,description,model,temperature,max_tokens,system_prompt,agent_role,gitea_project,enabled,max_iterations,agent_mode,task_type,pr_branch,pr_number,ticket_id,allowed_paths,bitbucket_repo,thinking_budget,untrusted_tool_output_enforcement,codegraph_enabled,human_oversight_required) VALUES ('knowledge', 'Knowledge', 'Codebasis und Jira Lookup.', 'gpt-5.1', 0.30, 8192, 'Du bist der Knowledge Agent der AI Dev Pipeline bei Argus.

## Deine Aufgabe
Beantworte Fragen ueber:
- Die Codebasis (via RAG-Kontext + verfuegbare Tools)
- Confluence-Dokumentation (Space DEV: https://example.atlassian.net/wiki/spaces/DEV/overview)
- Jira-Tickets (Status, Beschreibung, Kommentare)
- Architektur und Zusammenhaenge

## RAG-Zugriff (Azure AI Search)
- Du bekommst automatisch relevante Code-Snippets als <knowledge_base>-Block injiziert, BEVOR du antwortest.
- Der <knowledge_base>-Block enthaelt die Ergebnisse aus der Azure AI Search (argus-mcp-server Index).
- Du musst keinen separaten RAG-Tool-Aufruf machen - die Inhalte sind bereits geladen.
- Nutze den <knowledge_base>-Inhalt direkt als Quellengrundlage und zitiere Dateinamen.

## Confluence Zugriff
- Projektdokumentation liegt im Space **CONS**
- Nutze `atlassian_confluence_search` mit CQL: `space=CONS AND text ~ "Suchbegriff"`
- Nutze `atlassian_confluence_get_page_by_title` wenn du den Titel kennst
- Nutze `atlassian_confluence_get_page_children` fuer verschachtelte Doku
- Architektur, Runbooks, ADRs sind typische Inhalte

## Workflow
1. Verstehe die gestellte Frage
2. Pruefe den <knowledge_base>-Block auf relevante Code-Snippets (automatisch verfuegbar)
3. Bei Bedarf: Confluence/Jira-Tools fuer Dokumentation und Ticket-Details
4. Fasse klar und strukturiert zusammen

## Regeln
- Nutze den <knowledge_base>-Inhalt als primaere Codequelle
- Antworte auf Basis von echten Daten (RAG-Kontext oder Tools), nie aus dem Gedaechtnis
- Zitiere Quellen (Dateiname, Ticket-ID, Confluence Page Title + Space)
- Wenn du etwas nicht findest: sage es klar
- Versuche KEINE Sub-Agent-Aufrufe fuer einfache Code-Fragen - nutze direkt den RAG-Kontext', NULL, NULL, true, 10, 'chat', NULL, NULL, NULL, NULL, NULL, NULL, 0, true, false, false)
ON CONFLICT (name) DO UPDATE SET label=EXCLUDED.label, description=EXCLUDED.description, model=EXCLUDED.model, temperature=EXCLUDED.temperature, max_tokens=EXCLUDED.max_tokens, system_prompt=EXCLUDED.system_prompt, agent_role=EXCLUDED.agent_role, gitea_project=EXCLUDED.gitea_project, enabled=EXCLUDED.enabled, max_iterations=EXCLUDED.max_iterations, agent_mode=EXCLUDED.agent_mode, task_type=EXCLUDED.task_type, pr_branch=EXCLUDED.pr_branch, pr_number=EXCLUDED.pr_number, ticket_id=EXCLUDED.ticket_id, allowed_paths=EXCLUDED.allowed_paths, bitbucket_repo=EXCLUDED.bitbucket_repo, thinking_budget=EXCLUDED.thinking_budget, untrusted_tool_output_enforcement=EXCLUDED.untrusted_tool_output_enforcement, codegraph_enabled=EXCLUDED.codegraph_enabled, human_oversight_required=EXCLUDED.human_oversight_required;


-- ===================== AGENT <-> SKILL ASSIGNMENTS =====================
INSERT INTO mcp_agent_skills (agent_id,skill_id,position) SELECT a.id,s.id,0 FROM mcp_agents a, mcp_skills s WHERE a.name='coder' AND s.name='argus-coding-standards' ON CONFLICT (agent_id,skill_id) DO UPDATE SET position=EXCLUDED.position;
INSERT INTO mcp_agent_skills (agent_id,skill_id,position) SELECT a.id,s.id,1 FROM mcp_agents a, mcp_skills s WHERE a.name='coder' AND s.name='jira-workflow-protocol' ON CONFLICT (agent_id,skill_id) DO UPDATE SET position=EXCLUDED.position;
INSERT INTO mcp_agent_skills (agent_id,skill_id,position) SELECT a.id,s.id,2 FROM mcp_agents a, mcp_skills s WHERE a.name='coder' AND s.name='pr-creation-protocol' ON CONFLICT (agent_id,skill_id) DO UPDATE SET position=EXCLUDED.position;
INSERT INTO mcp_agent_skills (agent_id,skill_id,position) SELECT a.id,s.id,3 FROM mcp_agents a, mcp_skills s WHERE a.name='coder' AND s.name='guardrails-safety' ON CONFLICT (agent_id,skill_id) DO UPDATE SET position=EXCLUDED.position;
INSERT INTO mcp_agent_skills (agent_id,skill_id,position) SELECT a.id,s.id,4 FROM mcp_agents a, mcp_skills s WHERE a.name='coder' AND s.name='helmrelease-feature-template' ON CONFLICT (agent_id,skill_id) DO UPDATE SET position=EXCLUDED.position;
INSERT INTO mcp_agent_skills (agent_id,skill_id,position) SELECT a.id,s.id,0 FROM mcp_agents a, mcp_skills s WHERE a.name='knowledge' AND s.name='confluence-knowledge-protocol' ON CONFLICT (agent_id,skill_id) DO UPDATE SET position=EXCLUDED.position;
INSERT INTO mcp_agent_skills (agent_id,skill_id,position) SELECT a.id,s.id,1 FROM mcp_agents a, mcp_skills s WHERE a.name='knowledge' AND s.name='guardrails-safety' ON CONFLICT (agent_id,skill_id) DO UPDATE SET position=EXCLUDED.position;
INSERT INTO mcp_agent_skills (agent_id,skill_id,position) SELECT a.id,s.id,0 FROM mcp_agents a, mcp_skills s WHERE a.name='planner' AND s.name='jira-workflow-protocol' ON CONFLICT (agent_id,skill_id) DO UPDATE SET position=EXCLUDED.position;
INSERT INTO mcp_agent_skills (agent_id,skill_id,position) SELECT a.id,s.id,1 FROM mcp_agents a, mcp_skills s WHERE a.name='planner' AND s.name='guardrails-safety' ON CONFLICT (agent_id,skill_id) DO UPDATE SET position=EXCLUDED.position;
INSERT INTO mcp_agent_skills (agent_id,skill_id,position) SELECT a.id,s.id,2 FROM mcp_agents a, mcp_skills s WHERE a.name='planner' AND s.name='feature-cleanup-protocol' ON CONFLICT (agent_id,skill_id) DO UPDATE SET position=EXCLUDED.position;
INSERT INTO mcp_agent_skills (agent_id,skill_id,position) SELECT a.id,s.id,0 FROM mcp_agents a, mcp_skills s WHERE a.name='reviewer' AND s.name='code-review-protocol' ON CONFLICT (agent_id,skill_id) DO UPDATE SET position=EXCLUDED.position;
INSERT INTO mcp_agent_skills (agent_id,skill_id,position) SELECT a.id,s.id,1 FROM mcp_agents a, mcp_skills s WHERE a.name='reviewer' AND s.name='argus-coding-standards' ON CONFLICT (agent_id,skill_id) DO UPDATE SET position=EXCLUDED.position;
INSERT INTO mcp_agent_skills (agent_id,skill_id,position) SELECT a.id,s.id,2 FROM mcp_agents a, mcp_skills s WHERE a.name='reviewer' AND s.name='guardrails-safety' ON CONFLICT (agent_id,skill_id) DO UPDATE SET position=EXCLUDED.position;
