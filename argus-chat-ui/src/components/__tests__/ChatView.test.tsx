import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { SseEvent } from '../../data-provider/sse.js';
import type { AgentSummary, Session } from '../../data-provider/types.js';

/* ── Mocks must be defined at module scope before imports ── */

const mockAgents: AgentSummary[] = [
  { id: 1, name: 'k8s-agent', label: 'K8s Agent', description: 'Kubernetes operations', model: 'gpt-4o', supports_vision: true },
  { id: 2, name: 'ops-agent', label: 'Ops Agent', description: 'General ops', model: 'gemini' },
];

/* Synchronous FileReader stub for the image-upload test (readAsDataURL → onload). */
class MockFileReader {
  result: string | ArrayBuffer | null = null;
  onload: null | (() => void) = null;
  readAsDataURL(_file: Blob) {
    this.result = 'data:image/png;base64,QUJD';
    this.onload?.();
  }
}

const mockSession: Session = {
  id: 'sess-001',
  agent_id: 1,
  user_id: null,
  messages: [],
  created_at: new Date().toISOString(),
  last_active: new Date().toISOString(),
};

// Mutable: lets a test simulate the post-create useSession fetch resolving with
// the new (empty) session — the race that clobbered optimistic messages.
let mockSessionData: Session | undefined = undefined;

// Track the streamChat onEvent callback so tests can drive it
let capturedOnEvent: ((e: SseEvent) => void) | null = null;
let capturedSignal: AbortSignal | null = null;
let streamResolve: (() => void) | null = null;

// Hoisted spy so tests can assert the variant switcher calls setActiveLeaf with the right sibling.
const { mockSetActiveLeaf } = vi.hoisted(() => ({ mockSetActiveLeaf: vi.fn() }));

vi.mock('../../data-provider/hooks.js', () => ({
  useAgents: () => ({ data: mockAgents, isLoading: false }),
  useMe: () => ({ data: { user: { id: 1, username: 'u', display_name: 'U', role: 'admin' }, shareLinksEnabled: false } }),
  useCreateSession: (_id: number) => ({
    mutateAsync: vi.fn().mockResolvedValue(mockSession),
  }),
  useSessions: (_id?: number) => ({ data: [] }),
  useSession: (_id?: number, _sid?: string) => ({ data: mockSessionData }),
  useDeleteSession: (_id: number) => ({
    mutateAsync: vi.fn().mockResolvedValue({ deleted: true }),
  }),
  useSetActiveLeaf: (_id: number, _sid: string) => ({ mutateAsync: mockSetActiveLeaf }),
}));

vi.mock('../../data-provider/sse.js', () => ({
  streamChat: vi.fn(
    (
      _url: string,
      _body: unknown,
      onEvent: (e: SseEvent) => void,
      signal: AbortSignal,
    ): Promise<void> => {
      capturedOnEvent = onEvent;
      capturedSignal = signal;
      return new Promise<void>((resolve) => {
        streamResolve = resolve;
      });
    },
  ),
}));

// Mock Markdown to avoid heavy rendering in tests
vi.mock('../../render/Markdown.js', () => ({
  Markdown: ({ content }: { content: string }) => <span data-testid="markdown">{content}</span>,
}));

// Reset zustand store between tests
import { useChatStore } from '../../store/chat.js';

/* ── Component under test (imported AFTER mocks) ── */
import { ChatView } from '../ChatView.js';

function makeQc() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function Wrapper({ children }: { children: React.ReactNode }) {
  return (
    <QueryClientProvider client={makeQc()}>
      {children}
    </QueryClientProvider>
  );
}

