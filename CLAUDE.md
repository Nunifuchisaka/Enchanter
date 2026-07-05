# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Enchanter is a self-hosted, single-user task/time-tracking tool (Todo管理 + 作業時間計測). It's a vanilla JS SPA (no build step, no frameworks, no dependencies) backed by a tiny dependency-free Node HTTP server that persists everything to a single JSON file.

## Commands

- Run the server: `node server.js` (or double-click `start.cmd` on Windows, which also opens the browser)
- Run via Docker: `docker compose up -d`
- No build step, no bundler, no test suite, no linter — `app.js`/`style.css`/`index.html` are served as-is.
- Default port `8787`; override with `PORT` env var. Data directory defaults to `./data`; override with `DATA_DIR` env var.
- The app **must** be accessed via the server (`http://localhost:8787`); opening `index.html` directly (`file://`) does not work since saving requires the HTTP API, and `app.js` explicitly detects and blocks this case.

## Architecture

Four files make up the whole app, each with exactly one job:

- `server.js` — `http` server with no framework. Serves the three static files (`index.html`, `style.css`, `app.js`) from fixed routes, and exposes `GET /api/data` / `PUT /api/data` for the entire dataset as one JSON blob. Writes are atomic (write to `.tmp`, then `fs.renameSync`) so a crash mid-write can't corrupt data.
- `app.js` — the entire client app: state, mutations, rendering, and event handling, in that order (see section markers like `/* ---------- rendering ---------- */`). No modules/bundler; everything is top-level functions and a couple of module-scoped objects.
- `style.css` — light/dark theme via `prefers-color-scheme`, no preprocessor.
- `index.html` — skeleton only; `<main id="view">` is the sole render target, tab buttons live in the header.

### Client state shape

Two module-level globals in `app.js` hold everything:
- `data` — the persisted domain model: `{ clients[], projects[], tasks[], entries[] }`. Mirrors `data/enchanter-data.json` exactly (see `README.md` for the schema). `entries` with `end: null` represent an in-progress timer; multiple tasks can be timed concurrently.
- `ui` — transient view state (active tab, date ranges for timeline/gantt/report, which item is currently being edited, etc.). Never persisted.

### Render/mutate/save cycle

There is no diffing or virtual DOM. The pattern used throughout is:
1. A mutation function changes `data` or `ui` directly (e.g. `startTimer`, `deleteTask`).
2. It calls `save()`, which serializes all of `data` and `PUT`s it to `/api/data`. Saves are chained through a single promise (`saveChain`) so rapid-fire edits can't race and reorder on the server.
3. It calls `renderAll()`, which re-renders the active tab's markup wholesale into `#view` via template-literal HTML strings (see `render*` functions, one per tab: `renderTodo`, `renderTimeline`, `renderGantt`, `renderReport`, `renderManage`).

### Event handling

All interactive elements are wired through **one delegated listener per DOM event type** at the bottom of `app.js` (`/* ---------- events ---------- */`), not per-element handlers:
- `click` → dispatches on `[data-action]` / `el.dataset.action` via a big `switch`.
- `change` and `submit` → separate delegated listeners, same `data-action`/`data-*` attribute convention.

When adding a new interactive control, follow this convention: add a `data-action="..."` (and `data-id`/other `data-*` as needed) attribute in the template string, then add a `case` to the matching delegated listener rather than attaching a new listener.

### Tabs

Each tab (`todo`, `timeline`, `gantt`, `report`, `manage`) is an independent `render*` function producing a full HTML string for `#view`; switching tabs just changes `ui.tab` and calls `renderAll()`. There's no routing/history integration — tab state resets to `todo` on reload.

### Editing pattern

Inline edit forms (not modals) are toggled by setting `ui.editingTask`/`ui.editingEntry`/`ui.editingClient`/`ui.editingProject` to an id (or `null`); the relevant `render*` function checks this and swaps a row for a form. `clearEditing()` resets all four before entering a new edit state, so only one thing is ever being edited at a time across the whole app.

### Legacy migration

`app.js` still contains one-time migration logic (`migrateFromLocalStorage`) for an older version of the app that stored data in browser `localStorage` (`enchanter-data-v1`). It runs once at `init()`, only if the server-side file is empty, and gates itself with a `localStorage` flag afterward — don't remove this without checking whether users still rely on the migration path.
