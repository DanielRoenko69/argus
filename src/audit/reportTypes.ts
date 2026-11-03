import type { AuditEvidencePackV1 } from './evidencePack.js';

export type AuditReportType = 'governance' | 'compliance' | 'run_evidence' | 'incident';
export type AuditReportCadence = 'manual' | 'daily' | 'weekly' | 'monthly';
export type AuditReportFormat = 'pdf' | 'json' | 'jsonl' | 'csv';
export type AuditReportStatus = 'queued' | 'running' | 'completed' | 'failed';

export interface AuditReportFilters {
  actorId?: string | null;
  action?: string | null;
  resourceType?: string | null;
  resourceId?: string | null;
}

export interface AuditReportDefinition {
  id: string;
  workspaceKey: string;
  tenantKey: string;
  environment: string;
  name: string;
  reportType: AuditReportType;
  cadence: AuditReportCadence;
  timezone: string;
  scheduleHour: number;
  scheduleWeekday: number | null;
  scheduleMonthday: number | null;
  windowDays: number;
  filters: AuditReportFilters;
  formats: AuditReportFormat[];
  enabled: boolean;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  nextRunAt: string | null;
  lastRunAt: string | null;
  disabledAt: string | null;
}

export interface AuditReportSummary {
  title: string;
  period: { from: string; to: string };
  eventCount: number;
  actorCount: number;
  successCount: number;
  deniedCount: number;
  failureCount: number;
  criticalRiskCount: number;
  topActions: Array<{ action: string; count: number }>;
  controlCoverage: Array<{ framework: string; control: string; evidence: string }>;
  gapCodes: string[];
}

export interface AuditReportReview {
  id: string;
  decision: 'approved' | 'rejected' | 'superseded';
  actorId: string;
  actorAuthMethod: string;
  occurredAt: string;
  auditEventId: string;
}

export interface AuditReportRun {
  id: string;
  definitionId: string | null;
  workspaceKey: string;
  tenantKey: string;
  environment: string;
  reportType: AuditReportType;
  name: string;
  triggerType: 'manual' | 'scheduled' | 'event';
  requestedBy: string;
  status: AuditReportStatus;
  periodFrom: string;
  periodTo: string;
  filters: AuditReportFilters;
  checkpointId: string | null;
  packId: string | null;
  packDigest: string | null;
  verificationState: 'valid' | 'invalid' | null;
  eventCount: number;
  chainEntryCount: number;
  gapCodes: string[];
  summary: AuditReportSummary | null;
  evidencePack?: AuditEvidencePackV1 | null;
  errorCode: string | null;
  errorMessage: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  reviews: AuditReportReview[];
}

export interface CreateAuditReportDefinitionInput {
  workspaceKey: string;
  tenantKey: string;
  environment: string;
  name: string;
  reportType: AuditReportType;
  cadence: AuditReportCadence;
  timezone: string;
  scheduleHour: number;
  scheduleWeekday: number | null;
  scheduleMonthday: number | null;
  windowDays: number;
  filters: AuditReportFilters;
  formats: AuditReportFormat[];
  createdBy: string;
  now?: Date;
}
