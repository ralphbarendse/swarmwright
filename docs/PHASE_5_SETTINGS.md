# Phase 5 — Settings & Customization

> Goal: a single coherent place where users configure the system — credentials, models, scheduling, branding, and operational defaults. Settings span backend (storage, validation, encryption) and frontend (the UI). Both halves are specified here.

---

## What "done" looks like for Phase 5

You open the Settings screen and see five clearly separated sections: LLM Providers, Models, Branding, System, and Security. You can paste an Anthropic API key, click "Test connection," see a green check. You can choose which models are available across the swarm. You can upload a company logo and change the accent color, and the entire app updates without reload. You can rotate API keys, change the scheduler timezone, see system health information. Settings persist across container restarts. Sensitive values are encrypted at rest.

---

## Why settings deserve their own phase

Settings could in theory be sprinkled across Phase 1 (config), Phase 3 (UI), and Phase 4 (examples). They're separated out for three reasons:

**They're cross-cutting.** A change to "available models" affects every agent's frontmatter dropdown. A change to the brand palette affects every screen. Settings live above the rest of the system.

**They have unique storage requirements.** API keys must be encrypted at rest. Logos must be served as static assets but uploaded through the API. The `settings` table is the only place these concerns live.

**They're the most-edited surface by non-technical operators.** Once a swarm is running, the things that change most often are credentials (rotating keys), available models (when new ones release), and operational defaults. Treating settings as an afterthought makes the most-touched part of the system the worst-designed.

---

## Five settings sections

The settings UI organizes everything into five sections, each with a tab in the settings screen. The same five sections map to five logical groups in the database.

1. **LLM Providers** — API keys for Anthropic and OpenAI, and (later) other providers
2. **Models** — which specific models are available to agents, with display names and per-model defaults
3. **Branding** — logo, accent color, app name, optional dark mode override
4. **System** — scheduler timezone, log level, default skill timeout, default heartbeat schedule, allowed Python packages for skills
5. **Security** — encryption key rotation, API access (when auth is added), audit log retention

Section ordering matters: providers come first because nothing works without credentials. Branding is third because it's the most visible to end users despite being the least functional. Security is last because most users will rarely touch it.

---

## Database schema

Phase 5 adds two tables. Both should be added to Phase 1's migration when you next update the schema (or as a Phase 5 migration if you're already running).

### `settings`
A single-row-per-key table holding all configuration values. Treating each setting as a row (rather than columns of a config table) means adding new settings doesn't require migrations.

| column | type | notes |
|---|---|---|
| key | text pk | dotted-namespace key like `llm.anthropic.api_key` |
| value_encrypted | text | encrypted value if `is_secret`; plain JSON if not |
| is_secret | boolean | whether the value should be encrypted |
| value_type | text | `string` / `number` / `boolean` / `json` — for client parsing |
| description | text nullable | human-readable explanation |
| updated_at | timestamp | |
| updated_by | text nullable | who changed it (Phase 5 has no auth, so often null) |

Settings keys follow a dotted namespace:

- `llm.anthropic.api_key`
- `llm.openai.api_key`
- `llm.default_provider`
- `models.available` (a JSON array)
- `models.default` (string)
- `branding.app_name`
- `branding.logo_path`
- `branding.color_primary`
- `branding.color_accent`
- `system.scheduler_timezone`
- `system.log_level`
- `system.default_skill_timeout_seconds`
- `system.allowed_packages` (a JSON array)
- `security.encryption_key_id` (which key encrypts current secrets)

### `settings_audit`
Every change to a setting is logged. This table is append-only. Phase 5 has no auth, so the actor is often unknown, but the table is structured to support it later.

| column | type | notes |
|---|---|---|
| id | uuid pk | |
| key | text | |
| previous_value_hash | text nullable | sha256 of previous value (never the value itself, even encrypted) |
| new_value_hash | text | sha256 of new value |
| actor | text nullable | who made the change (when auth exists) |
| reason | text nullable | optional reason supplied at change time |
| changed_at | timestamp | |

Hashing rather than storing values means the audit log can prove a change happened without ever exposing secrets — important for compliance reviews.

---

## Encryption at rest

API keys and other secrets must be encrypted in the database, not stored as plain text. The approach:

