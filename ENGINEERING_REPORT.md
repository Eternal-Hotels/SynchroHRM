# SynchroHRM Engineering Report

Generated on 2026-06-18 from the current `C:\Scripts\SynchroHRM` checkout.

This report is meant to get a new engineer productive quickly. Most sections below are verified directly from the current source tree. The final section includes a few recent operational notes pulled from prior rollout memory; treat those as useful context, but re-verify anything environment-specific before acting on it.

## 1. What this project is

SynchroHRM is a Node.js + TypeScript service that:

- polls a Microsoft 365 mailbox through Microsoft Graph
- pulls supported hotel-report attachments (`.pdf` and `.xlsx`)
- archives the raw files locally for auditability
- parses supported PDF report families into normalized row tables
- writes per-property CSV staging exports
- exposes an admin/viewer web console for monitoring, replaying, and downloading report data
- stores NetSuite connection settings for proof-of-life testing and metadata-catalog export

This is currently a hospitality reporting ingestion and staging app. It is not yet a full NetSuite posting pipeline.

## 2. System at a glance

End-to-end flow:

1. `src/index.ts` loads config and opens the SQLite database.
2. It creates:
   - `AuthService`
   - `GraphAttachmentSource`
   - `IngestionService`
   - `NetSuiteConnectionService`
   - the Express app from `src/http/createApp.ts`
3. A cron job runs on `SYNCHRO_POLL_CRON` and triggers mailbox syncs.
4. Manual admin syncs can also trigger a run through the UI or API.
5. Attachments are filtered by sender allowlist, archived under `storage/raw/`, then:
   - parsed into JSON + SQLite + CSV exports if supported
   - marked `deferred` if `.xlsx`
   - quarantined under `storage/quarantine/failed` or `storage/quarantine/unsupported` if parsing fails
6. The UI reads dashboard, property, run, attachment, user, sender-allowlist, and NetSuite state directly from the local database and generated artifacts.

## 3. Tech stack

- Runtime: Node.js 22+
- Language: TypeScript compiled to `dist/`
- HTTP server: Express 5
- Scheduler: `node-cron`
- PDF parsing: `pdfjs-dist`
- Spreadsheet dependency: `xlsx` is installed, but XLSX parsing is intentionally deferred in v1
- Database: `node:sqlite` (`DatabaseSync`)
- Frontend: server-served HTML/CSS/vanilla JS, no SPA framework
- Testing: custom script harness plus `node:test`-style test files

Important implication: Node 22 is a hard requirement because the code imports `node:sqlite`.

## 4. Repo map

Top-level layout:

- `src/`
  - `index.ts`: bootstrap and cron scheduling
  - `config.ts`: environment loading and runtime config
  - `http/createApp.ts`: routes, static UI, auth gating
  - `db/Database.ts`: SQLite schema and data-access layer
  - `services/IngestionService.ts`: main ingestion, reparse, retry, property-rename logic
  - `services/ExportService.ts`: CSV generation and `latest.csv` refresh
  - `services/NetSuiteConnectionService.ts`: encrypted settings storage, proof-of-life test, metadata export
  - `sources/GraphAttachmentSource.ts`: Microsoft Graph delta sync
  - `sources/ExampleDataAttachmentSource.ts`: local fixture source used in tests
  - `parsers/pdfReportParser.ts`: PDF family detection and row extraction
  - `pdf/PdfTextExtractor.ts`: low-level PDF text extraction with `pdfjs-dist`
  - `auth/AuthService.ts`: login, session, seeded admin, viewer management
  - `ui/`: admin/viewer/login HTML, CSS, and JS
  - `netsuite/`: OAuth/JWT client and NetSuite type definitions
  - `utils/`: env, files, secrets, property naming, CSV, sender allowlists, dates, downloads
- `tests/`: test files and parser expectations
- `scripts/`
  - `run-tests.ts`: custom test harness
  - `generate-parser-fixtures.ts`: regenerates parser expectations
  - `rebuild-latest-exports.ts`: rebuilds `latest.csv` files after parser/export logic changes
- `deploy/ubuntu/`: install/update/systemd bundle
- `deploy/fedora/`: install/update/systemd/nginx/TLS bundle
- `ExampleData/`: local sample attachments used for parser and e2e verification
- `storage/`: live local state and generated artifacts

## 5. Runtime architecture

### Bootstrap

`src/index.ts` is the only runtime entrypoint:

