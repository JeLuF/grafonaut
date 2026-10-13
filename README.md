# OGraf Platform MVP

This is the first runnable slice of the OGraf hosting platform. It covers:

- **BE-2**: Twitch OAuth account creation and cookie session.
- **BE-5**: UUID-based package storage with original archive and extracted tree.
- **BE-6**: Startup import of `.ograf.zip` files from built-in and mounted seed directories.
- **FE-1**: Searchable public catalog UI.
- **FE-2**: My Graphics working set with independent entries, labels, enable/disable, and schema-driven property editing. Public OGraf action controls are wired but require the not-yet-implemented renderer/API backend.
- **OPS-1**: Docker Compose with Node app, MySQL, persistent storage, and a separate seed volume.

## Run with Docker

1. Copy `.env.example` to `.env` and set `SESSION_SECRET`, `TOKEN_ENCRYPTION_KEY` (`openssl rand -base64 32`) and Twitch OAuth values.
2. Set `TWITCH_REDIRECT_URI` to your public HTTPS callback URL (for example, `https://app.example.com/api/auth/twitch/callback`) and register that exact URL in Twitch.
3. Place fixed sample packages in `seeds/builtin/` and operator-provided packages in `seeds/volume/`.
4. Start the stack:

```sh
docker compose up --build
```

Open the public HTTPS hostname served by your reverse proxy. The app exposes `GET /health` and `GET /api/catalog`; these also work on `http://localhost:3000`, but production sign-in requires HTTPS.

### Proxy and sessions

The container runs in production mode and uses `Secure`, `HttpOnly`, `SameSite=Lax` signed session cookies. When nginx terminates HTTPS and forwards HTTP to the container, Express must trust the proxy to recognize the original connection as HTTPS. `TRUST_PROXY` defaults to loopback and private-network addresses; restrict it to your proxy's IP address or CIDR ranges in deployments where other clients can reach the backend. Keep the backend reachable only through trusted infrastructure, and configure nginx to overwrite forwarded headers:

```nginx
location / {
	proxy_pass http://127.0.0.1:3000;
	proxy_set_header Host $host;
	proxy_set_header X-Forwarded-Proto $scheme;
	proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
	# Renderer pages keep a WebSocket open to /render/<token>/ws
	proxy_http_version 1.1;
	proxy_set_header Upgrade $http_upgrade;
	proxy_set_header Connection $connection_upgrade;
	proxy_read_timeout 1h;
}
```

`$connection_upgrade` needs this map once in the `http` block:

```nginx
map $http_upgrade $connection_upgrade {
	default upgrade;
	''      close;
}
```

This location belongs in your existing HTTPS server configuration. Without `X-Forwarded-Proto: https` from a trusted proxy, the callback redirects successfully but cannot issue the secure session cookie. Keep `SESSION_SECRET` stable across restarts and identical across app replicas; changing it invalidates existing sessions.

### Rundowns

My Graphics entries belong to rundowns, so several events can be prepared from one account. New accounts start with a "Default rundown". The sidebar lists the rundowns; users create, rename, switch and delete them there. Deleting a rundown removes its graphics; the current rundown cannot be deleted (switch to another one first), so every account keeps at least one. The current rundown is stored per account (not per browser): added graphics go to it, and My Graphics, the renderer and the OGraf API only work with it. Switching takes the previous rundown's graphics off air; if any are loaded, the app asks for confirmation first.

### Renderer

Every account has one renderer: the page at `/render/<renderer-token>/`, used as an OBS/vMix browser source. Any number of renderer pages may be open for an account (OBS, a test tab, the preview in My Graphics); they all show the same graphics. Each page holds a WebSocket to `/render/<renderer-token>/ws`, authenticated by the token in its path, and receives the on-air state and the actions from it. The state is stored in the database, so renderers that connect later or reconnect after a restart show the same graphics.

Each graphic runs in its own sandboxed iframe. The frames are stacked in My Graphics order: the first entry is in front. Package files are served from `/render/assets/<version>/...` to the frames; HTML and SVG files are served with a CSP sandbox so they never run in the app's origin.

**Use a separate renderer host.** Set `RENDERER_HOST` to a host name that is different from the main page (`render.example.com`, optionally with a port, or a full origin such as `https://render.example.com`) and route it to the same container. Only then do graphics keep the origin of their package files, which graphics that script their own HTML pages (for example SPX templates) need. When `RENDERER_HOST` is empty, the renderer uses the main page's host and every graphic runs in an opaque origin to keep package code away from the app's session; such graphics then cannot fill their content.

The Renderer page (sidebar link) shows the renderer URL and the API URL and lets users create new tokens.

### OGraf Server API

The account's OGraf Server API lives at `https://<main host>/<api-token>/ograf/v1/`. The API token is a separate random token, so a leaked renderer URL cannot be used to control graphics. The API answers with CORS headers for any origin (the token in the path is the only credential) and returns RFC 7807 problem details for errors.

- The renderer ID is `main`; its RenderTargets are the My Graphics entries of the current rundown, identified as `{ "entryId": "<id>" }`. Each holds at most one GraphicInstance of the entry's pinned graphic version; `GET /renderers/main` lists them and the number of connected renderer pages (`status.connections`).
- Implemented: `GET /`, `GET /graphics`, `GET /graphics/{id}`, `GET /renderers`, `GET /renderers/main`, `GET /renderers/main/target`, `POST …/graphicInstance/load`, `…/playAction`, `…/stopAction`, `…/updateAction`, `…/customActions/{id}` and `PUT …/graphicInstance/clear`. `graphicId` is the package version ID. Other endpoints answer `501 Not Implemented`.
- Actions answer `503` when no renderer page is connected, `550` when the graphic's method threw, and otherwise the first renderer's result.
- Interactive documentation (Swagger UI) is served at `/api-docs/` and linked from the Renderer page. Its OpenAPI document (`/api-docs/openapi.json`) is built from `server/ograf-openapi.js`; a test checks it against the routes the API registers. For signed-in users the document's server is their own API URL, so "Try it out" works directly.
- The Play, Stop and Update buttons in My Graphics use this API: Play loads the graphic with the saved properties (if not loaded) and plays it, pressing it again advances to the next step; Stop animates out and clears the instance; Update sends the saved properties to the loaded graphic.

