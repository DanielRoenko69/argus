import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const mutateAsync = vi.fn();
const navigate = vi.fn();

vi.mock('@/api/workflows', () => ({
  useCreateWorkflow: () => ({ mutateAsync, isPending: false, isError: false, error: null }),
}));
vi.mock('react-router-dom', () => ({
  useNavigate: () => navigate,
}));

import { NewWorkflowButton } from '../canvas/NewWorkflowButton';

describe('NewWorkflowButton', () => {
  beforeEach(() => {
    mutateAsync.mockReset();
    navigate.mockReset();
  });

  it('renders a trigger labelled "Neuer Workflow"', () => {
    render(<NewWorkflowButton />);
    expect(screen.getByRole('button', { name: /neuer workflow/i })).toBeInTheDocument();
  });

  it('renders the variant="cta" trigger as a prominent button (for EmptyState)', () => {
    render(<NewWorkflowButton variant="cta" />);
    expect(screen.getByRole('button', { name: /neuer workflow/i })).toBeInTheDocument();
  });

  it('opens the modal on click and shows name + description fields', () => {
    render(<NewWorkflowButton />);
    fireEvent.click(screen.getByRole('button', { name: /neuer workflow/i }));
    expect(screen.getByLabelText(/name/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/beschreibung/i)).toBeInTheDocument();
  });

  it('slugifies the name (wf_name_format) and navigates to /:id on success', async () => {
    mutateAsync.mockResolvedValue({ id: 99, name: 'ops_wf', description: 'd', enabled: true });
    render(<NewWorkflowButton />);
    fireEvent.click(screen.getByRole('button', { name: /neuer workflow/i }));
    fireEvent.change(screen.getByLabelText(/name/i), { target: { value: 'Ops WF' } });
    fireEvent.change(screen.getByLabelText(/beschreibung/i), { target: { value: 'd' } });
    fireEvent.click(screen.getByRole('button', { name: /erstellen/i }));

    // "Ops WF" must be sent as the constraint-valid slug "ops_wf", not raw.
    await waitFor(() =>
      expect(mutateAsync).toHaveBeenCalledWith({ name: 'ops_wf', description: 'd' }),
    );
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/99'));
  });

  it('shows the slug preview and disables submit when the name has no usable chars', () => {
    render(<NewWorkflowButton />);
    fireEvent.click(screen.getByRole('button', { name: /neuer workflow/i }));
    fireEvent.change(screen.getByLabelText(/name/i), { target: { value: 'Coding Workflow' } });
    expect(screen.getByText(/coding_workflow/)).toBeInTheDocument();
    // a name with no letters/digits slugifies to '' → submit disabled
    fireEvent.change(screen.getByLabelText(/name/i), { target: { value: '###' } });
    expect(screen.getByRole('button', { name: /erstellen/i })).toBeDisabled();
  });

  it('disables the submit action when the name is empty', () => {
    render(<NewWorkflowButton />);
    fireEvent.click(screen.getByRole('button', { name: /neuer workflow/i }));
    const submit = screen.getByRole('button', { name: /erstellen/i });
    expect(submit).toBeDisabled();
  });
});