- `loadConfig()` reads `.env` unless `SYNCHRO_SKIP_DOTENV=1`
- `AppDatabase.open()` initializes the schema and attempts limited recovery if SQLite reports a disk I/O error
- the cron schedule calls `ingestionService.run("scheduled")`
- the Express app listens on `PORT` / `SYNCHRO_BIND_HOST`

### Web server

`src/http/createApp.ts` serves:

- `/login`
- `/admin`
- `/viewer`
- `/health`
- JSON APIs under `/api/...`

The app serves static UI files from `src/ui/` directly. There is no separate frontend build system.

### Single-process coordination

`IngestionService` uses an `activeRun` promise guard so only one sync/reparse/retry-style operation runs at a time. This matters operationally:

- scheduled and manual syncs do not overlap
- reparses are blocked while a sync is active
- retry-parse is blocked while a sync is active
- property edits are blocked while a sync is active

## 6. Storage layout

Local default storage root: `./storage`

Primary runtime artifacts:

- SQLite DB: `storage/synchro-ingestion.sqlite`
- Raw archived attachments: `storage/raw/<property-slug>/<YYYY-MM-DD>/...`
- Parsed JSON: `storage/parsed/<property-slug>/<reportType>/*.json`
- Quarantine:
  - `storage/quarantine/failed/...`
  - `storage/quarantine/unsupported/...`
- CSV exports:
  - `storage/exports/properties/<property-slug>/<reportType>/<timestamp>.csv`
  - `storage/exports/properties/<property-slug>/<reportType>/latest.csv`
- NetSuite debug output:
  - `storage/netsuite/debug/metadata-catalog/latest.csv`
  - `storage/netsuite/debug/metadata-catalog/latest-schemas/`

Current checkout note: `storage/` already contains real state, historical exports, and backup artifacts. Treat it as stateful operational data, not throwaway scratch space.

## 7. Database model

The database is created imperatively in `src/db/Database.ts`.

Core tables:

- `state`
  - generic key/value state
  - used for Graph delta tokens, approved-sender settings, NetSuite settings, NetSuite last test, and NetSuite last catalog export
- `ingest_runs`
  - one row per sync/reparse run
  - stores summary counts and human-readable notes
- `messages`
  - Graph message identity and metadata
- `attachments`
  - one row per archived attachment
  - tracks status, property assignment, parse results, artifact paths, and errors
- `export_history`
  - one row per generated property/report export snapshot
- `app_users`
  - admin/viewer accounts
- `app_sessions`
  - session tokens
- one table per report family
  - created dynamically from `REPORT_COLUMN_MAP`

Important engineering note: there is no formal migration framework or schema version table. Schema evolution currently happens through:

- `CREATE TABLE IF NOT EXISTS`
- `ensureColumn(...)` checks in `AppDatabase.initialize()`

If you change schema shape, update `Database.ts` carefully and think about both new installs and existing databases.

## 8. Attachment and report statuses

Attachment status values used by the app:

- `archived`: raw file saved, parse not finalized yet
- `parsed`: supported PDF parsed successfully
- `deferred`: intentionally held for later work, currently used for `.xlsx`
- `failed`: parse/runtime failure
- `unsupported`: valid file, but unsupported report family

Subtle but important UI behavior:

- property summaries only surface properties that have at least one `parsed` or `deferred` attachment
- unsupported-only or failed-only property buckets do not appear as normal tracked properties in the dashboard

## 9. Ingestion lifecycle

The core logic lives in `src/services/IngestionService.ts`.

### Normal sync flow

1. Ensure `raw/`, `parsed/`, and `quarantine/` directories exist.
2. Create an `ingest_runs` row.
3. Read saved Graph delta token from `state`.
4. Decide scan mode:
   - scheduled runs use the saved delta token when available
   - manual runs default to a full Inbox rescan
5. Pull attachments from `GraphAttachmentSource`.
6. Filter attachments against the approved-sender list.
7. Pre-analyze PDFs in parallel to infer property/report metadata.
8. Persist the Graph message.
9. Skip duplicate attachments by `(graph_message_id, graph_attachment_id)`.
10. Archive the raw attachment under `storage/raw/...`.
11. Branch by file type:
    - `.xlsx` -> mark `deferred`
    - `.pdf` -> parse or quarantine