### Tokens

The renderer and API URLs each contain a token: 32 random bytes created with the account, permanent so the URLs can stay in browser sources and controllers. Users can create a new renderer or API token on the Renderer page if a URL leaked; every URL with the old token stops working and open renderer pages are disconnected. Tokens are stored AES-256-GCM encrypted with `TOKEN_ENCRYPTION_KEY` (32 bytes, base64 or hex; required in production) and looked up by SHA-256 hash. Keep the key outside the database and stable across restarts: if it changes, existing tokens can no longer be shown and users must create new ones.

## Local development

Requires Node.js 22 and a reachable MySQL 8 instance. Set the database variables from `.env.example`, install dependencies, and run:

```sh
npm install
npm run dev
```

The React development server runs on `http://localhost:5173`; API requests are proxied to Node on port 3000. `npm run build` creates the production frontend bundle.

For local development without HTTPS, leave `NODE_ENV` unset (or set it to `development`) and register `http://localhost:3000/api/auth/twitch/callback` as the Twitch callback URL. Development sessions do not require secure cookies.

## Seed package expectations

A seed archive can contain multiple animation manifests, either alongside each other or in nested folders. Each JSON manifest with `main` (or `mainFile`) is imported as a separate animation; entry points are resolved relative to the manifest's folder. Other JSON assets without an entry point are ignored. The importer stores the original archive and extracts it under `storage/packages/<package-uuid>/<version-uuid>/` for each animation, preserving shared assets. Repeat scans skip animations already imported, and the reported import count is the number of new animations. Seed packages are marked published for the MVP catalog.

The ingestion pipeline is intentionally not part of this MVP. Upload validation, moderation, API tokens, and rendering remain follow-up work packages.

Catalog previews use the first available image in the manifest's `thumbnails` array, resolving each `file` relative to the manifest. PNG, JPEG, WebP, GIF, APNG, and SVG are supported, including animated images. Missing or unusable thumbnails retain the initials preview. Only thumbnails belonging to published, enabled packages are served. Startup automatically adds manifest-location storage to existing databases; previously imported packages do not need to be reimported.

## My Graphics

Open **My Graphics** after signing in. Each catalog addition creates a new entry pinned to that exact version, with an independent label, enabled flag, and property state. The view also lists entries referencing the account's private uploads; creating uploads remains FE-3/FE-4. Disabled packages stay listed but cannot be enabled or controlled.

A successful catalog addition briefly lights the add button green and displays a dismissible toast. Each entry's three-dot menu offers **Show manifest** for its pinned version and **Delete**, with confirmation. Deletion removes only that working-set entry; the package and other copies remain unchanged.

Reorder entries with the drag handle or the up/down arrows. The handle also supports keyboard sorting: focus it, press Space to pick up, use the arrow keys to move, and press Space to drop or Escape to cancel. Ordering is saved per account and survives reloads; failed saves leave the displayed order unchanged. Existing lists keep their creation-time order until first reordered, and new additions follow custom-ordered entries. Startup automatically adds the ordering column to existing databases.

The property dialog is generated from the selected version's JSON `schema`. Fields marked `hidden` remain editable. Saving validates the complete state in both the form and the backend; cancelling changes nothing. Property edits only save configuration, and do not automatically send actions to a live renderer.

Authenticated working-set endpoints:

- `GET /api/my-graphics`: list the current account's entries.
- `POST /api/my-graphics`: add a published or account-owned enabled version with `{ "versionId": "<uuid>" }`; returns the new `entryId` and permits duplicate additions.
- `PUT /api/my-graphics/order`: atomically save the complete ordered list with `{ "entryIds": ["<entry-id>", "<entry-id>"] }`. Duplicate or invalid IDs are rejected; missing, foreign, or stale entries return a conflict and require refreshing the list.
- `PATCH /api/my-graphics/:entryId`: save `label` (nullable, at most 100 characters), `enabled` (boolean), and/or `schemaData` (validated against the pinned version's schema). The package version cannot be changed here.
- `DELETE /api/my-graphics/:entryId`: delete one entry owned by the current account.
- `GET /api/my-graphics/:entryId/manifest`: return the pinned version's original manifest, only to the entry owner.
- `GET /api/my-graphics/:entryId/thumbnail`: serve an available entry thumbnail, including private-upload thumbnails, only to the entry owner.

Play, stop, and update use the **public OGraf Server API**, not a separate internal action endpoint. Update sends the entire saved property state. Buttons are unavailable until BE-3/BE-7/BE-8 provide a loaded instance binding on each entry: `control: { apiBaseUrl, rendererId, renderTarget, graphicInstanceId }`. FE-2 does not issue tokens, load renderer instances, or claim actions succeeded without a real API response; renderer connectivity and step controls remain FE-6. Stop remains available for a loaded, disabled entry so it can be taken off air.

Run `npm test` for persistence, authenticated API, action-client, and React interaction tests. The UI tests compile JSX with Babel and use a DOM harness, so they do not require MySQL or native esbuild subprocesses.
