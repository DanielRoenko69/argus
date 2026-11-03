-- Migration 147: remove organisation-specific assumptions from existing
-- compliance checklists and keep the compliance auditor provider-neutral.
-- Fresh installs already receive the neutral text from migrations 066/067/069;
-- these replacements upgrade databases that applied the historical seeds.

UPDATE mcp_skills
   SET content = replace(
     content,
     $old_nis2$NIS2 gilt für „wesentliche" und „wichtige" Einrichtungen. Argus ist
Payment-Provider und damit „wesentlich" — daher gelten alle Anforderungen
in voller Schärfe.$old_nis2$,
     $new_nis2$NIS2 gilt für bestimmte „wesentliche" und „wichtige" Einrichtungen. Vor
dem Assessment muss der Betreiber anhand seiner Rolle, Branche, Größe und
des konkreten Einsatzes klären, ob und in welchem Umfang das Ziel in den
Anwendungsbereich fällt. Argus nimmt keine rechtliche Einordnung vor.
Nicht anwendbare Anforderungen sind als `not_applicable` nachvollziehbar
zu begründen.$new_nis2$
   )
 WHERE name = 'nis2_checklist';

UPDATE mcp_skills
   SET content = replace(
     content,
     $old_dora$DORA gilt **direkt** für Finanzunternehmen — Banken, Versicherer, Payment-
Provider. Argus ist Payment-Provider und damit voll im Scope.
Anforderungen seit **17. Januar 2025** verbindlich.$old_dora$,
     $new_dora$DORA gilt für die in der Verordnung benannten Finanzunternehmen und kann
auch Pflichten rund um ICT-Drittdienstleister berühren. Vor dem Assessment
muss der Betreiber seine konkrete Rolle und Anwendbarkeit fachlich und
rechtlich klären; Argus nimmt keine pauschale Scope-Einstufung vor.
Nicht anwendbare Anforderungen sind als `not_applicable` nachvollziehbar
zu begründen. Die Verordnung gilt seit **17. Januar 2025**.$new_dora$
   )
 WHERE name = 'dora_checklist';

COMMENT ON COLUMN mcp_agents.agent_mode IS
  'chat | worker | reviewer. The compliance runner expects a reviewer-mode agent so audits use the configured provider-neutral agent runtime with a dedicated, least-privilege evidence-tool scope.';