12. Write parsed JSON for successful PDFs.
13. Insert normalized rows into the report-family table.
14. Refresh per-property `latest.csv` outputs.
15. Save the next Graph delta token.
16. Write export snapshots for the run.
17. Mark the run `completed` or `failed`.

### Graph delta behavior

`src/sources/GraphAttachmentSource.ts` uses Microsoft Graph delta endpoints against:

- mailbox: `SYNCHRO_GRAPH_MAILBOX_USER` (default `auditor@eternalhotels.com`)
- folder: `SYNCHRO_GRAPH_MAIL_FOLDER` (default `Inbox`)

If Graph says the delta token is stale/reset, the source automatically retries with a full scan.

### Sender allowlist behavior

Approved sender patterns can be:

- exact email: `parn.singh@outlook.com`
- wildcard domain: `*@eternalhotels.com`

They are parsed and validated by `src/utils/approvedSenders.ts`.

Behavior details:

- if no patterns exist, all senders are accepted
- if patterns exist, unapproved senders are skipped before persistence
- skipped unapproved attachments increment run summary counts/notes, but they are not archived as tracked attachments

### Manual reparse behavior

`reparseStoredReports()` does not re-poll Graph. It:

- clears derived report tables
- deletes generated `parsed/`, `quarantine/`, and `exports/`
- walks existing archived attachments from the database
- reparses from the archived raw files
- rebuilds exports from scratch

This makes reparsing safe for parser logic changes, but it is destructive to generated artifacts. Raw archived files remain the source of truth.

### Retry-parse behavior

`retryAttachmentParse(attachmentId)` only supports:

- status `failed` or `unsupported`
- `.pdf` attachments
- cases where the archived raw file still exists

It reparses a single attachment, rewrites parsed JSON, reinserts normalized rows for that attachment, and refreshes the affected property's latest exports.

## 10. Property identity rules

Property assignment is a mix of:

- parser-detected property name from PDF contents
- fallback property derivation from attachment filename
- dominant-property inference across a bundle when some attachments lack their own property markers
- final normalization through `ensurePropertyRef(...)`

Key helpers live in `src/utils/properties.ts`.

Important behaviors:

- unknown or missing property values collapse to:
  - name: `Unassigned Property`
  - slug: `unassigned-property`
- attachment-name fallback strips known report suffixes before slugging
- saving a property edit can rename the storage folder structure under `raw/`, `parsed/`, `quarantine/`, and `exports/`

## 11. Parser system

### How PDF parsing works

`src/pdf/PdfTextExtractor.ts` uses `pdfjs-dist` to:

- open the PDF
- extract positioned text items
- group nearby words into lines
- build a normalized `PdfDocumentText`

`src/parsers/pdfReportParser.ts` then:

- extracts visible report title, property name, and report date
- detects the report family
- dispatches to a report-specific parser
- returns normalized rows under a `ParsedReport`

`parse(bytes)` throws on unsupported reports. `analyze(bytes)` is softer and returns:

- detected property
- detected report title/date
- parsed report if supported
- `UnsupportedReportError` if the file is valid but not yet supported

### Supported report families

Current `REPORT_TYPES` list:

- `history_forecast_rows`
- `manager_flash_metric_rows`
- `reservations_made_yesterday_rows`
- `zero_rate_room_rows`
- `ar_detailed_aging_rows`
- `rate_change_rows`
- `all_night_audit_report_rows`
- `choice_audit_packet_rows`
- `best_western_daily_report_rows`
- `adjustment_refund_activity_rows`
- `all_transaction_rows`
- `room_tax_listing_rows`
- `daily_transaction_log_rows`
- `credit_card_transaction_rows`
- `closed_folio_balance_rows`
- `operator_transaction_rows`
- `advance_deposit_activity_rows`
- `booked_reservations_rows`
- `direct_bill_aging_rows`
- `direct_bill_ledger_rows`
- `final_audit_metric_rows`
- `high_balance_report_rows`
- `hotel_statistics_metric_rows`
- `in_house_guest_folio_balance_rows`
- `maintenance_summary_rows`
- `occupancy_forecast_rows`
- `rate_override_rows`
- `rate_report_rows`
- `reservation_listing_rows`
- `tax_report_rows`
- `trial_balance_report_rows`

Representative user-facing titles from `REPORT_TITLES`:

