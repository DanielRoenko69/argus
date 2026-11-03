import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ToolConfigForm } from '../ToolConfigForm';
import type { ToolParam } from '@/api/palette';

const SAMPLE: ToolParam[] = [
  { name: 'project', type: 'string', required: true, description: 'Jira project key' },
  { name: 'max_results', type: 'number', description: 'Cap', default: 50 },
  { name: 'notify', type: 'boolean', default: true },
];

describe('ToolConfigForm (schema mode)', () => {
  it('renders one input per declared parameter with help text and required asterisk', () => {
    render(<ToolConfigForm parameters={SAMPLE} args={{}} onChange={() => {}} />);

    // text field for string
    expect(screen.getByLabelText(/project/i)).toBeInTheDocument();
    // required marker
    expect(screen.getByText('project').closest('label')?.textContent).toContain('*');
    // description as help text
    expect(screen.getByText('Jira project key')).toBeInTheDocument();
    // number field
    const num = screen.getByLabelText(/max_results/i) as HTMLInputElement;
    expect(num.type).toBe('number');
    // boolean → checkbox
    const cb = screen.getByLabelText(/notify/i) as HTMLInputElement;
    expect(cb.type).toBe('checkbox');
  });

  it('emits onChange with the typed value when a field changes', () => {
    const onChange = vi.fn();
    render(<ToolConfigForm parameters={SAMPLE} args={{}} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText(/project/i), { target: { value: 'OPS' } });
    expect(onChange).toHaveBeenCalledWith({ project: 'OPS' });
  });

  it('flags a missing required field as invalid via validate()', () => {
    const errors = ToolConfigForm.validate(SAMPLE, { max_results: 10 });
    expect(errors).toContain('project');
    expect(errors).not.toContain('max_results');
  });

  it('reports no errors when all required fields are present', () => {
    const errors = ToolConfigForm.validate(SAMPLE, { project: 'OPS' });
    expect(errors).toEqual([]);
  });

  it('treats a {{ }} template as a satisfied required field', () => {
    const errors = ToolConfigForm.validate(SAMPLE, { project: '{{ trigger.key }}' });
    expect(errors).toEqual([]);
  });
});

describe('ToolConfigForm (freeform mode)', () => {
  it('renders a JSON textarea when no parameters are declared', () => {
    render(<ToolConfigForm parameters={[]} args={{ foo: 'bar' }} onChange={() => {}} freeform />);
    const ta = screen.getByLabelText(/raw json args/i) as HTMLTextAreaElement;
    expect(ta.tagName).toBe('TEXTAREA');
    expect(ta.value).toContain('"foo": "bar"');
  });

  it('emits parsed object on valid JSON edit', () => {
    const onChange = vi.fn();
    render(<ToolConfigForm parameters={[]} args={{}} onChange={onChange} freeform />);
    const ta = screen.getByLabelText(/raw json args/i);
    fireEvent.change(ta, { target: { value: '{"a":1}' } });
    expect(onChange).toHaveBeenLastCalledWith({ a: 1 });
  });

  it('does not emit on invalid JSON but shows an error', () => {
    const onChange = vi.fn();
    render(<ToolConfigForm parameters={[]} args={{}} onChange={onChange} freeform />);
    const ta = screen.getByLabelText(/raw json args/i);
    fireEvent.change(ta, { target: { value: '{ not json' } });
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByText(/invalid json/i)).toBeInTheDocument();
  });
});
