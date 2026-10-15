# Development

## Local development

Requires Node.js 22 and a reachable MySQL 8 instance. Set the database variables from `.env.example`, install dependencies, and run:

```sh
npm install
npm run dev
```

The React development server runs on `http://localhost:5173`; API requests are proxied to Node on port 3000. `npm run build` creates the production frontend bundle, `npm start` runs the server alone.

For local development without HTTPS, leave `NODE_ENV` unset (or set it to `development`) and register `http://localhost:3000/api/auth/twitch/callback` as the Twitch callback URL. Development sessions do not require secure cookies, and `SESSION_SECRET` and `TOKEN_ENCRYPTION_KEY` fall back to development values.

The database schema (`db/schema.sql`) is applied at every start. Grafonaut has no data migrations yet: after schema changes, start with a fresh database.

## Tests

```sh
npm test
```

The tests cover persistence, the authenticated APIs, the OGraf Server API, uploads, tokens, sign-in, the renderer and the React views. The UI tests compile JSX with Babel and use a DOM harness, so they do not require MySQL or native esbuild subprocesses.

## Seed packages

On startup, Grafonaut imports the packages in `seeds/builtin/` (shipped with the image) and `seeds/volume/` (provided by the operator).

A seed archive can contain multiple animation manifests, either alongside each other or in nested folders. Each JSON manifest with `main` (or `mainFile`) is imported as a separate animation; entry points are resolved relative to the manifest's folder. Other JSON assets without an entry point are ignored. The importer stores the original archive and unpacks it once under `storage/archives/<archive-uuid>/`; every animation from that archive references the same files (uploads to the private catalog are stored the same way). Repeat scans skip animations already imported, and the reported import count is the number of new animations. Seed packages are marked published for the catalog. Seeds do not go through the upload checks of the private catalog.

Catalog previews use the first available image in the manifest's `thumbnails` array, resolving each `file` relative to the manifest. PNG, JPEG, WebP, GIF, APNG, and SVG are supported, including animated images. Missing or unusable thumbnails retain the initials preview. Thumbnails are addressed by graphic version (`/api/catalog/<version>/thumbnail`, also in rundowns) and served for published versions, or private versions to their owner, of enabled packages.
