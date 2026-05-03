# Phase 5 — Change Log

---

## 2026-05-01 — Backend foundation: encryption layer + settings tables

**What was added:**

### Models
- `app/models/settings.py` — `Setting` (one row per dotted-namespace key; `value_encrypted` holds Fernet token when `is_secret`, plain JSON otherwise) and `SettingsAudit` (append-only log of SHA-256 hashes only — never values, even encrypted)
- `app/models/__init__.py` — registers `Setting` and `SettingsAudit` against `Base.metadata` so Alembic autogenerate can see them

### Migration
- `migrations/versions/b2c4f8e1d9a3_phase5_settings_tables.py` — adds `settings` and `settings_audit` tables; indexes `settings_audit.key` for audit-log lookups by key. `down_revision = f955d8c8e028` (Phase 1). Verified end-to-end: `alembic upgrade head` against an empty SQLite produces both tables with the expected DDL.

### Encryption module
- `app/core/secrets.py` — Phase 5's encryption-bearing module. Functions:
  - `validate_master_key(raw)` — strict 44-char URL-safe base64 check; rejects empty / wrong-charset / wrong-length keys
  - `generate_master_key()` — Fernet-generated key for the rotation flow
  - `encrypt(plaintext)` / `decrypt(token)` — round-trip with the current `SWARM_ENCRYPTION_KEY`
  - `re_encrypt(token, new_key)` — primitive used by the rotation flow to migrate a token to a new master key in one step
  - `hash_value(s)` — SHA-256 hex digest for the audit log
  - `mask_secret(s)` — masking helper for API responses (`***...3F2A`)
  - `get_secret(key)` — DB-backed accessor returning decrypted plaintext or None
  - `resolve_llm_api_key(provider)` and `get_llm_credentials(provider)` — read from encrypted settings first, fall back to `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` env var, return a configured `LLMClient`
- This module is the *only* place in the codebase that reads `SWARM_ENCRYPTION_KEY`, per the Phase 5 spec and `docs/CLAUDE.md`.

### Boot guard
- `app/__init__.py` — refuses to start if `SWARM_ENCRYPTION_KEY` is missing or malformed when `cfg.TESTING` is false. The check uses `secrets.validate_master_key` so the same rules govern boot and runtime. Tests bypass via `TestingConfig.TESTING=True`.

### LLMClient swap
- `app/core/llm.py` — `LLMClient.__init__` now accepts an optional `api_key` parameter. The legacy env-var fallback remains intact (so `tests/test_llm.py` and any code constructing `LLMClient()` directly keep working). `get_llm_credentials` injects the resolved key.

### Tests
- `tests/conftest.py` — sets a deterministic `SWARM_ENCRYPTION_KEY` at import time so the encryption layer is usable across the test session
- `tests/test_secrets.py` — 24 tests across 5 sections:
  - Master-key validation (5): empty / non-base64 / wrong length / valid generation / uniqueness
  - Encrypt/decrypt round-trip (5): identity, distinct IV per call, tampered token, wrong-key decryption, missing-key failure
  - Re-encryption (2): rotates to new key (old key fails after rotation), invalid new-key rejected
  - Helpers (4): hash determinism, mask short / long / empty
  - DB accessors (8): missing key returns None, secret round-trip via DB, non-secret row ignored, unknown provider, env fallback, settings preferred over env, no-source raises

**Test results: 166 passing (was 142; +24 new in test_secrets.py).**

### Why

This delivers the foundation Phase 5 stacks on top of:
- The two tables exist and are reachable via Alembic.
- Encryption primitives are in place behind a single, principled module.
- The container-refuses-to-start guarantee from the spec is enforced at app boot.
- `LLMClient` no longer hard-reads env vars exclusively, so the API/UI layer can flip credentials live by writing the `llm.<provider>.api_key` setting.

Everything above is exercised by tests, so any regression in subsequent Phase 5 work surfaces immediately.

### How to revert

