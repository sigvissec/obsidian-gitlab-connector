# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository Structure

This is a monorepo containing Obsidian plugins. Currently contains one plugin:

- **obsidian-gitlab-connector** — Bi-directional markdown sync between an Obsidian vault and a GitLab repository, supporting both offline (isomorphic-git) and online (REST API) modes.

## Build Commands

All commands run from `obsidian-gitlab-connector/`:

```bash
npm run dev       # Watch mode with sourcemaps, rebuilds on file change
npm run build     # TypeScript type-check (tsc -noEmit) + esbuild production bundle
npm run version   # Version bump helper (updates manifest.json + versions.json)
```

Output is a single `main.js` bundle. No test framework is configured.

## Architecture: obsidian-gitlab-connector

**Entry point:** `src/main.ts` — extends Obsidian's `Plugin` class, registers commands (pull/push/sync/init), ribbon icon, settings tab. Uses lazy initialization (setup deferred until first command).

**Core sync flow:**
```
SyncEngine (src/sync/sync-engine.ts) — orchestrator
  ├─ SyncBackend (interface in sync-backend.ts)
  │   ├─ GitSyncBackend — isomorphic-git, clones into IndexedDB via LightningFS (never touches vault filesystem)
  │   └─ ApiSyncBackend — GitLab REST API v4, no local git repo
  ├─ StateManager — per-file sync state (hash, base content, remote SHA) persisted in data.json
  ├─ ChangeTracker — compares vault files + remote files against saved state to detect changes
  └─ ConflictDetector — three-way merge (jsdiff), escalates true conflicts to UI
```

**Key design patterns:**
- **Dual backend:** `SyncBackend` interface abstracts git vs. API; mode-specific state is stored independently so users can switch without conflicts
- **IndexedDB git storage:** Git repo lives in LightningFS (IndexedDB), invisible to Obsidian's file indexer
- **Three-way merge:** Base content stored in state enables automatic merge of non-overlapping changes; true conflicts show an interactive modal
- **File-change debouncing:** 5-second debounce on vault file changes before auto-push
- **Mobile support:** Buffer polyfill (`polyfill_buffer.js`) injected by esbuild for mobile WebView; platform-aware UI (status bar on desktop, Notices on mobile)

**Build system:** esbuild bundles to CommonJS/ES2018. Externals: `obsidian`, `electron`, `@codemirror/*`, `@lezer/*`. TypeScript strict mode enabled.

**Auth:** HTTPS-only with GitLab Personal Access Token (PAT) as password. No SSH support.
