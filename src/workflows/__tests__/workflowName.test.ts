import { describe, it, expect } from '@jest/globals';
import { WORKFLOW_NAME_RE, isValidWorkflowName, slugifyWorkflowName } from '../workflowName.js';

// Guards the wf_name_format DB constraint (^[a-z0-9_]+$). Before this, the create
// route passed raw names to the INSERT, so "Coding Workflow" -> Postgres 23514 ->
// confusing HTTP 500. These two helpers let the route reject early (400) and the
// UIs slugify before sending.
describe('workflow name validation', () => {
  describe('isValidWorkflowName', () => {
    it('accepts lowercase letters, digits, underscores', () => {
      expect(isValidWorkflowName('coding_workflow')).toBe(true);
      expect(isValidWorkflowName('daily_report_copy_123')).toBe(true);
      expect(isValidWorkflowName('a')).toBe(true);
    });
    it('rejects spaces, hyphens, uppercase, empty, and punctuation', () => {
      expect(isValidWorkflowName('Coding Workflow')).toBe(false);
      expect(isValidWorkflowName('test-1')).toBe(false);
      expect(isValidWorkflowName('Test')).toBe(false);
      expect(isValidWorkflowName('')).toBe(false);
      expect(isValidWorkflowName('a.b')).toBe(false);
      expect(isValidWorkflowName('café')).toBe(false);
    });
    it('matches WORKFLOW_NAME_RE exactly', () => {
      expect(WORKFLOW_NAME_RE.test('ok_1')).toBe(true);
      expect(WORKFLOW_NAME_RE.test('not ok')).toBe(false);
    });
  });

  describe('slugifyWorkflowName', () => {
    it('lowercases and replaces spaces with underscores', () => {
      expect(slugifyWorkflowName('Coding Workflow')).toBe('coding_workflow');
    });
    it('collapses runs of disallowed chars into a single underscore', () => {
      expect(slugifyWorkflowName('K8s Pod-Restart #1')).toBe('k8s_pod_restart_1');
      expect(slugifyWorkflowName('a   ---   b')).toBe('a_b');
    });
    it('strips diacritics (German umlauts)', () => {
      expect(slugifyWorkflowName('Täglicher Report')).toBe('taglicher_report');
      expect(slugifyWorkflowName('Über')).toBe('uber');
    });
    it('trims leading/trailing underscores', () => {
      expect(slugifyWorkflowName('  hello  ')).toBe('hello');
      expect(slugifyWorkflowName('---x---')).toBe('x');
    });
    it('returns empty string when nothing usable remains', () => {
      expect(slugifyWorkflowName('   ')).toBe('');
      expect(slugifyWorkflowName('###')).toBe('');
      expect(slugifyWorkflowName('')).toBe('');
    });
    it('always produces a valid name (or empty)', () => {
      for (const raw of ['Coding Workflow', 'K8s Pod-Restart #1', 'Täglicher Report', 'MiXeD_CaSe-99']) {
        const slug = slugifyWorkflowName(raw);
        expect(slug === '' || isValidWorkflowName(slug)).toBe(true);
      }
    });
  });
});