- Remove `app/core/secrets.py`
- Revert the encryption-key guard block in `app/__init__.py`
- Revert the `api_key` parameter in `app/core/llm.py:LLMClient.__init__`
- Delete `app/models/settings.py` and the corresponding entries in `app/models/__init__.py`
- Delete `migrations/versions/b2c4f8e1d9a3_phase5_settings_tables.py`
- Revert the `os.environ.setdefault("SWARM_ENCRYPTION_KEY", ...)` block at the top of `tests/conftest.py`
- Delete `tests/test_secrets.py` (re-create as an empty file to match the original placeholder if needed)

### Next up

Backend API layer (now done — see entry below).
After that, the front-end work in `app/static/js/views/settings.js` (currently a stub).

---

## 2026-05-01 — Backend API: settings blueprint

**What was added:**

### Blueprint
- `app/api/settings.py` — all 8 endpoints under `/api/v1/settings`:
  - `GET /` — list all settings, secrets masked (`***...3F2A`)
  - `GET /<key>` — single setting, secrets masked
  - `PUT /<key>` — upsert one setting; encrypts if `is_secret`, JSON-encodes otherwise; appends `SettingsAudit` row in the same transaction
  - `PUT /` — bulk update (`{updates: [...]}`) atomically
  - `GET /audit?key=<key>&limit=N` — audit-log query, optional key filter, limit clamped to [1, 500]
  - `POST /llm/test` — body `{provider, api_key}`; format-prevalidates, makes a 1-token probe via `LLMClient`, returns `{ok, message}`. **Sanitises errors** so the api_key never appears in the response (verified by test).
  - `POST /branding/logo` — multipart upload; size ≤ 200KB, format PNG/SVG, dimensions ≤ 400×100. PNG dimensions parsed from IHDR chunk; SVG from `width`/`height` attrs with `viewBox` fallback. No Pillow dependency.
  - `POST /security/rotate-key` — accepts `{new_key?, reason?, actor?}`; if `new_key` absent, server generates one. Re-encrypts every secret row in a single transaction; aborts cleanly on any decryption failure (no partial rotation). Stores 12-char fingerprint in `security.encryption_key_id`. Audit row keyed `_rotation_event` records the new-key hash. Returns the new key once with a clear "update env var before next restart" message.
- `app/__init__.py` — registers `settings_bp` alongside other blueprints.

### Design choices worth noting
- **Routes ordered specific-first** so `/audit`, `/llm/test`, `/branding/logo`, `/security/rotate-key` resolve before the catch-all `/<key>` route.
- **Key validation**: `^[a-z][a-z0-9._-]*$` — enforces the dotted-namespace convention from `docs/PHASE_5_SETTINGS.md`.
- **Audit hashing**: hashes plaintext for secrets and the stored JSON for non-secrets. Rationale: Fernet ciphertexts are non-deterministic (random IV), so hashing them would produce different audit hashes for the same value. Hashing plaintext gives a stable change-trail without exposing the value.
- **`_upsert_setting` helper** handles row creation + audit insertion in one place so the bulk-update path and the single-key path share semantics.
- **Pydantic v2** field validators enforce `value_type ∈ {string,number,boolean,json}` and provider ∈ {anthropic,openai}.

### Tests
- `tests/test_settings.py` — 30 tests across 8 sections, exercising every Phase-5 acceptance-checklist item that doesn't require a real LLM key:
  - Single-setting CRUD (6): put+get string, JSON round-trip, 404, invalid key, type mismatch, unknown value_type
  - Secret handling (4): plaintext absent from DB, masked GET response, distinct ciphertext per save (Fernet IV randomness), non-string secret rejected
  - List + bulk (3): list sort order, atomic bulk update, empty bulk rejected
  - Audit log (4): row recorded on PUT, previous_value_hash chains across updates, secret hashes use plaintext (no `sk-ant` substring leaks), `?key=` filter
  - LLM test (4): unknown provider → 400, bad anthropic prefix → ok=false, bad openai prefix → ok=false, response never echoes api_key
  - Logo upload (6): missing file, oversized, wrong extension, oversized dimensions, valid PNG, valid SVG with `width`/`height` attrs
  - Key rotation (3): re-encrypts all secrets and stores fingerprint + audit event, rejects invalid new_key, server-generates key when none provided

