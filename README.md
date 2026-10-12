# OGraf Platform MVP

This is the first runnable slice of the OGraf hosting platform. It covers:

- **BE-2**: Twitch OAuth account creation and cookie session.
- **BE-5**: UUID-based package storage with original archive and extracted tree.
- **BE-6**: Startup import of `.ograf.zip` files from built-in and mounted seed directories.
- **FE-1**: Searchable public catalog UI.
- **OPS-1**: Docker Compose with Node app, MySQL, persistent storage, and a separate seed volume.

## Run with Docker

1. Copy `.env.example` to `.env` and set `SESSION_SECRET` and Twitch OAuth values.
2. Register the callback URL in Twitch as `http://localhost:3000/api/auth/twitch/callback`.
3. Place fixed sample packages in `seeds/builtin/` and operator-provided packages in `seeds/volume/`.
4. Start the stack:

```sh
docker compose up --build
```

Open `http://localhost:3000`. The app exposes `GET /health` and `GET /api/catalog`.

## Local development

Requires Node.js 22 and a reachable MySQL 8 instance. Set the database variables from `.env.example`, install dependencies, and run:

```sh
npm install
npm run dev
```

The React development server runs on `http://localhost:5173`; API requests are proxied to Node on port 3000. `npm run build` creates the production frontend bundle.

## Seed package expectations

A seed archive can contain multiple animation manifests, either alongside each other or in nested folders. Each JSON manifest with `main` (or `mainFile`) is imported as a separate animation; entry points are resolved relative to the manifest's folder. Other JSON assets without an entry point are ignored. The importer stores the original archive and extracts it under `storage/packages/<package-uuid>/<version-uuid>/` for each animation, preserving shared assets. Repeat scans skip animations already imported, and the reported import count is the number of new animations. Seed packages are marked published for the MVP catalog.

The ingestion pipeline is intentionally not part of this MVP. Upload validation, moderation, API tokens, rendering, and My Graphics actions remain follow-up work packages.
