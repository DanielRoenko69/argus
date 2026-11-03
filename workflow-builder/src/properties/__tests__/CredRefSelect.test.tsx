import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

vi.mock('@/api/bundles', () => ({
  useAccessibleBundles: () => ({
    data: [
      { id: 7, name: 'k8s-ops' },
      { id: 9, name: 'jira-team' },
    ],
    isLoading: false,
  }),
}));

import { CredRefSelect } from '../CredRefSelect';

describe('CredRefSelect', () => {
  it('defaults to the credential stored on the selected Fabric connection', () => {
    render(<CredRefSelect value={undefined} onChange={() => {}} />);
    const sel = screen.getByRole('combobox') as HTMLSelectElement;
    expect(sel.value).toBe('');
    expect(screen.getByText('Use credential stored on the Fabric connection')).toBeInTheDocument();
  });

  it('stores only { bundle_id } when a bundle is picked', () => {
    const onChange = vi.fn();
    render(<CredRefSelect value={undefined} onChange={onChange} />);
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '7' } });
    expect(onChange).toHaveBeenCalledWith({ bundle_id: 7 });
  });

  it('emits undefined when reset to the default', () => {
    const onChange = vi.fn();
    render(<CredRefSelect value={{ bundle_id: 9 }} onChange={onChange} />);
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '' } });
    expect(onChange).toHaveBeenCalledWith(undefined);
  });
});