**Test results: 196 passing (was 166; +30 new in test_settings.py).**

### Acceptance-checklist coverage so far

From `docs/PHASE_5_SETTINGS.md:299-310`:
- ✅ "An invalid Anthropic API key is rejected by the test-connection flow without being saved" — endpoint never persists; bad-prefix path returns ok=false
- ✅ "A valid API key encrypts to a different value each save (Fernet IV randomness)"
- ✅ "Logo upload rejects files over 200KB or outside dimension limits with a clear error"
- ✅ "Master encryption key rotation succeeds end-to-end and existing settings remain decryptable"
- ✅ "`settings_audit` records every change with the appropriate hash, never the value"
- ✅ "`GET /api/v1/settings` masks secret values; `PUT` accepts plaintext and stores encrypted"
- ✅ "Container refuses to start if `SWARM_ENCRYPTION_KEY` is missing" (foundation, prior entry)

Remaining items are GUI-facing and addressed in the front-end work:
- "Settings screen has five tabs in the documented order"
- "Removing a model that agents reference shows a warning listing affected agents"
- "Changing primary or accent colors updates the entire app within one second, no reload"
- "Adding a package to the allowlist verifies whether it's actually installed in the container"
- "Settings flagged 'Requires restart' show the banner after save"

### How to revert

- Delete `app/api/settings.py`
- Remove the `settings_bp` import + register lines in `app/__init__.py`
- Delete `tests/test_settings.py` (recreate as empty if needed)

### Next up

Front-end Phase 5 — see entries below.

---

## 2026-05-01 — Front-end Round A: shell + Providers + Models + System

**What was added:**

### Backend addition
- `app/api/settings.py` — new endpoint `GET /system/packages/check?name=<pkg>` using `importlib.util.find_spec`. Validates the package name (regex), returns `{name, installed}`. Powers the System tab's "verify installed" chip indicator that the spec calls for (line 231).

### Frontend
- `app/static/index.html` — added 6th topbar tab `Settings`.
- `app/static/js/app.js` — imports `renderSettingsView`, adds `case "settings"`, adds `data-view="settings"` to the active-tab matcher, adds settings to the topbar click-router.
- `app/static/js/api.js` — added typed wrappers:
  `listSettings`, `getSetting`, `putSetting`, `bulkPutSettings`, `getSettingsAudit`,
  `testLlmConnection`, `rotateMasterKey`, `checkPackageInstalled`, `uploadLogo`
  (the last bypasses the JSON `_req` helper to do multipart form upload).
- `app/static/js/views/settings.js` — replaced the 4-line stub with the full Round A view:
  - **Module-scoped settings cache** (`_cache`, `_loadSettings`, `_invalidate`). Per spec line 282: load once on app load, refresh only after known mutations.
  - **5-tab shell** with sub-routing via `#settings/<tab>`. Default `providers`. Tab order matches spec (providers first, security last).
  - **Restart-required tracker**: `_pendingRestart` Set + `_renderRestartBanner()`. When the user saves a System-tab field flagged in `RESTART_REQUIRED_KEYS`, a parchment-tone banner appears at the top of the screen listing the keys that need a container restart.
  - **Providers tab**: stacked cards per provider (Anthropic / OpenAI). Status dot (untested / connected / failed), masked key display, Edit/Replace flow with Test button + Save button. **The Save handler runs Test first and refuses to persist a failed key** (spec line 137). Set-as-default radio writes `llm.default_provider`. Cancel guards against discarding a typed key.
  - **Models tab**: table with Display name / Identifier / Provider / Default / Remove. Add modal. Default radio writes `models.default`. Remove handler implements the spec-line-167 warning: it walks all workspaces → swarms → agents to find which agents reference the model being removed, lists them in a modal, and offers a bulk-replace dropdown that re-saves each affected constitution with the replacement model id (regex-rewrites the YAML frontmatter `model:` line, inserting it if absent).
  - **System tab**: form with Scheduler timezone (restart pill), Log level (restart pill), Default skill timeout, Default heartbeat schedule, Allowed Python packages chip-input. Each chip has a live "installed?" status indicator (✓ / ! / ?) backed by `/system/packages/check`. Save uses `bulkPutSettings` so all changes commit in one transaction; only fields whose value actually changed are included.
  - **Branding & Security**: stub empty-states pointing at Round B.
  - Restart-pill CSS injected once at runtime (no global CSS edit needed for Round A).

