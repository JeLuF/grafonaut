# API

Grafonaut has two APIs: the **OGraf Server API**, a public, token-authenticated API per account for controllers, and the **app API** under `/api`, used by the web app with the session cookie.

## OGraf Server API

Grafonaut implements the [OGraf Server API](https://ograf.ebu.io) for every account. The account's API lives at `https://<main host>/<api-token>/ograf/v1/`; the URL is shown on the Renderer page. The API token is a separate random token, so a leaked renderer URL cannot be used to control graphics. The API answers with CORS headers for any origin (the token in the path is the only credential) and returns RFC 7807 problem details for errors.

- The renderer ID is `main`; its RenderTargets are the entries of the current rundown, identified as `{ "entryId": "<id>" }`. Each holds at most one GraphicInstance of the entry's pinned graphic version; `GET /renderers/main` lists them and the number of connected renderer pages (`status.connections`).
- Implemented: `GET /`, `GET /graphics`, `GET /graphics/{id}`, `GET /renderers`, `GET /renderers/main`, `GET /renderers/main/target`, `POST …/graphicInstance/load`, `…/playAction`, `…/stopAction`, `…/updateAction`, `…/customActions/{id}` and `PUT …/graphicInstance/clear`. `graphicId` is the package version ID. Other endpoints answer `501 Not Implemented`.
- Instances follow the OGraf step model: a graphic with `stepCount: 0` is played once and animates out by itself, so after a successful play it is *ended*, not on air. A graphic that reported a step before and returns no `currentStep` from a play has reached its end as well. Graphics that never report a step stay on air until stopped. Graphic instances report `playing` and `ended` in addition to the specification's fields.
- Custom actions (`…/graphicInstance/customActions/{id}`) must be declared in the graphic's manifest (`customActions`), otherwise `404`. If the action declares a `schema`, the payload is validated against it (`400` with `errors`).
- Actions answer `409` for disabled entries (stop and clear still work), `503` when no renderer page is connected, `550` when the graphic's method threw, and otherwise the first renderer's result.

### Extension: group actions

- `GET /x-actions` lists the group actions of the current rundown with their steps.
- `POST /x-actions/{id}` runs one and answers when its steps are done, listing failed steps (`409` while it is already running, `503` without a connected renderer). Play and custom-action steps load the graphic with the entry's saved properties when needed.

Controllers that only implement the standard OGraf Server API work without the extension.

### Interactive documentation

Swagger UI is served at `/api-docs/` and linked from the Renderer page. Its OpenAPI document (`/api-docs/openapi.json`) is built from `server/ograf-openapi.js`; a test checks it against the routes the API registers. For signed-in users the document's server is their own API URL, so "Try it out" works directly.

## App API

Endpoints of the web app under `/api`. They need the session cookie; changing requests must come from the app's own origin.

**Current rundown's entries** (the paths keep their original name):

- `GET /api/my-graphics`: list the current rundown's entries.
- `POST /api/my-graphics`: add a published or account-owned enabled version to the current rundown with `{ "versionId": "<uuid>" }`; returns the new `entryId` and permits duplicate additions.
- `PUT /api/my-graphics/order`: atomically save the complete ordered list with `{ "entryIds": ["<entry-id>", "<entry-id>"] }`. Duplicate or invalid IDs are rejected; missing, foreign, or stale entries return a conflict and require refreshing the list.
- `PATCH /api/my-graphics/:entryId`: save `label` (nullable, at most 100 characters), `enabled` (boolean), and/or `schemaData` (validated against the pinned version's schema). The package version cannot be changed here.
- `POST /api/my-graphics/:entryId/duplicate`: copy an entry of the current rundown directly below the original; returns the new `entryId`.
- `DELETE /api/my-graphics/:entryId`: delete one entry owned by the current account.
- `GET /api/my-graphics/:entryId/manifest`: return the pinned version's original manifest, only to the entry owner.

**Other endpoints:**

- Rundowns: `GET`/`POST /api/rundowns`, `PATCH`/`DELETE /api/rundowns/:id`, `PUT /api/rundowns/current`.
- Group actions of the current rundown: `GET`/`POST /api/group-actions`, `PATCH`/`DELETE /api/group-actions/:id`; steps must reference entries of the current rundown.
- Private catalog: `GET`/`POST /api/private/packages` (the `.ograf.zip` is the request body).
- Media library: `GET`/`POST /api/media` (the file is the request body, its name the `name` query parameter), `PATCH`/`DELETE /api/media/:id`, `PUT /api/media/:id/content` (replace, same file type), `GET /api/media/:id/content`.
- Tokens: `GET /api/tokens/:kind` shows the renderer or API URL, `POST /api/tokens/:kind` creates a new token (`kind` is `renderer` or `api`).
- Catalog: `GET /api/catalog`, `GET /api/catalog/:versionId`, `…/manifest`, `…/thumbnail`, `…/thumbnails/:index`.
- Sign-in: `GET /api/auth/providers`, `GET /api/auth/me`, `GET /api/auth/twitch`, `GET /api/auth/google` and their callbacks.
