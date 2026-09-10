# OGraf Hosting & Rendering Platform — Requirements

## 1. Purpose

A SaaS platform where users can browse, upload, publish, and control **OGraf** broadcast
graphics (per the EBU OGraf v1 Graphics & Server API specifications), without needing
their own renderer infrastructure. Each account gets a personal, token-scoped OGraf
Server API endpoint that can be pointed at from OBS, vMix, CasparCG, or any other
OGraf-compatible controller.

## 2. Deployment

- Deployed via **Docker Compose**.
- Runs behind an **nginx reverse proxy external to the project** (i.e. not part of this
  project's own Compose stack), so the host can be shared with other, unrelated web
  applications.
- **Content and renderer are served from different hostnames** (e.g. `app.example.com`
  for the Control UI/API vs. `render.example.com` for rendered graphics) — this is what
  makes the sandboxing requirement in §9 actually enforceable at the browser level
  (separate origin ⇒ no shared cookies/storage by default).
- Hostnames/subdomain scheme and the CSP policy are **runtime configuration**, not
  hardcoded — set via environment variables per deployment, so the same image can be
  deployed under different domains without a rebuild.
- **Technology stack**: backend on **Node.js**; frontend (Control UI, dashboards,
  catalog, Publication Management) built with **React**.
- **Seed/sample graphics on startup**: on startup, the application scans two
  directories for `.ograf.zip` files and imports any it finds into the catalog, so a
  set of sample graphics is available immediately after deployment with no manual step:
  - one directory is **built into the container image** (ships fixed sample packages
    as part of the image itself);
  - the other is a **runtime-mounted volume**, distinct from the persistent data volume
    used for already-imported/uploaded graphics — this lets an operator drop in
    additional or updated sample packages without rebuilding the image, while keeping
    that mount clearly separate from user-uploaded content.
  - This replaces the earlier "script to install platform-provided graphics" idea —
    import happens automatically as part of application startup, not as a separate
    manual/install-time script.

## 3. Core User-Facing Features

- **Authentication** via Twitch OAuth.
- **Public catalog** of OGraf graphics that any user can browse.
- **Private uploads**: users can upload their own `.ograf.zip` packages.
- **Publish/unpublish**: a private upload can optionally be submitted for publishing to
  the public catalog (subject to manual review — see §11).
- **"My Graphics" view** *(distinct from the Publication Management view below)*: shows
  every graphic the user has added to their own working set — both graphics they've
  selected from the public catalog and ones they've uploaded themselves. **The same
  catalog or private graphic can be added more than once**, as independent entries —
  e.g. keeping a separately-configured "left-aligned" and "right-aligned" instance of
  the same lower-third package for two different hosts, switchable instantly without
  re-editing properties each time. Each such entry has:
  - an **enable/disable** action,
  - access to its own **schema property dialog** (a generated form, from the manifest's
    JSON `schema`, to set/edit its data fields — player names, roles, colors, etc. —
    without hand-crafting `load`/`updateAction` REST payloads), independent of any
    other entry using the same underlying package,
  - **play/stop/update action triggers** (the Control UI).
  - There is no limit, for now, on how many entries a user can have.
- **Combined/grouped actions**: since a human operator clicking separate action
  buttons in sequence can't reliably trigger them at the same instant, the Control UI
  lets a user define a named group of actions across multiple entries, mixing
  different action types within one group — e.g. a single click can "stop 'lower
  third', play 'coming next'". This is purely a Control UI convenience — it is not
  needed as a distinct primitive in the OGraf Server API itself, since an API-driven
  controller can already fire the equivalent calls in quick succession.
- **Publication Management view** *(distinct from "My Graphics")*: handles the
  submit-for-review / approve / reject workflow for private uploads (see §4 and §11).

## 4. Roles & Permissions

- **User** (default role for any authenticated account):
  - Browses the public catalog and can add published catalog graphics, as well as
    their own uploads, to their "My Graphics" working set (§3).
  - Can upload, disable, and submit-for-publish their own packages.
  - Within Publication Management, sees the review status of their own submissions —
    pending, published, or **rejected** (explicitly labeled, with the reviewer's
    feedback note when rejected — see §11) — not hidden once rejected.
- **Approver** (elevated role, **additive to User** — a single Twitch account can be
  both User and Approver at once; it is not a separate, exclusive account type):
  - Has access to an approver view within Publication Management listing all
    **pending** publish requests.
  - Can **Approve** (moves the version into the public catalog; an optional note may
    be attached) or **Reject** (moves it to rejected; a note is required, so the user
    always gets an explanation) each pending request.

## 5. Account & API

- Each account has an **account-specific API token** for its OGraf Server API endpoint.
- Base URL uses a **path-based scope**, e.g. `https://ograf-renderer.com/<token>/ograf/v1/...`
  — confirmed spec-compliant: the Server API spec explicitly allows any base URL/path
  prefix, and deliberately leaves auth/multitenancy up to the vendor.
- Token must be stored **encrypted at rest, and recoverable** — not one-way hashed.
  Unlike, say, an AWS credential, this token's blast radius is limited to controlling
  that account's own stream overlays; it can't cause financial or infrastructure
  damage, so the tradeoff favors the same approach Twitch itself uses for stream
  keys: encrypt with a server-held key (kept outside the database, e.g. in a secrets
  manager or environment variable — never alongside the ciphertext it protects) so
  the platform can decrypt and redisplay the full token/base URL in settings on
  demand, rather than forcing a show-once/regenerate-if-lost flow.
- Still generated with sufficient entropy (32+ random bytes) — encryption protects
  the token at rest, it isn't a substitute for the token itself being unguessable.
- **Logging**: since the token lives in the URL path, it would otherwise leak into
  access logs and `Referer` headers as a bearer credential. Instead, access-log
  middleware must redact the token path segment and log the **resolved Twitch account
  name** in its place, so logs stay useful for diagnostics without ever persisting a
  usable token.
- Add CORS headers (`Access-Control-Allow-Origin/Methods/Headers`, etc.) since the
  browser-based Control UI (and any third-party controller) will call the API
  cross-origin.
- **Architecture principle**: the OGraf Server API is the *only* control surface. The
  platform's own browser Control UI and any third-party controller (e.g. a Stream Deck
  via a Companion plugin) are both just clients of this same public API — there is no
  separate privileged/internal-only control path.