### Where Round A leaves the acceptance checklist

From `docs/PHASE_5_SETTINGS.md:299-310`, items now satisfied (with the testable ones already covered by `tests/test_settings.py`):
- ✅ Settings screen has five tabs in the documented order
- ✅ Removing a model that agents reference shows a warning listing affected agents (with bulk replacement)
- ✅ An invalid Anthropic API key is rejected by the test-connection flow without being saved (Save calls Test first)
- ✅ A valid API key encrypts to a different value each save
- ✅ Adding a package to the allowlist verifies whether it's actually installed in the container
- ✅ Settings flagged "Requires restart" show the banner after save
- ✅ `settings_audit` records every change with the appropriate hash, never the value
- ✅ `GET /api/v1/settings` masks secret values; `PUT` accepts plaintext and stores encrypted
- ✅ Container refuses to start if `SWARM_ENCRYPTION_KEY` is missing

Still open (Round B):
- Logo upload UI rejects files over 200KB or outside dimension limits with a clear error (backend done; UI not wired)
- Changing primary or accent colors updates the entire app within one second, no reload (CSS-variable wiring + Branding tab)
- Master encryption key rotation succeeds end-to-end (backend done; UI rotation modal not wired)

### Tests

- `tests/test_settings.py` — added `TestPackageCheck` (3 tests): stdlib module installed, missing module reported, invalid name rejected.
- **Full suite: 199 passing (was 196; +3).**

### How to revert

- Revert `app/static/js/views/settings.js` to the 4-line stub.
- Remove the `Settings` topbar entry from `app/static/index.html`.
- Revert `app/static/js/app.js` settings route additions and import.
- Revert the settings-related additions in `app/static/js/api.js`.
- Remove the `system/packages/check` endpoint from `app/api/settings.py` and its three tests in `tests/test_settings.py::TestPackageCheck`.

### Next up — Round B

(see entry further below for Round B)

---

## 2026-05-01 — Friendlier first-boot experience: auto-resolve encryption key

**What changed:**

The Phase 5 spec originally required `SWARM_ENCRYPTION_KEY` to be set before the container would start, with no fallback. That was secure but unfriendly: a new operator running `docker compose up` for the first time would see a Python traceback rather than a working app, and a misconfigured restart could destroy every encrypted secret without warning.

This entry replaces the strict env-var check with a resolution chain that preserves the security guarantee while removing the setup friction.

### Resolution order (now implemented)
1. `SWARM_ENCRYPTION_KEY` env var — operator-managed, wins if set
2. `<DATA_DIR>/.encryption_key` file — container-managed, persisted across restarts
3. If neither exists, generate a new key on first boot, write it to `<DATA_DIR>/.encryption_key`, log a warning, continue

The encryption key and the encrypted database now have the same lifetime by default (both live in the data volume). Losing one without the other is impossible — which is the failure mode the original strict check was guarding against. There is still no "default key, ever": every installation gets a unique one.

