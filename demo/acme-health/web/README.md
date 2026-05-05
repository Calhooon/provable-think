# acme-health-web

Vite + React + TypeScript + Tailwind v4 frontend for the Acme Health Three-Pane Theater demo (Phase 2.6 of `provable-think`). Brand and stack decisions live in [`../DECISIONS.md`](../DECISIONS.md) — read that first.

## Run

```bash
npm install
npm run dev      # http://localhost:5173
```

## Build

```bash
npm run build    # tsc + vite build → dist/
npm run preview  # serve dist/ locally
npm run typecheck
```

## Deploy (Cloudflare Pages)

Export a Cloudflare API token from `provable-think/your local credentials file`, then:

```bash
export CLOUDFLARE_API_TOKEN=...      # from ../../your local credentials file
npm run build
wrangler pages deploy dist --project-name acme-health-demo
```

Target URL: `https://acme-health.dev-a3e.workers.dev`.

## Status

Phase 2.6 / Phase B scaffolding only. No agent-network wiring yet — the Zustand store is wired with no producers; Phase C connects it to the WebSocket worker in `../agent/`.