## 6. Package Ingestion (Upload → Publish)

- **Server-side unzipping is required** (schema properties must be extracted server-side
  to drive the property dialog and REST API — pure client-side hosting isn't sufficient),
  despite zip files being a common exploit vector. Mitigations below are mandatory, not optional.
- **Zip-slip protection**: reject any entry whose resolved path escapes the package root
  (`../`, absolute paths, symlinks) — resolve and verify, don't just `path.join` and trust it.
- **Size and count limits**:
  - Uploaded `.zip` file: **10 MB max**.
  - Uncompressed package size: **50 MB max**.
  - No separate compression-ratio cap is needed: the 50 MB uncompressed cap is
    sufficient *provided* it's enforced by tracking actual bytes written during
    streaming decompression and aborting immediately once the running total crosses
    50 MB — not by trusting the (spoofable) uncompressed-size field in the zip's
    central directory, and not by measuring only after full extraction has completed.
    Enforced that way, worst-case resource use is bounded to ~50 MB regardless of the
    claimed or actual compression ratio.
  - **File count: 5,000 entries max.** This is a separate guard from the byte-size cap
    — it protects against filesystem/inode and per-file processing overhead from an
    archive containing a huge number of tiny files, which the byte cap alone doesn't
    address.
- **File extension allowlist** — only these are accepted anywhere in the package:
  `.json`, `.mjs`, `.js`, `.jpg`, `.jpeg`, `.png`, `.apng`, `.webp`, `.gif`, `.svg`,
  `.mp3`, `.mp4`. Anything else in the archive causes the upload to be rejected.
- **Manifest validation**: validate the extracted manifest against the official OGraf
  JSON Schema before trusting any of its contents.
- **`main` path validation**: the manifest's `main` field is just as attacker-controlled
  as any zip entry — resolve it against the extracted root and confirm it points at a
  real file inside the package before use.
- **Resource limits on extraction**: run extraction with a timeout, ideally in a
  resource-capped worker/subprocess.
- **Asset sanitization**: uploaded SVGs in particular can carry script payloads; strip
  scripts on ingest, and always serve extracted assets with a forced `Content-Type` and
  `X-Content-Type-Options: nosniff`.
- **No re-submission of an identical file**: if an uploaded zip's checksum (§7) matches
  one that was previously rejected, the upload is refused outright rather than being
  queued for review again.
- **Manual review before publish**: publishing to the public catalog requires an
  explicit Approver review/approval step (§4) — it is not automatic on upload, even
  though the package has already passed automated validation. Private (unpublished) use
  is not gated by this review.

## 7. Storage

- Store **both** the original `.ograf.zip` (source of truth, checksumming, re-validation,
  re-download) **and** the extracted/unpacked tree (fast static serving, CDN-friendly).
- Store a SHA-256 checksum of the original zip for integrity checks, duplicate
  detection, and the rejected-resubmission check in §6.
- **Path naming**: use internally generated identifiers (not manifest-supplied values
  like the package's declared `id`) for all filesystem/URL paths of the `.mjs` and
  assets — e.g. `/storage/packages/<pkg-uuid>/<version-uuid>/...`.
- **Version immutability**: each upload is a new immutable version keyed by its own
  UUID. "Publish" only changes which version the catalog points to as current/default.
  A running render instance keeps using the version it loaded until explicitly updated —
  republishing must not silently change what's live mid-broadcast.
- The seed-import directories (§2) are kept separate from this data volume; imported
  seed packages are copied/ingested into the normal storage layout like any other
  upload, they just originate from those two source directories instead of a user's
  browser upload.

## 8. Database

- **MySQL** backend.
- Expected core tables (not finalized): accounts (incl. role — User, or User+Approver),
  packages, package versions, catalog entries (publish/review state: draft, pending,
  published, rejected, disabled; optional/required reviewer note), API tokens, active
  render instances/connections.
- **"My Graphics" entries** need their own table (not a simple selection/junction
  table): each row is one user's addable entry — referencing a package version, an
  independent copy of the schema data, an enabled flag, and an optional label (e.g.
  "Left" / "Right") — because the same package version can be added by the same user
  **multiple times** as independent, separately-configured entries. Each entry
  corresponds to one addressable graphic instance in the OGraf Server API/renderer
  (see §10).

## 9. Security: Sandboxing the Rendered Graphic

- An OGraf package's `.mjs` is arbitrary third-party JavaScript executed in a browser —
  this is a real supply-chain XSS vector ("upload arbitrary code, other people run it"),
  not a hypothetical.
- The rendered graphic **must not share an origin, cookies, or storage** with the
  Control UI / account session. This is enforced by serving content and renderer from
  **different hostnames** (§2), cookieless on the render host, with a strict CSP, and
  `sandbox` attributes if embedded via iframe.
- The Control UI communicates with the sandboxed render surface only via `postMessage`
  or a dedicated WebSocket protocol — never via shared browser storage/auth state.

## 10. Real-Time Architecture

- The actual Web Component execution happens in a browser surface (e.g. an OBS/vMix
  Browser Source) pointed at a URL served by the platform — this is distinct from the
  Control UI.
- That render page needs a persistent connection (WebSocket) back to the server so that
  REST API calls (`playAction`, `stopAction`, `updateAction`, etc.) can be forwarded to
  whichever render-page instance is currently connected for a given token, in real time.
- Requires an **instance/connection registry**: which token maps to which live
  render-page socket(s), reconnect handling, and an explicit "no renderer currently
  connected" state for the Control UI/API to report.
- **Multiple concurrent instances per account**: because the same package can be added
  multiple times in "My Graphics" (§3/§8), an account is not limited to one active
  graphic instance — the registry, the Server API's instance addressing, and the render
  host itself (a render page can host more than one live Web Component instance at
  once, or an operator can point several render pages/Browser Sources at different
  instances — either is a valid deployment pattern) must all support many concurrent,
  independently addressable instances per account.
- **Multiple simultaneous renderer connections per account**: an account is not limited
  to a single connected renderer either. Realistic cases include running the renderer
  live in OBS while separately testing it in a plain browser tab at the same time, or
  driving several projectors/screens at a venue off one account. The WebSocket design
  must track a *set* of connected renderer sockets per token, not a single one, with
  independent connect/disconnect/reconnect per socket. **All renderers for an account
  stay in sync**: every action broadcasts to all currently connected renderer sockets
  for that token, so e.g. a venue's projectors and any test browser tab always show
  the same state — there is no per-connection targeting.

## 11. Moderation (Public Catalog)

- **Manual review before publish** (§6, performed by an Approver per §4) is the primary
  gate. **No SLA** on review turnaround.
- **Reviewer notes**: optional on approval, **required** on rejection, so the
  submitting user always receives an explanation.
- **Notifications are in-app only** — no email integration.
- **No re-submission** of the exact same rejected `.ograf.zip` file (§6); a fixed
  package must be uploaded as a new file to be reviewed again.
- The "disable" feature (§3/§4) serves as the post-publish kill-switch mechanism,
  separate from the review gate.
- Still useful, not yet scoped: a lightweight reporting/flagging flow and Terms of
  Service, since public HTML/JS uploads are also a vector for phishing pages or
  off-topic content once served from the platform's own domain, even after passing
  initial review.

## 12. Schema / Control UI Details to Get Right

- The manifest schema's `hidden` property attribute only affects whether a field is
  used when auto-generating a **display label** for a graphic instance in a GUI — it is
  *not* an instruction to omit the field from the property-editing dialog.
- `updateAction`'s `data` is documented as a potentially **partial** update. Decide
  explicitly whether the Control UI always sends the full current state (simpler, always
  valid) or computes diffs.
- Build step controls generically off the manifest's `stepCount` rather than assuming
  every package is a simple single play/stop toggle: `stepCount` can be `0` (no steps,
  auto play-and-out), `1`/undefined (single step), `>1` (known multi-step), or `-1`
  (dynamic/unknown number of steps) — each implies different Control UI behavior.

## 13. Work Packages

Grouped by area; roughly in dependency order within each group.

### Backend / Data

| ID | Work Package | Scope |
|---|---|---|
| BE-1 | DB schema & migrations | Accounts (incl. role), packages, versions, catalog/review state (incl. reviewer note), tokens, render instances, "My Graphics" per-instance table (supports multiple entries per user per package version) |
| BE-2 | Twitch OAuth integration | Login, session/account creation, default role assignment |
| BE-3 | API token issuance | Generate, encrypt (reversible, server-held key) & store, decrypt-on-demand for display, regenerate |
| BE-4 | Ingestion pipeline | Upload endpoint; zip-slip, size/count/extension checks; manifest schema validation; `main`-path validation; asset sanitization; rejected-checksum resubmission block; storage write |
| BE-5 | Storage layer | Original zip + extracted tree persistence, checksum, path-by-UUID scheme |
| BE-6 | Seed-graphics startup import | On startup, scan the image-built-in directory and the runtime-mounted seed volume for `.ograf.zip` files and import them through the same ingestion pipeline |
| BE-7 | OGraf Server API implementation | Public REST endpoints per the OGraf Server API spec (load/play/stop/update/customAction), scoped by account token/path prefix — the same API used directly by third-party controllers (e.g. Stream Deck/Companion) and by the platform's own Control UI |
| BE-8 | WebSocket protocol & instance registry | Render-page ↔ backend messaging (lifecycle + actions); token → *set* of live renderer-connection sockets (not just one); per-account multi-instance addressing; every action broadcasts to all connected renderer sockets for that token, keeping them in sync; reconnect handling |
| BE-9 | Publication workflow backend | State machine (draft → pending → published/rejected), Approver actions incl. reviewer notes, in-app notifications |
| BE-10 | Roles & permissions enforcement | User vs. Approver (additive) authorization checks across all endpoints |

### Rendering

| ID | Work Package | Scope |
|---|---|---|
| RN-1 | Sandboxed render host | Separate hostname/origin, CSP, page that dynamically imports the Web Component and wires it to the WebSocket protocol; supports multiple concurrent Web Component instances and being connected simultaneously alongside other renderer instances of the same account (e.g. OBS + a browser test tab, or several venue screens) |

### Frontend

| ID | Work Package | Scope |
|---|---|---|
| FE-1 | Public catalog UI | Browse/search published graphics; "add to My Graphics" action (repeatable — no limit, for now, on how many times or how many total entries) |
| FE-2 | "My Graphics" view | List of entries (catalog- or upload-sourced; same package addable multiple times); per-entry enable/disable, label, property dialog, play/stop/update triggers |
| FE-3 | UI for private graphics (upload/management) | Upload, list, delete, version history for a user's own packages |
| FE-4 | Backend integration of private graphics | Wiring the above UI to ingestion/storage/API endpoints |
| FE-5 | Schema-driven property dialog | Auto-generate an edit form from a manifest's JSON `schema`, scoped to one "My Graphics" entry's own data |
| FE-6 | Renderer's Control UI | Play/stop/update/step controls per graphic instance, built as a client of the public OGraf Server API; reflects which/how many renderer connections are currently live for the account |
| FE-7 | Combined/grouped actions | Let a user define a named group ("macro") of actions across multiple "My Graphics" entries, mixing different action types within one group (e.g. "stop 'lower third', play 'coming next'"), triggerable with a single click; purely a Control UI feature, no new API primitive required |
| FE-8 | Publication Management view | Submit-for-review + status display (incl. rejected + reviewer note) for Users; pending-queue + approve/reject (with reviewer note) for Approvers |
| FE-9 | Account/token settings UI | View full API token & base URL anytime (decrypted from storage on demand); copy action; regenerate creates a new token and invalidates the old one |

### Ops / Infrastructure

| ID | Work Package | Scope |
|---|---|---|
| OPS-1 | Docker Compose setup | App backend, render host, MySQL, any worker/queue, seed-volume mount, defined services & networking |
| OPS-2 | Runtime configuration | Env-var-driven hostnames, CSP policy, size/count/extension limits, etc. |
| OPS-3 | Deployment pipeline | CI/CD: build, test, image publish, deploy |
| OPS-4 | External reverse-proxy integration | Example nginx config/docs for the host-shared, external-to-the-project proxy |
| OPS-5 | Logging & monitoring | Access logs with token redacted and replaced by resolved Twitch account name; error tracking; instance-connection health |

### Cross-Cutting

| ID | Work Package | Scope |
|---|---|---|
| XC-1 | Security review | Ingestion hardening validation, sandbox-escape testing, token handling audit, CSP audit |
| XC-2 | Moderation tooling | Reporting/flagging flow, ToS |
| XC-3 | Documentation | Deployment/ops docs, API docs for account holders, contribution docs for catalog authors |

## 14. Open Questions / Next Steps

None outstanding at the moment — all prior questions have been resolved above.