A master encryption key is resolved on boot in this order:

1. `SWARM_ENCRYPTION_KEY` env var (operator-managed, wins if set)
2. `<DATA_DIR>/.encryption_key` file (container-managed, persisted across restarts)
3. If neither exists, the container generates a new key on first boot, writes it to `<DATA_DIR>/.encryption_key`, logs a warning telling the operator to back it up, and proceeds.

There is still no "default" key — every installation gets a unique one. The file-based fallback exists because the encryption key and the encrypted database have the same lifetime: both live in the data volume, so losing one without the other is impossible. This avoids the failure mode where an operator unaware of the env-var requirement loses every secret on the next container restart.

Operators who want stronger separation (e.g., key in a secret manager, database in a less-trusted backup location) should set `SWARM_ENCRYPTION_KEY` explicitly and exclude `.encryption_key` from their data backups.

Secrets are encrypted with Fernet (symmetric, AES-128-CBC + HMAC) before being written to `settings.value_encrypted`. Decryption happens in `app/core/secrets.py` and is the only place in the codebase that reads the master key. Agents and skills never see the plaintext API key — they call `secrets.get_llm_credentials(provider)` which returns a configured `LLMClient` instance.

Key rotation is a deliberate operation. The Settings UI has a "Rotate encryption key" button under Security that:

1. Asks for the new master key (paste-in or generate)
2. Re-encrypts every secret with the new key in a single transaction
3. Updates `security.encryption_key_id` to the new identifier
4. The user must update `SWARM_ENCRYPTION_KEY` in their environment before the next container restart, or the system won't be able to decrypt

Rotation is logged to `settings_audit` with the special key `_rotation_event`.

---

## Section 1: LLM Providers

The most important section because nothing functional works without it.

### What it manages

- API keys for each supported provider
- A "default provider" selector (which provider new agents use unless they override)
- Per-provider configuration (base URL for self-hosted, organization ID for OpenAI, etc.)

### UI shape

Each provider gets a card. Cards are stacked vertically. Each card shows:

- Provider name with a colored dot indicating connection status (untested / connected / failed)
- A masked API key field (`sk-ant-•••••••••••••••••3F2A`)
- An "Edit" button that reveals an editable input for pasting a new key
- A "Test connection" button that makes one cheap API call and updates the status dot
- Provider-specific fields below (base URL for OpenAI-compatible endpoints, organization ID, etc.)
- A "Set as default" radio button (only one provider can be default at a time)

When the user pastes a new key and clicks Save, the backend:

1. Validates the key format (Anthropic: starts with `sk-ant-`; OpenAI: starts with `sk-`)
2. Optionally calls a test endpoint to verify the key works
3. Encrypts the value and writes to `settings`
4. Logs to `settings_audit`

Failed test connection: the status dot turns red, the new key is *not* saved, an error message explains what went wrong (`401 invalid_api_key`, `network error`, etc.).

### Edge cases worth handling

If the user edits a key and clicks away without saving, prompt for confirmation. Losing a half-edited credential is annoying.

If a key is removed entirely (cleared and saved), all agents using that provider should fall back to the default provider. If the default provider also has no key, the swarm refuses to run agents and surfaces a clear "no LLM provider configured" error in the Runs view.

Test-connection responses must never include the API key in error messages or logs, even sanitized. A common bug.

---

## Section 2: Models

Once providers are configured, the user picks which specific models are available to agents.

### What it manages

- A list of model identifiers (e.g., `claude-opus-4-7`, `claude-sonnet-4-6`, `gpt-4o`, `gpt-4o-mini`)
- A display name for each (e.g., "Claude Opus 4.7 (most capable)")
- An assigned provider per model
- A "default model" selector — what new agents use unless they override
- Optional per-model defaults: max tokens, temperature, etc.

### UI shape

A table view with columns: Display name, Model identifier, Provider, Default, Actions. An "Add model" button at the top opens a modal for entering a new entry.

Each row's Default column shows a radio button — only one model can be the system default at a time. The default propagates: agents whose constitution doesn't specify a `model` use this one.

Removing a model is allowed but warns if any agents reference it. The warning lists the affected agents and offers to bulk-update them to a chosen replacement.

### Why models are settings, not hardcoded