- History and Forecast
- Manager - Flash Last Day
- Reservations - made Yesterday
- Zero Rate Rooms
- AR Detailed Aging
- Rate Change Report
- All Night Audit Reports
- Daily Audit Packet
- Daily Report
- Adjustments and Refunds Activity
- All Transactions
- Room & Tax Listing
- Daily Transaction Log
- Credit Card Transactions
- Closed Folio Balances
- Operator Transactions
- Advance Deposit Activity
- Booked Reservations
- Direct Bill Aging
- Direct Bill Ledger Details
- Final Audit
- High Balance Report
- Hotel Statistics
- In House Guest Folio Balances
- Maintenance Summary
- Occupancy Forecast
- Rate Override
- Rate Report
- Reservations
- Tax Report
- Trial Balance Report

### What is intentionally out of scope today

- XLSX parsing is not implemented in v1
- unsupported PDFs are quarantined but preserved
- the parser output is normalized for staging/audit/export, not for final accounting post format

## 12. HTTP and UI surface

### Public/basic routes

- `GET /login`
- `GET /health`

### Auth routes

- `POST /api/auth/login`
- `POST /api/auth/logout`
- `GET /api/auth/me`

### Dashboard and run monitoring

- `GET /api/dashboard`
- `GET /api/runs/latest`
- `GET /api/runs/:runId`

### Property and attachment workflows

- `GET /api/properties/:propertySlug`
- `PATCH /api/properties/:propertySlug`
- `GET /api/properties/:propertySlug/exports/:reportType/latest`
- `GET /api/attachments/:attachmentId/file`
- `GET /api/attachments/:attachmentId/parsed-json`
- `GET /api/attachments/:attachmentId/parsed-csv`
- `POST /api/attachments/:attachmentId/retry-parse`

### Ingestion controls

- `POST /api/ingest/run`
- `POST /api/ingest/reparse`

### Admin settings

- `GET/PUT /api/settings/approved-senders`
- `GET/PUT /api/settings/netsuite`
- `POST /api/settings/netsuite/test`
- `POST /api/settings/netsuite/debug/metadata-catalog/export`
- `GET /api/settings/netsuite/debug/metadata-catalog/latest`
- `GET /api/users`
- `POST /api/users`
- `PATCH /api/users/:userId/password`
- `DELETE /api/users/:userId`

### Frontend structure

- `src/ui/admin-panel.html` and `src/ui/viewer-panel.html` both use the same `src/ui/admin-client.js`
- the JS bundle feature-detects which controls exist on the page and enables/disables admin-only actions accordingly
- there is no API client abstraction layer beyond the shared `fetchJson(...)` helper in the UI JS

This is useful to know because frontend changes usually mean editing:

- one HTML file
- `admin-client.js`
- `admin-panel.css`

## 13. Authentication and authorization

Auth is implemented in `src/auth/AuthService.ts`.

Key points:

- roles: `admin`, `viewer`
- session cookie name: `synchro_hrm_session`
- session TTL: 7 days
- password hashing: `scrypt`
- usernames are lowercased and validated
- viewer passwords must be at least 8 characters

Seeded admin behavior:

- a brand-new database auto-creates `admin`
- seeded password: `ehSynchroAdmin2021!`
- legacy `ehSynchroAdmin` hashes are automatically upgraded to the newer seeded password on startup

Security implication: on a new environment, the first operational step after login should be rotating that default admin password.

Production cookie behavior:

- when `NODE_ENV=production`, cookies are `Secure`
- `createApp()` also enables `trust proxy` in production

That means production login assumes HTTPS or a reverse proxy that terminates HTTPS correctly.

## 14. NetSuite integration status

NetSuite work lives in:

- `src/services/NetSuiteConnectionService.ts`
- `src/netsuite/NetSuiteClient.ts`

Current capabilities:

- save SuiteTalk REST base URL, client ID, certificate ID, JWT algorithm, and probe query
- encrypt and store the private key in SQLite state
- run a proof-of-life SuiteQL query
- export NetSuite metadata catalog rows and full schema JSON snapshots
- stage property-scoped statistical categories for NetSuite statistical account sync across parsed report families
- create property-scoped NetSuite statistical accounts with deterministic account numbers
- submit NetSuite `statisticaljournalentry` records from saved statistical previews

Current non-capabilities:

- no direct financial GL import or standard `journalEntry` posting flow
- no scheduled NetSuite reconciliation loop

Accounting direction note:

- The current NetSuite plan is statistical-only for now. Financial GL import is deferred for a later phase.
- The NetSuite page should continue listing all parsed properties so parser refinement can keep happening across the portfolio while the statistical workflow evolves.

