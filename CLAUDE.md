# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Enchanter is a self-hosted, single-user task/time-tracking tool (Todo管理 + 作業時間計測). It's a vanilla JS SPA (no build step, no frameworks, no dependencies) backed by a tiny dependency-free Node HTTP server that persists everything to a single JSON file.

## Commands

- Run the server: `node server.js` (or double-click `start.cmd` on Windows, which also opens the browser)
- Run via Docker: `docker compose up -d`
- No build step, no bundler, no test suite, no linter — `app.js`/`style.css`/`index.html` are served as-is.
- Default port `8787`; override with `PORT` env var. Data directory defaults to `./data`; override with `DATA_DIR` env var. Bind address defaults to `127.0.0.1` (loopback-only, since there's no auth); override with `HOST` env var to expose on the LAN.
- The app **must** be accessed via the server (`http://localhost:8787`); opening `index.html` directly (`file://`) does not work since saving requires the HTTP API, and `app.js` explicitly detects and blocks this case.

## Architecture

Four files make up the whole app, each with exactly one job:

- `server.js` — `http` server with no framework. Serves the three static files (`index.html`, `style.css`, `app.js`) from fixed routes, exposes `GET /api/data` / `PUT /api/data` for the entire dataset as one JSON blob, and hosts the Google Calendar OAuth/sync endpoints (see below). Writes are atomic (write to `.tmp`, then `fs.renameSync`) so a crash mid-write can't corrupt data.
- `app.js` — the entire client app: state, mutations, rendering, and event handling, in that order (see section markers like `/* ---------- rendering ---------- */`). No modules/bundler; everything is top-level functions and a couple of module-scoped objects.
- `style.css` — light/dark theme via `prefers-color-scheme`, no preprocessor.
- `index.html` — skeleton only; `<main id="view">` is the sole render target, tab buttons live in the header.

### No-auth security model

There's no login/session system — the trust boundary is "whoever can reach the port." Two mechanisms enforce that boundary and must be preserved when touching `server.js`/`app.js`:
- Any state-changing endpoint (`PUT /api/data`, `POST /api/google/disconnect`, `POST /api/calendar/sync-entry`) requires the `X-Requested-With: enchanter` header (checked via `requireCsrfHeader()`). This forces a CORS preflight on every request regardless of method; since the server never answers `OPTIONS` or sends `Access-Control-Allow-Origin`, a browser visiting a malicious page can't trigger these endpoints (drive-by CSRF). New mutating endpoints must call `requireCsrfHeader()`, and any new `fetch()` call to them in `app.js` must send that header.
- `PUT /api/data` (and `readData()` on load) runs the payload through `sanitizeData()`, which forces `project.color` to match `/^#[0-9a-fA-F]{6}$/`, `task.repeat` to one of `daily`/`weekly`/`monthly`/`null`, and `task.estimateMinutes` to a positive integer or `null` (`task.note` is coerced to string/`null` but otherwise passed through — it's always rendered via `esc()`). Fields like `color`/`estimateMinutes` are rendered unescaped into `style="background:..."` / `value="..."` attributes client-side, so a crafted API payload or hand-edited `data/enchanter-data.json` could otherwise break out of the attribute. Any new enum-like field rendered into an HTML attribute needs the same treatment (either server-side validation or `esc()` on the client).

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

Each tab (`todo`, `timeline`, `gantt`, `report`, `manage`) is an independent `render*` function producing a full HTML string for `#view`; switching tabs just changes `ui.tab` and calls `renderAll()`. Tab state (plus the active tab's dates/ranges) is mirrored into the URL hash (`#timeline?date=...`) by `buildHash()`, applied once at the end of `renderAll()` via `history.replaceState` — since every state change goes through `renderAll()`, no per-mutation hash updates are needed. `applyHash()` (called at `init()` and on `hashchange`) parses and validates the hash back into `ui`, so reload/bookmarks/back-forward restore the view.

### Editing pattern

Inline edit forms (not modals) are toggled by setting `ui.editingTask`/`ui.editingEntry`/`ui.editingClient`/`ui.editingProject` to an id (or `null`); the relevant `render*` function checks this and swaps a row for a form. `clearEditing()` resets all four before entering a new edit state, so only one thing is ever being edited at a time across the whole app.

### Legacy migration

`app.js` still contains one-time migration logic (`migrateFromLocalStorage`) for an older version of the app that stored data in browser `localStorage` (`enchanter-data-v1`). It runs once at `init()`, only if the server-side file is empty, and gates itself with a `localStorage` flag afterward — don't remove this without checking whether users still rely on the migration path.

### Google Calendar integration (optional)

Entirely contained in `server.js` (no npm packages — talks to Google's REST API directly via `fetch`); `app.js` only calls the `/api/google/*` and `/api/calendar/sync-entry` endpoints and never touches Google credentials directly. See `README.md`'s "Googleカレンダー連携" section for end-user setup steps.

- Config lives in `data/` (gitignored, never committed): `google-credentials.json` (user-supplied OAuth client id/secret from Google Cloud Console) and `google-token.json` (access/refresh token, written by the server). `google-sync-map.json` maps local `entryId` → Google event id so re-syncing an entry updates the existing event instead of duplicating it.
- OAuth is the "Desktop app" flow: `GET /api/google/auth-url` builds the consent URL (storing a random `state` in the in-memory `pendingOAuthState`), the browser is redirected to Google, and `GET /oauth/callback` exchanges the code for tokens after checking `state` matches. `getValidAccessToken()` transparently refreshes the access token using the refresh token when it's near expiry.
- `app.js`'s `syncEntryToGoogle()` calls `POST /api/calendar/sync-entry` whenever a time entry's `end` becomes non-null (timer stop, or manual entry add/edit) — see the "Render/mutate/save cycle" callers. This is fire-and-forget; failures are logged but never block the local save/render cycle.
- If `data/google-credentials.json` is absent, `ui.googleStatus.configured` is `false` and the feature is inert everywhere — no code path assumes Google is configured.
