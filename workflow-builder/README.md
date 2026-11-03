# Argus Visual Workflow Builder

Visual workflow editor for Argus, served at `/workflows/builder/:id`.

UI/UX derived from [Sim Studio](https://github.com/simstudioai/sim) (Apache 2.0).
See `NOTICE` for details. Re-wired against the Argus backend (PostgreSQL +
Express + `src/workflows/executor.ts`).

## Stack
- React 19 + TypeScript
- Vite 6 (builds to `../dist/builder/`)
- React Flow 11 — canvas + nodes
- Zustand 5 — UI state
- TanStack Query 5 — server state
- Tailwind 3 + Radix UI — design system (ported from Sim)
- react-router-dom 7 — client routing

## Dev

```bash
cd workflow-builder
npm install
npm run dev          # http://localhost:5174 — proxies /api → localhost:3000
```

## Build

```bash
npm run build        # outputs to ../dist/builder/
```

Argus Express serves the built bundle at `/workflows/builder/*` automatically.

## Structure

| Path | Purpose |
|------|---------|
| `src/canvas/`    | React Flow canvas + top bar |
| `src/sidebar/`   | Block palette (drag source) |
| `src/nodes/`     | Custom node types per Argus primitive |
| `src/stores/`    | Zustand stores |
| `src/ui/`        | shadcn-style primitives (Button, Dialog, ...) |
| `src/api/`       | HTTP client for Argus backend |
| `src/lib/`       | utilities (`cn()`, formatters) |