Model identifiers change. New models release. Old ones deprecate. Hardcoding the available models in the codebase means every model release requires a code update. Storing them in settings means an operator can update the system in 30 seconds when a new Claude or GPT version drops.

### A subtle but important rule

The Models section does *not* validate that a given model identifier actually exists at the provider. That's the provider's job at call time — if you configure `claude-opus-4-99` and it doesn't exist, the first agent run using that model will fail with a clear "model not found" error. This is correct behavior. The settings UI should not pretend to know the provider's catalog; that catalog changes without notice.

---

## Section 3: Branding

The least functional section, but the most visible. This is where users make the system feel like *their* system.

### What it manages

- App name (default: "Swarm")
- Logo (an uploaded image file, displayed in the top bar)
- Primary color (used for active states, primary buttons)
- Accent color (used for highlights, live state, perceptionist accents)
- Optional: a small tagline shown under the app name in headers

### UI shape

A two-column layout. Left column: form fields with live preview chips beside each color picker. Right column: a sample preview rendering — a fake top bar with the configured logo and name, a fake button in the primary color, a fake highlight in the accent color. As the user changes values on the left, the preview on the right updates instantly.

A "Reset to defaults" button at the bottom restores the system palette (the navy/amber from the management deck).

### Logo upload

The logo is uploaded as PNG or SVG. Maximum 200KB, maximum dimensions 400×100 pixels. The backend stores it in `data/branding/logo.{png,svg}` and references it from `settings.branding.logo_path`. Served as a static asset by Flask.

If the logo is SVG, the system can color it via CSS to match the palette. If it's PNG, it's displayed as-is — users uploading raster logos take responsibility for color matching.

### Why colors are settings, not theme files

Themes-as-files (a `theme.css` you swap out) are powerful but require editing CSS. Most users want to pick two colors and have everything work. Storing the colors as settings and applying them via CSS custom properties at runtime gives 95% of theme flexibility with 5% of the complexity.

The CSS variables are: `--color-primary`, `--color-accent`, `--color-bg`, `--color-fg`, `--color-muted`, `--color-border`. Settings only expose primary and accent; the rest are derived (the muted text color is, e.g., the foreground at 60% opacity). This keeps the user-facing surface small.

### Dark mode

Phase 5 does not implement dark mode. If a user really wants it, they can override the CSS variables in a custom stylesheet — but that's a "user knows what they're doing" path, not a settings toggle. Adding dark mode properly means designing both palettes for every screen, which is a real project on its own.

---

## Section 4: System

Operational defaults and infrastructure-adjacent settings.

### What it manages

- **Scheduler timezone** — what timezone cron expressions are interpreted in (default: `Europe/Amsterdam`)
- **Log level** — `DEBUG` / `INFO` / `WARNING` / `ERROR` (default: `INFO`)
- **Default skill timeout** — how long skills can run before being killed if they don't specify their own (default: 30 seconds)
- **Default heartbeat schedule** — what cron expression new heartbeats start with (default: `*/5 * * * *`)
- **Allowed Python packages for skills** — the global allowlist that skill `.yaml` files must subset (default: `requests`, `pypdf`, `pdfplumber`, `pandas`, `openpyxl`, `lxml`, `beautifulsoup4`)

### UI shape

A single-column form, no preview. Each field has clear labels and inline help text explaining what changes when you change it. Some fields (like the package allowlist) are chip-input controls; others are simple text or dropdowns.

The package allowlist is the most consequential — adding a package to the allowlist means skills can declare and use it, but the package must already be installed in the container's Python environment. The UI surfaces this: when the user types a package name, a small "verify installed" indicator runs `python -c "import {pkg}"` server-side and shows green if it's already available, amber if it's allowed-but-not-installed.

### Restart-required settings

Some settings only take effect after a container restart (scheduler timezone, log level when set lower than the current process). The UI flags these with a "Requires restart" pill next to the field. After saving, a banner at the top of the screen says "Restart required for one or more recent changes to take effect."

### What's *not* here

Database connection strings, encryption keys, port numbers, and other infrastructure values stay in environment variables — not in settings. Settings is for things operators change without touching the deployment. Anything that changes deployment characteristics belongs in `.env`.

---

