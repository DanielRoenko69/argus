import { create } from 'zustand';

interface ChatState {
  activeAgentId?: number;
  activeSessionId?: string;
  streaming: boolean;
  theme: 'light' | 'dark';
  sessionUsage: { prompt: number; completion: number; total: number; cost: number };
  params: { temperature?: number; max_tokens?: number; top_p?: number };
  setAgent: (id: number) => void;
  setSession: (sid?: string) => void;
  setStreaming: (s: boolean) => void;
  toggleTheme: () => void;
  addUsage: (u: { prompt: number; completion: number; total: number; cost: number }) => void;
  resetUsage: () => void;
  setParam: (key: 'temperature' | 'max_tokens' | 'top_p', value: number | undefined) => void;
  resetParams: () => void;
}

export const useChatStore = create<ChatState>((set) => ({
  streaming: false,
  theme: (localStorage.getItem('argus-theme') as 'light' | 'dark') ?? 'dark',
  sessionUsage: { prompt: 0, completion: 0, total: 0, cost: 0 },
  params: {},
  setAgent: (id) => set({ activeAgentId: id, activeSessionId: undefined }),
  setSession: (sid) => set({ activeSessionId: sid }),
  setStreaming: (s) => set({ streaming: s }),
  toggleTheme: () =>
    set((st) => {
      const t = st.theme === 'dark' ? 'light' : 'dark';
      localStorage.setItem('argus-theme', t);
      document.documentElement.classList.toggle('dark', t === 'dark');
      return { theme: t };
    }),
  addUsage: (u) =>
    set((st) => ({
      sessionUsage: {
        prompt: st.sessionUsage.prompt + u.prompt,
        completion: st.sessionUsage.completion + u.completion,
        total: st.sessionUsage.total + u.total,
        cost: st.sessionUsage.cost + u.cost,
      },
    })),
  resetUsage: () => set({ sessionUsage: { prompt: 0, completion: 0, total: 0, cost: 0 } }),
  setParam: (key, value) =>
    set((st) => {
      const next = { ...st.params };
      if (value === undefined) delete next[key];
      else next[key] = value;
      return { params: next };
    }),
  resetParams: () => set({ params: {} }),
}));
