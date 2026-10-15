# Status of the work packages

Work packages as defined in `ograf-platform-requirements.md`, section 13.

**Done**

- **BE-2** Sign-in with Twitch, and with Google (shown as "YouTube login"); separate accounts per provider, OAuth `state` checks, PKCE for Google; new accounts get the User role.
- **BE-3** Renderer and API tokens: 32 random bytes, stored AES-256-GCM encrypted, shown on demand, replaceable (the old URL stops working).
- **BE-5** Storage of the original archive and the unpacked files (once per archive, shared by all its graphics), SHA-256 checksums, UUID-based paths.
- **BE-7** OGraf Server API per account under `/<api-token>/ograf/v1`: server info, graphics, renderers, render targets, load/play/stop/update/custom actions, clear; plus the `x-actions` extension for group actions.
- **BE-8** WebSocket protocol between server and renderer pages: any number of connections per account kept in sync, on-air state stored in the database, reconnects catch up.
- **RN-1** Renderer page with CSP, own hosts for the renderer page (`RENDERER_HOST`) and for graphics (`GRAPHICS_HOST`), one sandboxed iframe per graphic, stacked in rundown order.
- **FE-1** Public catalog: search, pagination, detail pages, adding graphics to the current rundown.
- **FE-2** Rundown view: entries with labels, enable/disable, reordering, duplicating, properties, play/stop/update and live status.
- **FE-4** Private uploads wired to the ingestion pipeline and storage.
- **FE-5** Property dialog generated from the manifest schema, including GDD `order`, `label` and select labels, colour pickers (`color-rrggbb`, `color-rrggbbaa` with opacity; the last 8 colours picked in the browser are offered as quick choices), file choosers with the media library (`file-path`), SPX file lists and instructions.
- **FE-7** Group actions per rundown: steps across entries, mixed action types and sleep steps, one click to run.
- **FE-9** Renderer page: renderer and API URLs, copy, new token.
- **OPS-1** Docker Compose with the app (including the renderer), MySQL, persistent storage and a separate seed volume.
- **OPS-4** Example nginx configuration for the main, renderer and graphics hosts (see [INSTALLATION.md](INSTALLATION.md#reverse-proxy-and-sessions)).

Beyond the work packages: rundowns (several prepared events per account), the private catalog, a media library for image and file properties with hotlink protection, custom actions in the UI, interactive API documentation at `/api-docs/`, and the Grafonaut website design.

**Partly done**

- **BE-1** Schema for accounts, packages, versions, tokens, rundowns, entries and render state. Missing: the reviewer note; `review_state` and the approver flag exist but are not used yet.
- **BE-4** Upload checks (size, file count, real unpacked size, extensions, unsafe paths, symlinks, OGraf schema, `main` file, time limit). Missing: blocking re-uploads of rejected files (needs BE-9), removing scripts from SVGs (they are only served in a CSP sandbox), extraction in an isolated worker.
- **BE-6** Startup import of seed packages. Missing: seeds do not go through the hardened upload checks yet.
- **FE-3** Upload and list of private graphics. Missing: deleting packages, version history.
- **FE-6** Play/stop/update/custom actions through the public API, renderer connection count, on-air status. Missing: explicit step controls (previous step, go to step) for multi-step graphics; Play advances to the next step.
- **OPS-2** Hosts, upload limits and keys are configured by environment variables. Missing: a configurable CSP policy.
- **XC-1** Hardening and tests for uploads, tokens, sandboxing and OAuth. Missing: a formal security review.
- **XC-3** Installation, user and API documentation (see [README.md](README.md#documentation)), interactive API documentation. Missing: a guide for graphic authors.

**Not started**

- **BE-9** Publication workflow (draft, pending, published, rejected; approver actions, reviewer notes, in-app notifications).
- **BE-10** Roles and permissions (User vs. Approver).
- **FE-8** Publication management view.
- **OPS-3** CI/CD pipeline.
- **OPS-5** Access logs with redacted tokens, error tracking, monitoring.
- **XC-2** Moderation: reporting/flagging, terms of service.