describe('ChatView', () => {
  beforeEach(() => {
    // Reset store state
    useChatStore.setState({
      activeAgentId: undefined,
      activeSessionId: undefined,
      streaming: false,
      theme: 'dark',
      sessionUsage: { prompt: 0, completion: 0, total: 0, cost: 0 },
      params: {},
    });
    capturedOnEvent = null;
    capturedSignal = null;
    streamResolve = null;
    mockSessionData = undefined;
    // Ensure dark class is set
    document.documentElement.classList.add('dark');
    vi.stubGlobal('FileReader', MockFileReader as unknown as typeof FileReader);
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it('renders the chat header and agent picker', () => {
    render(
      <Wrapper>
        <ChatView />
      </Wrapper>,
    );
    // 'Argus Chat' appears in both the header title and the empty-state title
    const instances = screen.getAllByText('Argus Chat');
    expect(instances.length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('K8s Agent')).toBeInTheDocument();
    expect(screen.getByText('Ops Agent')).toBeInTheDocument();
    expect(screen.getByRole('note', { name: 'AI interaction notice' })).toHaveTextContent('You are interacting with an AI agent');
  });

  it('selects an agent when clicking an agent chip', async () => {
    render(
      <Wrapper>
        <ChatView />
      </Wrapper>,
    );

    const chip = screen.getByText('K8s Agent');
    fireEvent.click(chip);

    await waitFor(() => {
      expect(useChatStore.getState().activeAgentId).toBe(1);
    });
  });

  it('does not activate an inaccessible agent from a stale deep link', async () => {
    window.history.pushState({}, '', '/chat/999');
    try {
      render(
        <Wrapper>
          <ChatView />
        </Wrapper>,
      );

      await waitFor(() => expect(useChatStore.getState().activeAgentId).toBeUndefined());
      expect(screen.getByRole('button', { name: /choose an agent/i })).toHaveAttribute('aria-expanded', 'true');
    } finally {
      window.history.replaceState({}, '', '/');
    }
  });

  it('keeps chat history closed on narrow screens until opened', () => {
    const originalWidth = window.innerWidth;
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 640 });

    try {
      render(
        <Wrapper>
          <ChatView />
        </Wrapper>,
      );

      const history = screen.getByRole('complementary', { name: 'Chat history' });
      expect(history).not.toHaveClass('is-open');

      fireEvent.click(screen.getByRole('button', { name: 'Open chat history' }));
      expect(history).toHaveClass('is-open');

      fireEvent.click(within(history).getByRole('button', { name: 'Close chat history' }));
      expect(history).not.toHaveClass('is-open');
    } finally {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: originalWidth });
    }
  });

  it('enables the Send button only after selecting an agent and typing', async () => {
    render(
      <Wrapper>
        <ChatView />
      </Wrapper>,
    );

    const textarea = screen.getByRole('textbox', { name: /message input/i });
    const sendBtn = screen.getByRole('button', { name: /send message/i });

    // No agent selected — button disabled
    expect(sendBtn).toBeDisabled();

    // Select agent
    fireEvent.click(screen.getByText('K8s Agent'));

    // Still disabled (empty text)
    await waitFor(() => expect(sendBtn).toBeDisabled());

    // Type something
    fireEvent.change(textarea, { target: { value: 'Hello agent' } });
    expect(sendBtn).not.toBeDisabled();
  });

  it('shows user message, shows Stop during streaming, shows assistant delta text, Stop disappears after done', async () => {
    render(
      <Wrapper>
        <ChatView />
      </Wrapper>,
    );

    // Select agent
    fireEvent.click(screen.getByText('K8s Agent'));

    // Type and send
    const textarea = screen.getByRole('textbox', { name: /message input/i });
    fireEvent.change(textarea, { target: { value: 'Hello agent' } });

    const sendBtn = screen.getByRole('button', { name: /send message/i });
    await act(async () => {
      fireEvent.click(sendBtn);
    });

    // User message should appear
    await waitFor(() => {
      expect(screen.getByText('Hello agent')).toBeInTheDocument();
    });

    // Stop button should be visible while streaming
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /stop generation/i })).toBeInTheDocument();
    });

    // Emit delta events
    await act(async () => {
      capturedOnEvent!({ type: 'delta', text: 'Hello ' });
      capturedOnEvent!({ type: 'delta', text: 'from Argus' });
    });

    // Assistant bubble should contain concatenated delta text
    await waitFor(() => {
      const md = screen.getAllByTestId('markdown');
      const assistantBubble = md.find((el) => el.textContent === 'Hello from Argus');
      expect(assistantBubble).toBeTruthy();
    });

    // Emit done — resolve the stream promise
    await act(async () => {
      capturedOnEvent!({ type: 'done' });
      streamResolve!();
    });

    // Stop button should disappear after streaming ends
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /stop generation/i })).not.toBeInTheDocument();
    });

    // Send button should reappear
    expect(screen.getByRole('button', { name: /send message/i })).toBeInTheDocument();
  });

  it('new-session hydration does NOT clobber the just-sent optimistic/streamed messages (regression)', async () => {
    // Simulate the real race: after send() creates a session, useSession resolves
    // with the new (empty) session. The hydration effect must NOT overwrite the
    // optimistic user message + streamed assistant text.
    mockSessionData = { ...mockSession, messages: [] };
    render(
      <Wrapper>
        <ChatView />
      </Wrapper>,
    );
    fireEvent.click(screen.getByText('K8s Agent'));
    const textarea = screen.getByRole('textbox', { name: /message input/i });
    fireEvent.change(textarea, { target: { value: 'Hallo' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /send message/i }));
    });
    await act(async () => {
      capturedOnEvent!({ type: 'delta', text: 'Hi there' });
      capturedOnEvent!({ type: 'done' });
      streamResolve!();
    });
    // Both the user message and the streamed assistant text must survive.
    expect(screen.getByText('Hallo')).toBeInTheDocument();
    await waitFor(() => {
      const md = screen.getAllByTestId('markdown');
      expect(md.some((el) => el.textContent === 'Hi there')).toBe(true);
    });
  });

  it('Stop button aborts the stream', async () => {
    render(
      <Wrapper>
        <ChatView />
      </Wrapper>,
    );

    fireEvent.click(screen.getByText('K8s Agent'));
    const textarea = screen.getByRole('textbox', { name: /message input/i });
    fireEvent.change(textarea, { target: { value: 'Test abort' } });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /send message/i }));
    });

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /stop generation/i })).toBeInTheDocument();
    });

    // Click Stop
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /stop generation/i }));
    });

    // Streaming should be false
    await waitFor(() => {
      expect(useChatStore.getState().streaming).toBe(false);
    });

    // Signal should have been aborted
    expect(capturedSignal?.aborted).toBe(true);
  });

  it('renders tool_call and tool_result steps in collapsible details', async () => {
    render(
      <Wrapper>
        <ChatView />
      </Wrapper>,
    );

    fireEvent.click(screen.getByText('K8s Agent'));
    const textarea = screen.getByRole('textbox', { name: /message input/i });
    fireEvent.change(textarea, { target: { value: 'List pods' } });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /send message/i }));
    });

    await act(async () => {
      capturedOnEvent!({ type: 'tool_call', name: 'k8s_list_pods', args: { namespace: 'default' } });
      capturedOnEvent!({ type: 'tool_result', name: 'k8s_list_pods', preview: 'pod-1, pod-2' });
      capturedOnEvent!({ type: 'delta', text: 'I found 2 pods.' });
      capturedOnEvent!({ type: 'done' });
      streamResolve!();
    });

    // k8s_list_pods appears twice: once for call step, once for result step
    await waitFor(() => {
      const steps = screen.getAllByText('k8s_list_pods');
      expect(steps.length).toBe(2);
    });
  });

  it('Enter key submits the message', async () => {
    render(
      <Wrapper>
        <ChatView />
      </Wrapper>,
    );

    fireEvent.click(screen.getByText('K8s Agent'));
    const textarea = screen.getByRole('textbox', { name: /message input/i });
    fireEvent.change(textarea, { target: { value: 'Enter test' } });

    await act(async () => {
      fireEvent.keyDown(textarea, { key: 'Enter', code: 'Enter', shiftKey: false });
    });

    await waitFor(() => {
      expect(screen.getByText('Enter test')).toBeInTheDocument();
    });
  });

  it('Shift+Enter does not submit', async () => {
    const { streamChat: mockStreamChat } = await import('../../data-provider/sse.js');

    render(
      <Wrapper>
        <ChatView />
      </Wrapper>,
    );

    fireEvent.click(screen.getByText('K8s Agent'));
    const textarea = screen.getByRole('textbox', { name: /message input/i });
    fireEvent.change(textarea, { target: { value: 'Shift enter' } });

    fireEvent.keyDown(textarea, { key: 'Enter', code: 'Enter', shiftKey: true });

    // streamChat should NOT have been called (no send triggered)
    expect(mockStreamChat).not.toHaveBeenCalled();
    // The textarea still contains the text (not cleared by a send)
    expect(textarea).toHaveValue('Shift enter');
    // No "You" role label means no user message was appended to the list
    expect(screen.queryByText('You')).not.toBeInTheDocument();
  });

  it('theme toggle button switches theme', async () => {
    render(
      <Wrapper>
        <ChatView />
      </Wrapper>,
    );

    // Initial theme is dark (set in beforeEach)
    const toggleBtn = screen.getByRole('button', { name: /toggle light\/dark theme/i });
    expect(toggleBtn.textContent).toContain('Light');

    fireEvent.click(toggleBtn);

    await waitFor(() => {
      expect(useChatStore.getState().theme).toBe('light');
    });

    expect(screen.getByRole('button', { name: /toggle light\/dark theme/i }).textContent).toContain('Dark');
  });

  it('vision agent: uploading an image threads attachments to streamChat and renders a thumbnail', async () => {
    const { streamChat: mockStreamChat } = await import('../../data-provider/sse.js');
    const { container } = render(
      <Wrapper>
        <ChatView />
      </Wrapper>,
    );

    // K8s Agent (id 1) has supports_vision: true → attach button enabled
    fireEvent.click(screen.getByText('K8s Agent'));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /attach file/i })).not.toBeDisabled(),
    );

    // Upload via the hidden file input
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(['x'], 'pic.png', { type: 'image/png' });
    await act(async () => {
      fireEvent.change(input, { target: { files: [file] } });
    });

    // Type + send
    fireEvent.change(screen.getByRole('textbox', { name: /message input/i }), { target: { value: 'Was siehst du?' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /send message/i }));
    });

    // streamChat body carries the attachment
    await waitFor(() => expect(mockStreamChat).toHaveBeenCalled());
    const body = vi.mocked(mockStreamChat).mock.calls[0][1] as { message: string; attachments?: unknown };
    expect(body.attachments).toEqual([{ name: 'pic.png', dataUrl: 'data:image/png;base64,QUJD' }]);

    // User bubble renders the thumbnail
    expect(screen.getByAltText('pic.png')).toBeInTheDocument();
  });

  it('non-vision agent: file attachment remains available', () => {
    render(
      <Wrapper>
        <ChatView />
      </Wrapper>,
    );
    fireEvent.click(screen.getByText('Ops Agent')); // id 2, no supports_vision
    expect(screen.getByRole('button', { name: /attach file/i })).not.toBeDisabled();
  });

  it('shows per-turn + session token/cost meter from a usage event, resets on New chat', async () => {
    render(<Wrapper><ChatView /></Wrapper>);
    fireEvent.click(screen.getByText('K8s Agent'));
    fireEvent.change(screen.getByRole('textbox', { name: /message input/i }), { target: { value: 'hi' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /send message/i })); });
    await act(async () => {
      capturedOnEvent!({ type: 'delta', text: 'Hi' });
      capturedOnEvent!({ type: 'usage', prompt: 1000, completion: 500, total: 1500, cost: 0.0125, model: 'gpt-4o' });
      capturedOnEvent!({ type: 'done' }); streamResolve!();
    });
    // Per-turn meter on the assistant bubble
    await waitFor(() => expect(screen.getAllByText(/1\.5k tok/).length).toBeGreaterThan(0));
    // Session total meter in the header (Σ prefix)
    await waitFor(() => expect(screen.getByText(/Σ/)).toBeInTheDocument());
    // Store updated
    expect(useChatStore.getState().sessionUsage.total).toBe(1500);
    // New chat resets the session meter
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /new/i })); });
    await waitFor(() => expect(screen.queryByText(/Σ/)).not.toBeInTheDocument());
    expect(useChatStore.getState().sessionUsage.total).toBe(0);
  });

  it('threads set params into the streamChat body; omits them when unset', async () => {
    const { streamChat: mockStreamChat } = await import('../../data-provider/sse.js');
    render(<Wrapper><ChatView /></Wrapper>);
    fireEvent.click(screen.getByText('K8s Agent'));

    // No params set → body.params omitted
    fireEvent.change(screen.getByRole('textbox', { name: /message input/i }), { target: { value: 'hi' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /send message/i })); });
    let body = vi.mocked(mockStreamChat).mock.calls[0][1] as { params?: unknown };
    expect(body.params).toBeUndefined();

    // Set a param → next send carries it
    await act(async () => { capturedOnEvent!({ type: 'done' }); streamResolve!(); });
    useChatStore.getState().setParam('max_tokens', 12);
    fireEvent.change(screen.getByRole('textbox', { name: /message input/i }), { target: { value: 'again' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /send message/i })); });
    body = vi.mocked(mockStreamChat).mock.calls[1][1] as { params?: { max_tokens?: number } };
    expect(body.params).toEqual({ max_tokens: 12 });
  });

  it('hydrates the active branch from a branched session and shows the variant indicator', async () => {
    mockSessionData = {
      ...mockSession,
      active_leaf_id: 'a2',
      messages: [
        { role: 'user', content: 'hi', id: 'u', parentId: null },
        { role: 'assistant', content: 'one', id: 'a1', parentId: 'u' },
        { role: 'assistant', content: 'two', id: 'a2', parentId: 'u' },
      ],
    } as any;

    render(<Wrapper><ChatView /></Wrapper>);

    // Select K8s Agent and then set the active session in the store so
    // useSession returns our branched data and the hydration effect fires.
    fireEvent.click(screen.getByText('K8s Agent'));
    await act(async () => {
      useChatStore.setState({ activeAgentId: 1, activeSessionId: 'sess-001' });
    });

    // The active path goes u → a2, so the assistant content shown is 'two' not 'one'
    await waitFor(() => {
      const md = screen.getAllByTestId('markdown');
      const active = md.find((el) => el.textContent === 'two');
      expect(active).toBeTruthy();
    });

    // The variant indicator shows 2/2 (a2 is the second of two siblings)
    await waitFor(() => {
      expect(screen.getByText(/2\/2/)).toBeInTheDocument();
    });

    // Clicking ‹ (previous variant) switches the active branch to the sibling a1.
    mockSetActiveLeaf.mockResolvedValue({ active_leaf_id: 'a1' });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /previous variant/i }));
    });
    expect(mockSetActiveLeaf).toHaveBeenCalledWith('a1');
  });

  it('renders persisted RAG citations from a hydrated assistant message', async () => {
    mockSessionData = {
      ...mockSession,
      active_leaf_id: 'a1',
      messages: [
        { role: 'user', content: 'why OOM?', id: 'u', parentId: null },
        { role: 'assistant', content: 'Because of memory limits.', id: 'a1', parentId: 'u',
          citations: [{ source: 'runbook.md', snippet: 'OOMKilled', score: 0.9, index: 'Ops-KB' }] },
      ],
    } as any;
    render(<Wrapper><ChatView /></Wrapper>);
    fireEvent.click(screen.getByText('K8s Agent'));
    await act(async () => { useChatStore.setState({ activeAgentId: 1, activeSessionId: 'sess-001' }); });
    await waitFor(() => expect(screen.getByText('Sources')).toBeInTheDocument());
    expect(screen.getByText('runbook.md')).toBeInTheDocument();
  });

  it('shows ✎ on a user message with an id and Save calls the edit endpoint', async () => {
    const { streamChat: mockStreamChat } = await import('../../data-provider/sse.js');
    mockSessionData = {
      ...mockSession,
      active_leaf_id: 'a1',
      messages: [
        { role: 'user', content: 'hi', id: 'u', parentId: null },
        { role: 'assistant', content: 'one', id: 'a1', parentId: 'u' },
      ],
    } as any;
    render(<Wrapper><ChatView /></Wrapper>);
    fireEvent.click(screen.getByText('K8s Agent'));
    await act(async () => { useChatStore.setState({ activeAgentId: 1, activeSessionId: 'sess-001' }); });
    const editBtn = await screen.findByRole('button', { name: /edit message/i });
    fireEvent.click(editBtn);
    const editor = screen.getByRole('textbox', { name: /edit message/i });
    fireEvent.change(editor, { target: { value: 'hi (edited)' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /save/i })); });
    // Optimistic rewind: the edited text replaces the branch (u was index 0 → sliced away),
    // and the old answer 'one' is gone from view.
    expect(screen.getByText('hi (edited)')).toBeInTheDocument();
    expect(screen.queryByText('one')).not.toBeInTheDocument();
    // …and the edit endpoint is hit with the edited text.
    await waitFor(() => expect(mockStreamChat).toHaveBeenCalled());
    const calls = vi.mocked(mockStreamChat).mock.calls;
    const [url, body] = calls[calls.length - 1];
    expect(String(url)).toMatch(/\/messages\/u\/edit$/);
    expect((body as { message?: string }).message).toBe('hi (edited)');
  });
});
