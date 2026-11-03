import { createRequire } from 'module';
import { logger } from './logger.js';
import { assertSsrfSafe } from '../backends/customBackends.js';

export type NotificationChannel = 'slack' | 'teams';

interface NotificationConfig {
  channel: NotificationChannel;
  webhookUrl: string;
}

let config: NotificationConfig | null = null;

// ── Email config (SMTP — no external service needed) ──────────
interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  user?: string;
  pass?: string;
  from: string;
  to: string[];
}

let smtpConfig: SmtpConfig | null = null;
// Cache transporter per-process
let smtpTransporter: unknown = null;

export function initNotifications(): void {
  const slackUrl = process.env.SLACK_WEBHOOK_URL;
  const teamsUrl = process.env.TEAMS_WEBHOOK_URL;

  if (slackUrl) {
    try { assertSsrfSafe(slackUrl); } catch { logger.warn('SLACK_WEBHOOK_URL blocked by SSRF guard — notifications disabled'); return; }
    config = { channel: 'slack', webhookUrl: slackUrl };
    logger.info('Slack notifications enabled');
  } else if (teamsUrl) {
    try { assertSsrfSafe(teamsUrl); } catch { logger.warn('TEAMS_WEBHOOK_URL blocked by SSRF guard — notifications disabled'); return; }
    config = { channel: 'teams', webhookUrl: teamsUrl };
    logger.info('Teams notifications enabled');
  } else {
    logger.info('Notifications disabled (no webhook URL configured)');
  }

  // Email / SMTP
  const smtpHost = process.env.SMTP_HOST;
  const alertEmail = process.env.ALERT_EMAIL_ADDRESS;
  if (smtpHost && alertEmail) {
    smtpConfig = {
      host: smtpHost,
      port: parseInt(process.env.SMTP_PORT ?? '587', 10),
      secure: process.env.SMTP_SECURE === 'true',
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASSWORD,
      from: process.env.SMTP_FROM ?? `Argus Alerts <argus@${smtpHost}>`,
      to: alertEmail.split(',').map(e => e.trim()).filter(Boolean),
    };
    logger.info({ host: smtpHost, to: smtpConfig.to }, 'Email alerts enabled');
  }
}

async function getTransporter(): Promise<unknown> {
  if (smtpTransporter) return smtpTransporter;
  if (!smtpConfig) return null;
  try {
    const _require = createRequire(import.meta.url);
    const nodemailer = _require('nodemailer') as {
      createTransport: (cfg: Record<string, unknown>) => unknown;
    };
    smtpTransporter = nodemailer.createTransport({
      host: smtpConfig.host,
      port: smtpConfig.port,
      secure: smtpConfig.secure,
      auth: smtpConfig.user ? { user: smtpConfig.user, pass: smtpConfig.pass } : undefined,
    });
    return smtpTransporter;
  } catch {
    logger.warn('nodemailer not installed — email alerts disabled (npm install nodemailer)');
    smtpConfig = null;
    return null;
  }
}

async function sendEmail(title: string, message: string, severity: string): Promise<void> {
  if (!smtpConfig) return;
  const transport = await getTransporter() as { sendMail: (m: Record<string, unknown>) => Promise<void> } | null;
  if (!transport) return;
  const severityLabel = severity === 'critical' ? '[CRITICAL]' : severity === 'warning' ? '[WARNING]' : '[INFO]';
  try {
    await transport.sendMail({
      from:    smtpConfig.from,
      to:      smtpConfig.to.join(', '),
      subject: `Argus ${severityLabel} ${title}`,
      text:    `${title}\n\n${message}\n\n-- Argus AI Platform`,
      html: `<h2 style="color:${severity === 'critical' ? '#dc2626' : severity === 'warning' ? '#f59e0b' : '#16a34a'}">${title}</h2>
<p>${message.replace(/\n/g, '<br>')}</p>
<hr><small>Argus AI Platform Alert</small>`,
    });
    logger.debug({ to: smtpConfig.to, title }, 'Alert email sent');
  } catch (err) {
    logger.warn({ err }, 'Failed to send alert email');
  }
}

export async function sendNotification(title: string, message: string, severity: 'info' | 'warning' | 'critical' = 'info'): Promise<void> {
  // Send to webhook (Slack/Teams) and email in parallel
  await Promise.allSettled([
    sendWebhook(title, message, severity),
    sendEmail(title, message, severity),
  ]);
}

async function sendWebhook(title: string, message: string, severity: string): Promise<void> {
  if (!config) return;
  try {
    const body = config.channel === 'slack'
      ? {
          text: `*${severity.toUpperCase()}: ${title}*\n${message}`,
          blocks: [
            { type: 'header', text: { type: 'plain_text', text: `${severityEmoji(severity)} ${title}` } },
            { type: 'section', text: { type: 'mrkdwn', text: message } },
          ],
        }
      : {
          '@type': 'MessageCard',
          themeColor: severityColor(severity),
          summary: title,
          sections: [{ activityTitle: title, text: message }],
        };

    const res = await fetch(config.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) logger.warn({ status: res.status }, 'Notification webhook returned non-OK status');
  } catch (err) {
    logger.error({ err }, 'Failed to send notification');
  }
}

function severityEmoji(s: string): string {
  return s === 'critical' ? '[CRIT]' : s === 'warning' ? '[WARN]' : '[OK]';
}

function severityColor(s: string): string {
  return s === 'critical' ? 'FF0000' : s === 'warning' ? 'FFA500' : '00FF00';
}