Secret handling:

- requires `SYNCHRO_SECRET_MASTER_KEY`
- must be a base64-encoded 32-byte key
- private key PEM is encrypted using AES-256-GCM before storage

If the master key is missing or malformed, the UI can show the settings surface but secret storage will be unavailable.

## 15. Configuration and secrets

Environment variables currently used by source:

- `SYNCHRO_GRAPH_TENANT_ID` (required)
- `SYNCHRO_GRAPH_CLIENT_ID` (required)
- `SYNCHRO_GRAPH_CLIENT_SECRET` (required)
- `SYNCHRO_GRAPH_MAILBOX_USER` (optional, default `auditor@eternalhotels.com`)
- `SYNCHRO_GRAPH_MAIL_FOLDER` (optional, default `Inbox`)
- `SYNCHRO_POLL_CRON` (optional, default `0 * * * *`)
- `SYNCHRO_DATA_DIR` (optional, default `./storage`)
- `SYNCHRO_BIND_HOST` (optional, default `0.0.0.0`)
- `SYNCHRO_SECRET_MASTER_KEY` (optional for base app, required for NetSuite private-key storage)
- `SYNCHRO_APPROVED_SENDERS` (optional seed allowlist; parsed from env if present)
- `SYNCHRO_SKIP_DOTENV` (optional; disables local `.env` loading)
- `PORT` (optional, default `3000`)
- `NODE_ENV` (important for secure cookie behavior)

Notes:

- `.env.example` is the safe reference file for local setup
- local `.env` is loaded only once per process
- server deployments should keep secrets outside the repo checkout

## 16. Local development workflow

Typical local commands:

```bash
npm run dev
```

- starts `tsx watch src/index.ts`

```bash
npm run build
```

- compiles TypeScript into `dist/`

```bash
npm test
```

- builds first
- runs the large custom harness from `dist/scripts/run-tests.js`
- then runs the additional compiled test entrypoint `dist/tests/all.test.js`

```bash
npm run fixtures
```

- rebuilds parser fixtures/expectations

Useful maintenance command after parser/export logic changes:

```bash
npm run build
node dist/scripts/rebuild-latest-exports.js
```

What is not present:

- no lint script
- no formatter script
- no ORM CLI
- no container setup

## 17. Testing strategy

Testing is broader than it first looks.

### Custom harness

`scripts/run-tests.ts` covers:

- parser family recognition and row counts
- PDF extraction warning behavior
- Graph delta reset handling
- manual full-rescan behavior
- auth/login/viewer/admin route behavior
- attachment download filenames
- end-to-end example-data ingestion
- unsupported-only quarantine behavior
- retry-parse behavior

### Additional test files

`tests/all.test.ts` pulls in focused suites for:

- secrets
- config
- auth routes
- NetSuite client
- NetSuite catalog export
- NetSuite routes
- NetSuite UI smoke

### Fixture model

The test suite uses a mix of:

- `ExampleData/*.PDF` and `ExampleData/*.xlsx`
- generated expectations in `tests/fixtures/parser-expectations.json`
- some real stored fixture paths under `storage/raw/...`

Important caveat: parts of the suite intentionally skip when certain fixture directories are absent. That means "tests passed" does not always mean every optional fixture path was exercised.

## 18. Deployment model

There are two first-party deployment bundles in-repo.

### Ubuntu

Ubuntu deploy assumes:

- app checkout at `/opt/synchrohrm`
- persistent data at `/var/lib/synchrohrm`
- env file at `/etc/synchrohrm/synchrohrm.env`
- systemd service name `synchrohrm`

Install:

```bash
sudo bash deploy/ubuntu/install-server.sh
```

Update:

```bash
cd /opt/synchrohrm
sudo -u synchrohrm git pull --ff-only
sudo bash /opt/synchrohrm/deploy/ubuntu/update-app.sh
```

Or:

```bash
sudo bash /opt/synchrohrm/deploy/ubuntu/update-app.sh --pull
```

The update script:

- verifies checkout layout
- optionally runs `git pull --ff-only`
- runs `npm ci`
- runs `npm run build`
- re-renders the service unit
- reloads systemd
- restarts `synchrohrm`

### Fedora

Fedora deploy assumes:

