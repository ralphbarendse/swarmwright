# Phase 5 — Frontend plan

Handoff doc for the next round. Backend is done; this document captures what
to build on top of it without re-deriving from the spec.

## State right now

- Backend: `app/api/settings.py` is wired and tested (196 tests passing).
- Frontend: `app/static/js/views/settings.js` is a 4-line empty-state stub.
- Spec source of truth: `docs/PHASE_5_SETTINGS.md` (sections 1–5).
- All Phase-3 frontend conventions still apply: vanilla JS, no build step,
  hash router (`#settings/<tab>`), API calls via `app/static/js/api.js`,
  toasts via `app/static/js/components/toast.js`, modals via `_showModal`
  exported from `app/static/js/views/org-design.js`.

## API endpoints to consume

All under `/api/v1/settings`:

| Method | Path                        | Used for                                |
|--------|-----------------------------|-----------------------------------------|
| GET    | `/`                         | initial load, masked secrets            |
| GET    | `/<key>`                    | refresh single value after edit         |
| PUT    | `/<key>`                    | save one field                          |
| PUT    | `/`                         | bulk save (Branding tab uses this)      |
| GET    | `/audit?key=&limit=`        | audit log viewer (Security tab)         |
| POST   | `/llm/test`                 | "Test connection" button                |
| POST   | `/branding/logo`            | logo upload (multipart)                 |
| POST   | `/security/rotate-key`      | rotation modal final step               |

Key naming follows dotted namespace: `llm.anthropic.api_key`,
`branding.color_primary`, `system.scheduler_timezone`, etc. See
`docs/PHASE_5_SETTINGS.md:56-72` for the canonical list.

## Build order (two rounds)

### Round A — Shell + Providers + Models + System tabs

1. **Shell**: replace `views/settings.js` with a 5-tab layout. Sub-routing
   via `#settings/<tab>` (providers, models, branding, system, security).
   Default to `providers`. Tab order matters — providers first, security last
   (per spec: "providers come first because nothing works without credentials").
2. **api.js extensions**: add typed wrappers (`listSettings`, `getSetting`,
   `putSetting`, `bulkPutSettings`, `getSettingsAudit`, `testLlmConnection`,
   `uploadLogo`, `rotateMasterKey`).
3. **Providers tab**: stacked cards per provider. Status dot, masked key
   display, Edit reveal, Test connection, Set-as-default radio. Spec shape
   in `docs/PHASE_5_SETTINGS.md:121-128`.
4. **Models tab**: table with Display name / Model id / Provider / Default /
   Actions. Add-model modal. Removing a model that agents reference must show
   the affected-agents warning (spec line 167) — needs an `/agents` lookup.
5. **System tab**: single-column form. Scheduler timezone, log level, default
   skill timeout, default heartbeat schedule, allowed packages (chip input).
   Flag restart-required fields with a "Requires restart" pill.

### Round B — Branding + Security

6. **Branding tab**: two-column layout (form left, live preview right).
   Color pickers update CSS custom properties (`--color-primary`,
   `--color-accent`) on `document.documentElement` immediately — bulk save
   on commit. Logo upload box. Reset-to-defaults button.
7. **CSS variables**: add `--color-primary` and `--color-accent` to
   `app/static/css/tokens.css` and replace hardcoded brand colors in
   `main.css` / `canvas.css` so the branding tab can hot-swap them.
8. **Security tab**: encryption-key card (shows fingerprint from
   `security.encryption_key_id`), audit-log retention field, API-access
   placeholder ("Not configured — local-only access"), Rotate-key button
   that opens a 5-step deliberately-friction-heavy modal
   (spec lines 257-265).
9. **Audit log viewer**: table reading `GET /audit`. Show `key`, `actor`,
   `reason`, `changed_at`, the truncated hashes. Filter by key.

## Constraints to respect

- **No build step.** ES modules served by Flask. CodeMirror and Cytoscape
  via CDN, already loaded in `index.html`.
- **No new frontend deps.** No React, no state libraries.
- **Frontend is a thin client.** All validation also lives server-side; UI
  validation is courtesy only.
- **Sensitive values never leave the server in plaintext.** GET responses
  show masked secrets; the only place the master key appears in plaintext
  is the one-time return value of `/security/rotate-key` step 3.
- **Cache the settings response on app load** and refresh after known
  mutations only (spec line 282).
- **Restart-required fields** show a pill plus a banner after save:
  "Restart required for one or more recent changes to take effect."

## Acceptance items still open (from `docs/PHASE_5_SETTINGS.md:299-310`)

These are the ones that need GUI work to satisfy:

- [ ] Settings screen has five tabs in the documented order
- [ ] Removing a model that agents reference shows a warning listing affected agents
- [ ] Changing primary or accent colors updates the entire app within one second, no reload
- [ ] Adding a package to the allowlist verifies whether it's actually installed in the container
- [ ] Settings flagged "Requires restart" show the banner after save

The "package-installed verifier" probably needs a small new backend endpoint
(`GET /api/v1/settings/system/packages/check?name=<pkg>`) that runs
`importlib.util.find_spec(name)` and returns `{installed: bool}`. Add this
when we get to the System tab.

## Files to touch

Create:
- (none — everything below is a modify)

Modify:
- `app/static/js/views/settings.js` — replace stub
- `app/static/js/api.js` — add typed wrappers
- `app/static/css/tokens.css` — add brand color custom properties
- `app/static/css/main.css` — replace hardcoded brand colors with custom-property references
- `app/static/css/canvas.css` — same
- `app/static/index.html` — verify topbar wiring (settings tab already exists per Phase 3 log)
- `docs/logphase5.md` — append entries as we ship each round

Maybe modify:
- `app/api/settings.py` — add `system/packages/check` endpoint
- `tests/test_settings.py` — cover the package-check endpoint

## What to skip

Per spec lines 287-294, do NOT build:
- Authentication (separate phase)
- Multi-tenancy
- Per-user preferences
- Email/SMTP config UI
- Backup/restore UI
- Per-skill sandbox config

## Quick-start when picking this up

1. `python3 -m pytest -q` — confirm 196 still pass.
2. Read this file + `docs/PHASE_5_SETTINGS.md` sections 1–5 + the existing
   `app/static/js/views/library.js` (closest analogue: form-heavy view with
   scoped sidebar) for current frontend conventions.
3. Start with Round A, shell first.
