// ── Template Categories ──────────────────────────────────────

export interface TemplateCategory {
  id: string;
  label: string;
  icon: string;
  sortOrder: number;
}

export const TEMPLATE_CATEGORIES: TemplateCategory[] = [
  { id: 'database',          label: 'Datenbank & Daten',          icon: '🗄️', sortOrder: 1 },
  { id: 'monitoring',        label: 'Monitoring & Observability',  icon: '📊', sortOrder: 2 },
  { id: 'devops',            label: 'DevOps & CI/CD',             icon: '🔧', sortOrder: 3 },
  { id: 'projectmanagement', label: 'Projektmanagement',          icon: '📋', sortOrder: 4 },
  { id: 'cloud',             label: 'Cloud & Infrastruktur',      icon: '☁️', sortOrder: 5 },
  { id: 'communication',     label: 'Kommunikation',              icon: '💬', sortOrder: 6 },
  { id: 'security',          label: 'Sicherheit',                 icon: '🔒', sortOrder: 7 },
  { id: 'api',               label: 'Generisch',                  icon: '🔌', sortOrder: 8 },
];

export function getCategoryLabel(id: string): string {
  return TEMPLATE_CATEGORIES.find(c => c.id === id)?.label ?? id;
}