- app checkout at `/opt/synchrohrm`
- persistent data at `/var/lib/synchrohrm`
- env file at `/etc/synchrohrm/synchrohrm.env`
- systemd service name `synchrohrm`
- `nginx` reverse proxy
- self-signed TLS cert for `synchro.eternalhotels.com`

Install:

```bash
sudo bash /opt/synchrohrm/deploy/fedora/install-server.sh
```

Update:

```bash
sudo bash /opt/synchrohrm/deploy/fedora/update-app.sh
```

Optional Git path:

```bash
cd /opt/synchrohrm
sudo -u synchrohrm git pull --ff-only
sudo bash deploy/fedora/update-app.sh
```

Or:

```bash
sudo bash /opt/synchrohrm/deploy/fedora/update-app.sh --pull
```

Fedora-specific behavior:

- `SYNCHRO_SKIP_DOTENV=1` is forced in the service unit
- the update script removes copied `node_modules` and `dist` before rebuilding
- `--pull` is blocked if the checkout is dirty
- the script refreshes both systemd and nginx config

## 19. Health checks and operational commands

Useful checks:

```bash
curl http://127.0.0.1:3000/health
```

```bash
sudo systemctl status synchrohrm
sudo journalctl -u synchrohrm -f
```

Fedora reverse proxy checks:

```bash
sudo systemctl status nginx
curl -k https://synchro.eternalhotels.com/health
```

What `/health` includes:

- service status
- configured mailbox user/folder
- data dir
- latest run summary

## 20. Current engineering gotchas

- `storage/` is the operational truth here. Be careful with deletes.
- Manual syncs default to full mailbox rescans; scheduled syncs do not.
- Duplicate attachment protection is keyed on Graph message ID + attachment ID.
- Unsupported and failed files are preserved, not discarded.
- `.xlsx` files are intentionally deferred, not broken.
- Reparse wipes generated artifacts and rebuilds them from archived raw files.
- Property rename moves folders on disk and rewrites path references in SQLite.
- There is no dedicated migration system beyond code in `Database.initialize()`.
- The frontend is intentionally simple but tightly coupled to route payload shapes.
- Production login depends on HTTPS behavior because secure cookies are enabled under `NODE_ENV=production`.

## 21. Recommended reading order for a new engineer

If someone joins this project tomorrow, this is the fastest sequence:

1. Read this report.
2. Read `src/index.ts` and `src/http/createApp.ts`.
3. Read `src/services/IngestionService.ts`.
4. Read `src/db/Database.ts`.
5. Read `src/parsers/pdfReportParser.ts` and `src/pdf/PdfTextExtractor.ts`.
6. Read `src/services/NetSuiteConnectionService.ts` if touching settings/integration work.
7. Read `deploy/ubuntu/DEPLOYMENT.md` and `deploy/fedora/DEPLOYMENT.md` if touching production paths.
8. Run:

```bash
npm run build
npm test
```

9. Inspect a real property under `storage/raw/`, `storage/parsed/`, and `storage/exports/` to see how one report moves through the system.

## 22. Suggested first-week checklist

- Confirm you can build and run tests locally.
- Open the app and log in to both admin and viewer surfaces.
- Trigger a dashboard refresh and inspect the latest run payload.
- Trace one attachment from:
  - `attachments` table
  - archived raw file
  - parsed JSON
  - normalized report table
  - `latest.csv`
- Read at least one deploy bundle end to end.
- Decide whether your upcoming task is primarily:
  - parser work
  - ingestion/runtime work
  - UI/admin work
  - deployment/ops work
  - NetSuite settings/proof-of-life work

## 23. Recent operational notes worth knowing

These are useful orientation points from recent project work and should be re-verified against the target environment before you act on them:

- NetSuite in this app is intentionally scoped to proof-of-life checks and metadata-catalog export, not full synchronization.
- A recent parser expansion added support for Best Western summary-rollup PDFs and several previously unsupported Holiday/Best Western-style operational report families.
- On Linux deployments, running the update script applies code changes and restarts the service, but it does not by itself replay previously failed historical attachments.
- Fedora deployment treats nginx + TLS as part of the supported runtime shape, not an optional extra.

## 24. Bottom line

If you remember only a few things:

- `IngestionService` is the center of gravity.
- `storage/` and `synchro-ingestion.sqlite` are the runtime truth.
- parser support and property assignment rules drive most downstream behavior.
- the UI is thin and mostly reflects database + artifact state.
- NetSuite here is configuration/probing/debug-export work, not the final accounting pipeline.