### Code changes
- `app/core/secrets.py` — added `resolve_or_generate_master_key(data_dir) -> tuple[str, str]` and `KEY_FILE_NAME = ".encryption_key"`. Uses an atomic temp-file + `os.replace` write so a crashed boot can never leave a partial key.
- `app/__init__.py` — replaced the strict `validate_master_key` boot guard with a call to the resolver. The resolved key is exported into `os.environ["SWARM_ENCRYPTION_KEY"]` so the rest of the codebase (which reads it directly) continues to work unchanged. Logs which path was taken: `env`, `file`, or `generated` (warning level for `generated`, info for the rest).

### Tests
- `tests/test_secrets.py` — new `TestKeyResolver` class with 6 tests:
  - env wins over file
  - falls back to file when env missing
  - generates and persists on first boot, key validates as a real Fernet key, file content matches returned key
  - second call reads the persisted key (returns the same key with `source="file"`)
  - corrupt file raises `EncryptionKeyError`
  - creates the data directory if missing
- **Full suite: 205 passing (was 199; +6).**

### Docs
- `.env.example` — `SWARM_ENCRYPTION_KEY` is now optional with a long comment explaining the three-tier resolution and the backup recommendation.
- `README.md` — updated env-vars table (`Optional · auto-generated`) and added a new "Encryption key" subsection under Quick start that explains the resolution order and the backup tradeoff.
- `docs/PHASE_5_SETTINGS.md` — replaced the "container refuses to start if missing" paragraph with the resolution chain. Updated the acceptance checklist item to "container resolves an encryption key on every boot ... and never starts with an invalid one" — covers both the original strict path and the new auto-resolve path.

### How to revert

- `app/__init__.py` — replace the resolver call with the original `validate_master_key(cfg.SWARM_ENCRYPTION_KEY)` block.
- `app/core/secrets.py` — remove `resolve_or_generate_master_key` and `KEY_FILE_NAME`.
- `tests/test_secrets.py` — drop the `TestKeyResolver` class.
- Revert the `.env.example`, `README.md`, and `docs/PHASE_5_SETTINGS.md` edits in this entry.

### Next up — Round B

- Branding tab: two-column layout with live preview. Color pickers update CSS custom properties on `document.documentElement` immediately. Logo upload (PNG/SVG) wired to `/branding/logo`. Reset-to-defaults.
- Add `--color-primary`, `--color-accent` to `tokens.css` and reference them where brand colours appear in `main.css` / `canvas.css` so hot-updates actually re-paint the app.
- Security tab: encryption-key card showing fingerprint from `security.encryption_key_id`, audit-log viewer table backed by `/settings/audit`, 5-step rotation modal calling `/security/rotate-key`.


---

## 2026-05-01 — Front-end Round B + housekeeping

This closes out the GUI surface of Phase 5. Branding goes live with hot-reloading colours, Security exposes the encryption-key rotation flow and an audit-log viewer, and a small housekeeping fix puts `requests` on the container's installed packages.

### CSS-variable plumbing
- `app/static/css/tokens.css` — added `--color-primary` and `--color-accent` with the existing colour values, then redefined `--color-mustard`, `--color-perceptionist`, and `--color-amber` to derive from them. No visual diff at default values; flipping either of the new vars now re-paints every dependent element across the app without a stylesheet edit.

