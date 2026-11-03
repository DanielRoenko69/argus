-- Migration 022: Bitbucket Server + Jira Server Tools
-- Backends werden über die Admin UI mit echten URLs/Tokens befüllt.
-- Auth wird vom Backend-Layer automatisch gesetzt (buildAuthHeaders).
-- Template-Format für custom backends: "METHOD /path\n\n{body}" (Leerzeile vor Body).
-- Content-Type wird von executeCustomBackend automatisch auf application/json gesetzt.

-- ── Backends (disabled bis echte Creds eingetragen) ────────────

INSERT INTO mcp_backends (name, description, base_url, backend_type, auth_type, auth_value, enabled)
VALUES
  ('bitbucket', 'Bitbucket Server REST API', 'https://bitbucket.example.com', 'http', 'bearer', '', false),
  ('jira',      'Jira Server REST API',      'https://jira.example.com',      'http', 'bearer', '', false)
ON CONFLICT (name) DO NOTHING;

-- ── Bitbucket Server Tools ──────────────────────────────────────

INSERT INTO mcp_tools (name, description, backend, category, enabled, query_template, parameters) VALUES

('bitbucket_get_file',
 'Liest den Inhalt einer Datei aus einem Bitbucket-Repository.',
 'custom:bitbucket',
 'bitbucket',
 true,
 'GET /rest/api/1.0/projects/{{project}}/repos/{{repo}}/raw/{{path}}?at={{ref}}',
 '[
   {"name":"project","type":"string","description":"Bitbucket Project Key (z.B. PROJ)","required":true},
   {"name":"repo","type":"string","description":"Repository Slug","required":true},
   {"name":"path","type":"string","description":"Dateipfad im Repo (z.B. src/main.ts)","required":true},
   {"name":"ref","type":"string","description":"Branch, Tag oder Commit-Hash","required":false,"default":"HEAD"}
 ]'::jsonb),

('bitbucket_list_files',
 'Listet Dateien und Unterverzeichnisse in einem Pfad eines Bitbucket-Repos auf.',
 'custom:bitbucket',
 'bitbucket',
 true,
 'GET /rest/api/1.0/projects/{{project}}/repos/{{repo}}/browse/{{path}}?at={{ref}}&limit=100',
 '[
   {"name":"project","type":"string","description":"Bitbucket Project Key","required":true},
   {"name":"repo","type":"string","description":"Repository Slug","required":true},
   {"name":"path","type":"string","description":"Verzeichnispfad (leer = Root)","required":false,"default":""},
   {"name":"ref","type":"string","description":"Branch oder Commit-Hash","required":false,"default":"HEAD"}
 ]'::jsonb),

('bitbucket_create_branch',
 'Erstellt einen neuen Branch in einem Bitbucket-Repository.',
 'custom:bitbucket',
 'bitbucket',
 true,
 E'POST /rest/api/1.0/projects/{{project}}/repos/{{repo}}/branches\n\n{"name":"{{branch}}","startPoint":"{{start_point}}"}',
 '[
   {"name":"project","type":"string","description":"Bitbucket Project Key","required":true},
   {"name":"repo","type":"string","description":"Repository Slug","required":true},
   {"name":"branch","type":"string","description":"Name des neuen Branches (z.B. feat/PROJ-123)","required":true},
   {"name":"start_point","type":"string","description":"Start-Branch oder Commit-Hash","required":false,"default":"main"}
 ]'::jsonb),

('bitbucket_update_file',
 'Erstellt oder aktualisiert eine Datei in einem Bitbucket-Repository via Commit.',
 'custom:bitbucket',
 'bitbucket',
 true,
 E'PUT /rest/api/1.0/projects/{{project}}/repos/{{repo}}/browse/{{path}}\n\n{"content":"{{content}}","message":"{{message}}","branch":"{{branch}}","sourceCommitId":"{{source_commit_id}}"}',
 '[
   {"name":"project","type":"string","description":"Bitbucket Project Key","required":true},
   {"name":"repo","type":"string","description":"Repository Slug","required":true},
   {"name":"path","type":"string","description":"Dateipfad im Repo","required":true},
   {"name":"branch","type":"string","description":"Branch auf dem committed wird","required":true},
   {"name":"content","type":"string","description":"Neuer Dateiinhalt (base64-kodiert für Binärdateien, sonst plain text)","required":true},
   {"name":"message","type":"string","description":"Commit-Nachricht","required":true},
   {"name":"source_commit_id","type":"string","description":"Aktueller Commit-Hash der Datei (leer = neue Datei)","required":false,"default":""}
 ]'::jsonb),

('bitbucket_create_pr',
 'Erstellt einen Pull Request in Bitbucket.',
 'custom:bitbucket',
 'bitbucket',
 true,
 E'POST /rest/api/1.0/projects/{{project}}/repos/{{repo}}/pull-requests\n\n{"title":"{{title}}","description":"{{description}}","fromRef":{"id":"refs/heads/{{source_branch}}","repository":{"slug":"{{repo}}","project":{"key":"{{project}}"}}},"toRef":{"id":"refs/heads/{{target_branch}}","repository":{"slug":"{{repo}}","project":{"key":"{{project}}"}}},"reviewers":[]}',
 '[
   {"name":"project","type":"string","description":"Bitbucket Project Key","required":true},
   {"name":"repo","type":"string","description":"Repository Slug","required":true},
   {"name":"title","type":"string","description":"PR Titel","required":true},
   {"name":"description","type":"string","description":"PR Beschreibung","required":false,"default":""},
   {"name":"source_branch","type":"string","description":"Feature Branch (von)","required":true},
   {"name":"target_branch","type":"string","description":"Ziel-Branch (nach, z.B. main)","required":false,"default":"main"}
 ]'::jsonb),

