# OGraf Platform MVP

This is the first runnable slice of the OGraf hosting platform. It covers:

- **BE-2**: Twitch OAuth account creation and cookie session.
- **BE-5**: UUID-based package storage with original archive and extracted tree.
- **BE-6**: Startup import of `.ograf.zip` files from built-in and mounted seed directories.
- **FE-1**: Searchable public catalog UI.
- **FE-2**: My Graphics working set with independent entries, labels, enable/disable, and schema-driven property editing. Public OGraf action controls are wired but require the not-yet-implemented renderer/API backend.
- **OPS-1**: Docker Compose with Node app, MySQL, persistent storage, and a separate seed volume.

## Run with Docker

1. Copy `.env.example` to `.env` and set `SESSION_SECRET` and Twitch OAuth values.
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
}
```

This location belongs in your existing HTTPS server configuration. Without `X-Forwarded-Proto: https` from a trusted proxy, the callback redirects successfully but cannot issue the secure session cookie. Keep `SESSION_SECRET` stable across restarts and identical across app replicas; changing it invalidates existing sessions.

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

The property dialog is generated from the selected version's JSON `schema`. Fields marked `hidden` remain editable. Saving validates the complete state in both the form and the backend; cancelling changes nothing. Property edits only save configuration, and do not automatically send actions to a live renderer.

Authenticated working-set endpoints:

- `GET /api/my-graphics`: list the current account's entries.
- `POST /api/my-graphics`: add a published or account-owned enabled version with `{ "versionId": "<uuid>" }`; returns the new `entryId` and permits duplicate additions.
- `PATCH /api/my-graphics/:entryId`: save `label` (nullable, at most 100 characters), `enabled` (boolean), and/or `schemaData` (validated against the pinned version's schema). The package version cannot be changed here.
- `GET /api/my-graphics/:entryId/thumbnail`: serve an available entry thumbnail, including private-upload thumbnails, only to the entry owner.

Play, stop, and update use the **public OGraf Server API**, not a separate internal action endpoint. Update sends the entire saved property state. Buttons are unavailable until BE-3/BE-7/BE-8 provide a loaded instance binding on each entry: `control: { apiBaseUrl, rendererId, renderTarget, graphicInstanceId }`. FE-2 does not issue tokens, load renderer instances, or claim actions succeeded without a real API response; renderer connectivity and step controls remain FE-6. Stop remains available for a loaded, disabled entry so it can be taken off air.

Run `npm test` for persistence, authenticated API, action-client, and React interaction tests. The UI tests compile JSX with Babel and use a DOM harness, so they do not require MySQL or native esbuild subprocesses.