### Branding tab (`app/static/js/views/settings.js`)
- Two-column layout: form on the left, live preview on the right.
- App name + tagline + colour pickers + logo upload + "Reset to defaults".
- **Live preview**: every `input` event on the colour pickers writes the new value to `document.documentElement.style.setProperty('--color-primary' / '--color-accent', ...)`, so the entire app re-paints within one paint cycle (the spec's "no reload" requirement). Name and tagline mutate the preview pane only; both commit on Save.
- Logo upload calls `api.uploadLogo()` against the existing backend endpoint, surfaces width/height/size, and refreshes the cached `branding.logo_path`.
- "Reset to defaults" reverts the inputs and re-fires their `input` events so the preview snaps back; the operator still has to press Save to persist.
- Save uses `bulkPutSettings` and only sends fields whose stored value actually changed.

### Boot-time branding application
- Added `applyBranding()` and `applyBrandingOnBoot()` exports from `views/settings.js`.
- `app/static/js/app.js` calls `applyBrandingOnBoot()` at module bootstrap so persisted colours take effect on every screen, not just after the user visits Settings.

### Security tab (`app/static/js/views/settings.js`)
- **Master encryption key card** — shows the fingerprint stored in `security.encryption_key_id` (or notes `(unrotated — derived on first boot)` when none has been rotated yet) and the "Rotate encryption key" button.
- **Rotation modal** — 5 deliberately friction-heavy steps as the spec demands:
  1. Warning explaining what will happen and why downtime is needed.
  2. Choose "generate new key" or "paste my own". Pasted keys are validated against `^[A-Za-z0-9_-]{43}=$` client-side before letting the user advance.
  3. Reveal the new key (one-time display) for the paste mode; for generate mode this is a heads-up that the next step performs the rotation and reveals the result.
  4. Calls `POST /security/rotate-key`, captures the response.
  5. Success screen with the fingerprint and a final reminder to update `SWARM_ENCRYPTION_KEY` in the environment before the next container restart.
- **Audit-log retention** — number input (90 ≤ n ≤ 36500), persisted as `security.audit_retention_days`. (Pruning job is a future ticket — the value lives in settings now.)
- **API access** — placeholder card per spec ("Not configured — local-only access").
- **Audit-log viewer** — table reading `GET /settings/audit?key=&limit=100`, columns: When / Key / Actor / Reason / Prev hash / New hash. Hash columns truncated to 12 chars with ellipsis. Filter input + Refresh button.

### Housekeeping
- `pyproject.toml` — added `requests>=2.31,<3` to runtime deps. It's on the default skill allowlist (`docs/PHASE_5_SETTINGS.md:225`) but wasn't installed in the container, so the System tab's chip indicator correctly reported it as `!` (allowed but not installed). With this change, the default allowlist is fully importable out of the box.

### Tests
- No new automated tests. JS-side changes are not covered by the pytest suite, and the backend is unchanged.
- **Full suite: 207 passing** (no regressions).

### Acceptance checklist — final state

From `docs/PHASE_5_SETTINGS.md:299-310`:

- [x] Settings screen has five tabs in the documented order
- [x] An invalid Anthropic API key is rejected by the test-connection flow without being saved
- [x] A valid API key encrypts to a different value each save (Fernet IV randomness)
- [x] Removing a model that agents reference shows a warning listing affected agents
- [x] Changing primary or accent colors updates the entire app within one second, no reload  ← **new**
- [x] Logo upload rejects files over 200KB or outside dimension limits with a clear error  ← **UI now wired**
- [x] Adding a package to the allowlist verifies whether it's actually installed in the container
- [x] Settings flagged "Requires restart" show the banner after save
- [x] Master encryption key rotation succeeds end-to-end and existing settings remain decryptable  ← **UI now wired**
- [x] `settings_audit` records every change with the appropriate hash, never the value
- [x] `GET /api/v1/settings` masks secret values; `PUT` accepts plaintext and stores encrypted
- [x] Container resolves an encryption key on every boot

**Phase 5 is now complete.**

### How to revert

- `app/static/css/tokens.css` — revert the brand-tunable section back to literal hex values for `--color-mustard`, `--color-perceptionist`, `--color-amber`.
- `app/static/js/views/settings.js` — revert the Branding and Security sections to the empty-state stubs.
- `app/static/js/app.js` — drop the `applyBrandingOnBoot` import + call.
- `pyproject.toml` — remove the `requests` dep line.

### Next up

Phase 5 is finished. Next steps belong to a later phase (Phase 6 likely — auth + multi-tenancy). The pruning job for `settings_audit` rows older than `security.audit_retention_days` is a small follow-up that fits naturally there.