('bitbucket_get_pr',
 'Ruft Details eines Pull Requests ab (Status, Reviewer, Kommentare).',
 'custom:bitbucket',
 'bitbucket',
 true,
 'GET /rest/api/1.0/projects/{{project}}/repos/{{repo}}/pull-requests/{{pr_id}}',
 '[
   {"name":"project","type":"string","description":"Bitbucket Project Key","required":true},
   {"name":"repo","type":"string","description":"Repository Slug","required":true},
   {"name":"pr_id","type":"number","description":"Pull Request ID","required":true}
 ]'::jsonb),

('bitbucket_list_prs',
 'Listet Pull Requests eines Repositories auf.',
 'custom:bitbucket',
 'bitbucket',
 true,
 'GET /rest/api/1.0/projects/{{project}}/repos/{{repo}}/pull-requests?state={{state}}&limit=25',
 '[
   {"name":"project","type":"string","description":"Bitbucket Project Key","required":true},
   {"name":"repo","type":"string","description":"Repository Slug","required":true},
   {"name":"state","type":"string","description":"PR Status: OPEN, MERGED, DECLINED, ALL","required":false,"default":"OPEN"}
 ]'::jsonb),

('bitbucket_get_diff',
 'Ruft den Diff eines Pull Requests ab.',
 'custom:bitbucket',
 'bitbucket',
 true,
 'GET /rest/api/1.0/projects/{{project}}/repos/{{repo}}/pull-requests/{{pr_id}}/diff',
 '[
   {"name":"project","type":"string","description":"Bitbucket Project Key","required":true},
   {"name":"repo","type":"string","description":"Repository Slug","required":true},
   {"name":"pr_id","type":"number","description":"Pull Request ID","required":true}
 ]'::jsonb),

('bitbucket_add_pr_comment',
 'Fügt einen Kommentar zu einem Pull Request hinzu.',
 'custom:bitbucket',
 'bitbucket',
 true,
 E'POST /rest/api/1.0/projects/{{project}}/repos/{{repo}}/pull-requests/{{pr_id}}/comments\n\n{"text":"{{comment}}"}',
 '[
   {"name":"project","type":"string","description":"Bitbucket Project Key","required":true},
   {"name":"repo","type":"string","description":"Repository Slug","required":true},
   {"name":"pr_id","type":"number","description":"Pull Request ID","required":true},
   {"name":"comment","type":"string","description":"Kommentartext","required":true}
 ]'::jsonb),

-- ── Jira Server Tools ───────────────────────────────────────────

('jira_get_issue',
 'Ruft Details eines Jira Issues ab (Summary, Description, Status, Assignee, Labels).',
 'custom:jira',
 'jira',
 true,
 'GET /rest/api/2/issue/{{issue_key}}?fields=summary,description,status,assignee,labels,priority,issuetype,components,fixVersions',
 '[
   {"name":"issue_key","type":"string","description":"Jira Issue Key (z.B. PROJ-123)","required":true}
 ]'::jsonb),

('jira_search_issues',
 'Sucht Jira Issues via JQL (Jira Query Language).',
 'custom:jira',
 'jira',
 true,
 'GET /rest/api/2/search?jql={{jql}}&maxResults={{max_results}}&fields=summary,status,assignee,priority',
 '[
   {"name":"jql","type":"string","description":"JQL Abfrage (z.B. project=PROJ AND status=Open)","required":true},
   {"name":"max_results","type":"number","description":"Maximale Anzahl Ergebnisse","required":false,"default":"20"}
 ]'::jsonb),

('jira_add_comment',
 'Fügt einen Kommentar zu einem Jira Issue hinzu.',
 'custom:jira',
 'jira',
 true,
 E'POST /rest/api/2/issue/{{issue_key}}/comment\n\n{"body":"{{comment}}"}',
 '[
   {"name":"issue_key","type":"string","description":"Jira Issue Key (z.B. PROJ-123)","required":true},
   {"name":"comment","type":"string","description":"Kommentartext","required":true}
 ]'::jsonb),

('jira_transition_issue',
 'Verschiebt ein Jira Issue in einen anderen Status (z.B. In Progress, Done).',
 'custom:jira',
 'jira',
 true,
 E'POST /rest/api/2/issue/{{issue_key}}/transitions\n\n{"transition":{"id":"{{transition_id}}"}}',
 '[
   {"name":"issue_key","type":"string","description":"Jira Issue Key","required":true},
   {"name":"transition_id","type":"string","description":"Transition ID (vorher via jira_get_transitions ermitteln)","required":true}
 ]'::jsonb),

('jira_get_transitions',
 'Listet verfügbare Status-Übergänge für ein Jira Issue auf.',
 'custom:jira',
 'jira',
 true,
 'GET /rest/api/2/issue/{{issue_key}}/transitions',
 '[
   {"name":"issue_key","type":"string","description":"Jira Issue Key","required":true}
 ]'::jsonb),

('jira_update_issue',
 'Aktualisiert Felder eines Jira Issues (z.B. Assignee, Labels, Fix Version).',
 'custom:jira',
 'jira',
 true,
 E'PUT /rest/api/2/issue/{{issue_key}}\n\n{"fields":{{fields_json}}}',
 '[
   {"name":"issue_key","type":"string","description":"Jira Issue Key","required":true},
   {"name":"fields_json","type":"string","description":"JSON-Objekt mit zu aktualisierenden Feldern (z.B. {\"assignee\":{\"name\":\"jdoe\"}})","required":true}
 ]'::jsonb)

ON CONFLICT (name) DO NOTHING;