## Section 5: Security

The smallest section, but the most consequential when something goes wrong.

### What it manages

- **Master encryption key rotation** — the rotation flow described above
- **Audit log retention** — how long `settings_audit` rows are kept (default: 365 days; minimum: 90; maximum: forever)
- **API access** — placeholders for when authentication is added (Phase 6 or later); shows "Not configured — local-only access" in Phase 5

### UI shape

A single-column page with three card-shaped panels, one per concern. The encryption key panel has the most going on: it shows the current key's identifier (a short hash, never the key itself), the date it was generated, and a prominent "Rotate" button that opens the rotation flow as a multi-step modal.

The rotation modal is deliberately friction-heavy:

1. **Step 1**: a warning explaining what will happen and why downtime is required
2. **Step 2**: choice of "generate new key" or "paste my own"
3. **Step 3**: confirmation showing the new key value (this is the only time the system displays a master key in plaintext — the user is told to copy it now and add to their environment)
4. **Step 4**: a "I have updated my environment file. Re-encrypt now." button. The system performs the re-encryption.
5. **Step 5**: a final screen confirming success and reminding the user to verify the next container restart succeeds

The friction is the point. Master key rotation is rare and high-stakes; the UI should not make it feel casual.

---

## API endpoints

All under `/api/v1/settings`. JSON in, JSON out. Settings reads are lightweight; writes are heavier (validation, encryption, audit logging).

- `GET /api/v1/settings` — return all settings, with secrets masked (e.g. `sk-ant-•••3F2A`)
- `GET /api/v1/settings/<key>` — return one setting (still masked if secret)
- `PUT /api/v1/settings/<key>` — update a single setting; validates type, encrypts if secret, audit-logs
- `PUT /api/v1/settings` — bulk update multiple settings in one transaction; useful for the branding section where colors change together
- `POST /api/v1/settings/llm/test` — body: `{"provider": "anthropic", "api_key": "..."}` → tests the key without saving; returns success/failure and provider message
- `POST /api/v1/settings/branding/logo` — multipart file upload; validates dimensions and size; saves to `data/branding/`
- `GET /api/v1/settings/audit?key=<key>&limit=50` — read the audit log for one key or all keys
- `POST /api/v1/settings/security/rotate-key` — performs encryption key rotation; expects new master key in body

The frontend should call `GET /api/v1/settings` once on app load and cache the result, refreshing only after a known mutation. Settings should never be fetched on every navigation.

---

## What Phase 5 deliberately does NOT include

- **Authentication** — settings can still be edited by anyone with access to the GUI. Putting the system behind an auth proxy is the operator's responsibility until a later phase.
- **Multi-tenancy** — one set of settings per installation. No "Acme's settings" vs "Beta's settings."
- **Per-user preferences** — there are no users yet, so there are no per-user settings (theme override, notification preferences, etc.).
- **Email/SMTP for sending alerts** — settings doesn't manage outbound email config; the `send-email` skill reads SMTP credentials from environment variables for now.
- **Backup and restore of settings** — operators can copy `data/swarm.db` to back up; a proper export/import UI is future work.
- **Granular skill sandbox configuration** — package allowlist is here, but per-skill network policies, memory limits, etc., stay in skill `.yaml` files.

---

## Acceptance checklist

- [ ] Settings screen has five tabs in the documented order
- [ ] An invalid Anthropic API key is rejected by the test-connection flow without being saved
- [ ] A valid API key encrypts to a different value each save (Fernet IV randomness)
- [ ] Removing a model that agents reference shows a warning listing affected agents
- [ ] Changing primary or accent colors updates the entire app within one second, no reload
- [ ] Logo upload rejects files over 200KB or outside dimension limits with a clear error
- [ ] Adding a package to the allowlist verifies whether it's actually installed in the container
- [ ] Settings flagged "Requires restart" show the banner after save
- [ ] Master encryption key rotation succeeds end-to-end and existing settings remain decryptable
- [ ] `settings_audit` records every change with the appropriate hash, never the value
- [ ] `GET /api/v1/settings` masks secret values; `PUT` accepts plaintext and stores encrypted
- [ ] Container resolves an encryption key on every boot (env var, persisted file, or generated + persisted) and never starts with an invalid one
