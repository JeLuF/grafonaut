# Installation

How to run Grafonaut in production: Docker, configuration, sign-in providers, reverse proxy and host names. For a development setup, see [DEVELOPMENT.md](DEVELOPMENT.md).

## Run with Docker

1. Copy `.env.example` to `.env` and set the [host names](#host-names) `APP_HOST`, `RENDERER_HOST` and `GRAPHICS_HOST` (required; the stack doesn't start without them), `SESSION_SECRET` (at least 32 characters, e.g. `openssl rand -base64 48`; the app refuses to start in production without it), `TOKEN_ENCRYPTION_KEY` (`openssl rand -base64 32`) and Twitch OAuth values.
2. Set `TWITCH_REDIRECT_URI` to your public HTTPS callback URL (for example, `https://grafonaut.example.com/api/auth/twitch/callback`) and register that exact URL in Twitch.
3. Place fixed sample packages in `seeds/builtin/` and operator-provided packages in `seeds/volume/` (fonts for slides in `seeds/volume/fonts/`, see [Slides](#slides)).
4. Start the stack:

```sh
docker compose up --build
```

Open the public HTTPS hostname served by your reverse proxy. The app exposes `GET /health` and `GET /api/catalog`; `/health` also works on `http://localhost:3000` (the stack's proxy), but production sign-in requires HTTPS.

The Compose stack runs the app (including the renderer), a proxy in front of it (nginx, see [Reverse proxy](#reverse-proxy-and-sessions)), an [icon server](#icons) (Iconify) with a volume for its icon sets, MySQL 8.4, a volume for uploaded and unpacked files (`/app/storage`) and a read-only seed volume (`./seeds/volume`). The database schema is created at startup.

### Prebuilt image

Every published GitHub release builds an image and pushes it to the GitHub Container Registry (`.github/workflows/docker-release.yml`, after the tests pass). A release tagged `v0.6.0` is available as `ghcr.io/jeluf/grafonaut:0.6.0`, `:0.6` and `:latest`; pre-releases only get their exact version. A manual run in the Actions tab rebuilds the image of an existing tag. The workflow passes the version, the commit and its time into the image (build arguments `GRAFONAUT_VERSION`, `GRAFONAUT_COMMIT`, `GRAFONAUT_COMMITTED_AT`), and every image records when it was built; admins see this below the page footer. A local `docker compose up --build` shows the package version and the image build time.

To use it instead of building locally, replace `build: .` with `image: ghcr.io/jeluf/grafonaut:0.6.0` (or `:latest`) in `docker-compose.yml`, then run `docker compose pull && docker compose up -d`. While the package is private, the server needs `docker login ghcr.io` with a classic token that has the `read:packages` scope.

The image is built from the repository, so it contains no built-in seed packages (`seeds/builtin/` is not in git). Provide graphics through the `seeds/volume` mount or upload them in the private catalog.

## Configuration

All settings are environment variables, set in `.env` (see `.env.example`).

| Variable | Default | Purpose |
| --- | --- | --- |
| `SESSION_SECRET` | none (required in production) | Signs the session cookies; at least 32 characters. Keep it stable across restarts and identical across replicas; changing it signs everyone out. |
| `TOKEN_ENCRYPTION_KEY` | none (required in production) | 32 bytes, base64 or hex. Encrypts the renderer and API tokens at rest, see [Tokens](#tokens). |
| `TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET`, `TWITCH_REDIRECT_URI` | empty | Twitch sign-in; hidden unless all three are set. |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI` | empty | Google sign-in, labelled "Login with YouTube"; hidden unless all three are set. |
| `ADMIN_USERS` | empty | Accounts with the admin role, comma separated, see [Admins](#admins). |
| `APP_HOST` | none (required with Compose) | Host name of the main host, see [Host names](#host-names). |
| `RENDERER_HOST` | none (required with Compose) | Host name of the renderer page, see [Host names](#host-names). |
| `GRAPHICS_HOST` | none (required with Compose) | Host name for graphic frames, package and media files, see [Host names](#host-names). |
| `ASSET_REFERER_CHECK` | `strict` with `GRAPHICS_HOST`, else `lenient` | `strict`, `lenient` or `off`, see [Hotlink protection](#hotlink-protection). |
| `TRUST_PROXY` | `loopback,linklocal,uniquelocal` | Proxies whose `X-Forwarded-*` headers are trusted, see [Reverse proxy](#reverse-proxy-and-sessions). |
| `UPLOAD_MAX_ZIP_BYTES` | `10485760` (10 MB) | Largest package upload. |
| `UPLOAD_MAX_UNCOMPRESSED_BYTES` | `52428800` (50 MB) | Largest unpacked size of a package. |
| `UPLOAD_MAX_FILES` | `5000` | Most entries in a package. |
| `UPLOAD_ALLOWED_EXTENSIONS` | see [USER-GUIDE.md](USER-GUIDE.md#private-catalog) | Allowed file types in packages and the media library, comma separated. |
| `MEDIA_MAX_BYTES` | `20971520` (20 MB) | Largest media library upload. |
| `MCP_ENABLED` | `false` | `true` turns on the MCP interface for AI assistants at `https://<APP_HOST>/mcp`, see [MCP.md](MCP.md). |
| `MCP_ALLOWED_ORIGINS` | empty | Origins of browser-based MCP clients allowed to call `/mcp`, see [MCP.md](MCP.md). |
| `APP_PORT` | `3000` | Host port of the stack's proxy, to which your reverse proxy forwards all host names. |
| `PROXY_MAX_BODY_SIZE` | `25m` | Largest request body the stack's proxy accepts (nginx size); at least `UPLOAD_MAX_ZIP_BYTES` and `MEDIA_MAX_BYTES`. |
| `MYSQL_DATABASE`, `MYSQL_USER`, `MYSQL_PASSWORD`, `MYSQL_ROOT_PASSWORD` | see `.env.example` | Database credentials; Compose passes them to MySQL and the app. |

Docker Compose sets `MYSQL_HOST`, `MYSQL_PORT`, `STORAGE_ROOT`, `SEED_BUILTIN_DIR`, `SEED_VOLUME_DIR` and `ICONIFY_API_URL` ([Icons](#icons)) for the container itself.

## Sign-in

Users sign in with Twitch or with Google, labelled "Login with YouTube". Each login has its own account: signing in with Twitch and with Google gives two separate accounts (no linking). The YouTube button only appears when `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and `GOOGLE_REDIRECT_URI` are set; Twitch likewise needs its three `TWITCH_*` values.

For Google, create a project in the Google Cloud console (free, no billing needed), configure the OAuth consent screen (external, scopes `openid` and `userinfo.profile`, privacy policy URL) and an OAuth client of type *Web application* with the authorised redirect URI `https://<your host>/api/auth/google/callback`.

Every login attempt carries a random `state` that is kept in the signed session cookie and checked on the callback (valid for 10 minutes, usable once), which protects against login CSRF; the Google login additionally uses PKCE (S256). Cancelled or failed logins show an explanation page.

## Admins

Admins see a **Users** page (all accounts, with what each has created) and can tag the graphics of the public catalog. `ADMIN_USERS` names them, comma separated, each as `provider:login` or `provider:user-id`:

```sh
ADMIN_USERS=twitch:jeluf, google:112233445566778899
```

- Twitch accounts are given by their login (case-insensitive).
- Google accounts have no login and are given by their Google user ID, which Grafonaut stores once the person has signed in: `SELECT provider_user_id, display_name FROM accounts WHERE provider = 'google';`

The list is applied at every start and at every sign-in, so removing an entry also removes the role (after the next restart). An invalid entry stops the start with an error. The role is stored in `accounts.is_approver`.

## Reverse proxy and sessions

The Compose stack has a proxy of its own (`proxy`, nginx) in front of the app. It decides what each [host name](#host-names) serves and handles everything else Grafonaut needs from a proxy: the WebSocket of the renderer pages, long-lived connections, the upload size (`PROXY_MAX_BODY_SIZE`), the forwarded headers and the [icon server](#icons). Its configuration is `proxy/default.conf.template` (the hosts) and `proxy/app-proxy.conf` (the settings for the app). Your own reverse proxy only terminates HTTPS and forwards the three host names, unchanged, to `APP_PORT`:

```nginx
server {
	listen 443 ssl;
	server_name grafonaut.example.com render.example.com graphics.example.com;
	# ssl_certificate / ssl_certificate_key …

	location / {
		proxy_pass http://127.0.0.1:3000;
		client_max_body_size 0;                    # the stack's proxy limits uploads (PROXY_MAX_BODY_SIZE)
		proxy_set_header Host $host;
		proxy_set_header X-Forwarded-Proto $scheme;
		proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
		# Renderer pages keep a WebSocket open to /render/<token>/ws
		proxy_http_version 1.1;
		proxy_set_header Upgrade $http_upgrade;
		proxy_set_header Connection $connection_upgrade;
		proxy_read_timeout 1h;
		proxy_send_timeout 1h;
	}
}
```

`$connection_upgrade` needs this map once in the `http` block:

```nginx
map $http_upgrade $connection_upgrade {
	default upgrade;
	''      close;
}
```

The certificate must cover the three host names. Alternate names (e.g. `www.grafonaut.example.com`) are not Grafonaut's: redirect them to `APP_HOST` in your proxy. The stack's proxy answers other host names only with `/health`.

The container runs in production mode and uses `Secure`, `HttpOnly`, `SameSite=Lax` signed session cookies. Express must trust the proxies to recognize the original connection as HTTPS: your proxy must set `X-Forwarded-Proto`, which the stack's proxy passes on. Without `X-Forwarded-Proto: https`, the sign-in callback redirects successfully but cannot issue the secure session cookie. `TRUST_PROXY` defaults to loopback and private-network addresses, which covers the stack's proxy and a reverse proxy on the Docker host. Restrict it to the proxies' addresses or CIDR ranges in deployments where other clients can reach the backend, and keep `APP_PORT` reachable only through your reverse proxy: anyone who can reach it directly can claim to be on HTTPS. For example, publish it on the loopback interface only, `"127.0.0.1:${APP_PORT:-3000}:80"` in `docker-compose.yml`.

**More services.** Further services of the stack get a `location` in `proxy/default.conf.template`, like the icon server. Your own reverse proxy stays as it is.

### Upgrading from 0.8 and older

The host setup changed, and the stack needs changes in `.env` and in your reverse proxy:

1. `APP_HOST`, `RENDERER_HOST` and `GRAPHICS_HOST` are required, one host name each, without `https://` or a port. `APP_HOST` no longer takes a list: redirect alternate names in your proxy.
2. `MCP_BASE_URL` is replaced by `MCP_ENABLED=true`; the MCP interface is at `https://<APP_HOST>/mcp` as before. Connected AI apps keep working if `MCP_BASE_URL` was `https://<APP_HOST>`.
3. Replace the `server` blocks of the renderer and graphics hosts and the `location /render/` of the main host with the single `server` block above. The stack's proxy now does what they did.
4. The app no longer publishes a port of its own; the stack's proxy listens on `APP_PORT`.

## Host names

Grafonaut uses three host names, all pointing to the same stack:

| Host | Example | Serves | Setting |
| --- | --- | --- | --- |
| Main host | `grafonaut.example.com` | the app, its API, the OGraf Server API, the MCP interface and the icon server `/iconify/` | `APP_HOST` |
| Renderer host | `render.example.com` | the renderer page `/render/<token>/` and its WebSocket | `RENDERER_HOST` |
| Graphics host | `graphics.example.com` | graphic frames `/render/frame`, package files `/render/assets/…`, media files `/render/media/…` | `GRAPHICS_HOST` |

Each setting is one host name, without scheme or port; the three must differ. The stack's proxy (`proxy/default.conf.template`) serves each host only its paths: the renderer and graphics hosts redirect everything else to the main host, the renderer page on the graphics host and graphics paths on the renderer host get `404`, and so does `/render/` on the main host. The app checks the same rules again and answers `404` when a path is requested on the wrong host.

Without the Compose stack (development, `npm start`), the three settings are optional: without them, everything is served on one host and graphics run in an opaque origin (see below). There a host may carry a port, e.g. `render.localhost:3000`.

**Why a graphics host.** Graphics are uploaded code. Graphics that script their own HTML pages (for example SPX templates) must share an origin with their package files, so their frames cannot run in an opaque origin. On the graphics host, that origin belongs to graphics alone: package code can neither use the signed-in user's session (main host) nor read the renderer page, whose URL carries the renderer token (renderer host). The renderer page talks to the graphic frames with `postMessage` only. Without `GRAPHICS_HOST`, every graphic runs in an opaque origin; such graphics then cannot fill their content. Graphics on the same renderer still share the graphics origin with each other.

The session cookie is bound to the main host, so it is never sent to the renderer or graphics host. Changing API requests must come from the main host's own origin (`Origin`/`Sec-Fetch-Site` check), so pages on the other hosts cannot use a signed-in user's session even though they are same-site.

## Hotlink protection

Package files (`/render/assets/…`) and media files (`/render/media/…`) are not served when the request's `Referer` names another site than the renderer or graphics host, a host in `APP_HOST` or the requested host itself; such requests get `403`. Media files are always served to requests without `Referer` (direct downloads). Renderer pages and graphic frames send only their origin as referrer (`Referrer-Policy: strict-origin`), never the token path. `ASSET_REFERER_CHECK` sets the mode for package files (for media files, only `off` applies):

- `strict` (default with `GRAPHICS_HOST`): requests without `Referer` are refused as well.
- `lenient` (default without `GRAPHICS_HOST`): requests without `Referer` are served, foreign referers are refused. Without a graphics host, graphics run in an opaque origin, and browsers send no `Referer` for their images and nested pages.
- `off`: no check.

The check stops other web pages from embedding the files; it is not access control, since anyone can send any `Referer` with a direct request.

## Slides

Slides from the slide editor are rendered to PNG on the server, with `canvas` (node-canvas) in a separate Node process that gets none of the app's settings or secrets. The Docker image is based on Debian (`node:…-trixie-slim`) because `canvas` ships prebuilt binaries for it; on Alpine it would have to be compiled.

**Fonts.** The editor offers exactly the fonts the server has, under their real names, and loads the same font files from the server, so text in the editor looks as it will in the PNG. The Docker image brings Liberation Sans, Liberation Serif and Liberation Mono (same character widths as Arial, Times New Roman and Courier New). Outside the image, Grafonaut takes the Croscore fonts (Arimo, Tinos, Cousine) or URW's Nimbus fonts instead, one family each for sans, serif and monospace text. At startup the server logs the fonts it found (`Slide fonts: …`); "none found" means slides are rendered with a fallback font.

Slides made before, or elsewhere, may use Arial, Helvetica, Times New Roman or Courier New. When such a slide is opened, saved or uploaded, it switches to the server's family with the same character widths (e.g. Liberation Sans), so the text keeps its layout. Fonts added with the editor's Google Fonts import ("+ Import fonts…") are saved in the slide; the server downloads them from Google Fonts (`fonts.googleapis.com`, `fonts.gstatic.com`) the first time a slide uses them and keeps them in `<STORAGE_ROOT>/slide-fonts`, so later renders need no network access. A slide using any other font the server doesn't have, or a Google Font that can't be downloaded (e.g. a server without internet access), is rendered with a fallback font; Grafonaut says so after saving or uploading it. A font is downloaded once: to get a newer version from Google, delete its folder in `slide-fonts` and restart the app.

More fonts go into the `fonts` folder of the seed volume (`seeds/volume/fonts/`, i.e. `<SEED_VOLUME_DIR>/fonts`); restart the app after changing them. These fonts are registered for rendering and offered in the editor, which loads the same files from `/api/slides/fonts/…`.

- `.ttf` or `.otf` files. The family, weight and style are read from the files, so the file names don't matter. WOFF/WOFF2 files don't work for rendering.
- Google Fonts: put the embed code from fonts.google.com (the `@import` or `<link>` lines, as offered under "Get embed code") into `google-fonts.txt` in that folder. At startup the fonts are downloaded from Google once and kept in `<STORAGE_ROOT>/seed-fonts`; later starts use those files without network access. Fonts that can't be downloaded are logged (`Slide font … could not be downloaded`) and left out. To get a newer version of a font, delete `seed-fonts` and restart.

**Safety.** Slides are uploaded by users and rendered on the server. A slide may only contain embedded images (`data:image/…`); slides with other image URLs are refused, and the rendering process loads nothing from the network or the disk except the slide's Google Fonts (only from Google's font hosts, with a timeout and a size limit, into `slide-fonts`) and the icon search of the MCP tools ([Icons](#icons)). Slides are limited to 4096 × 4096 pixels, and rendering one may take at most 30 seconds; a render that takes longer is stopped by killing that process (a new one starts for the next slide), so the app itself keeps running.

## Icons

The slide editor and the slide tools of the [MCP interface](MCP.md) search icons with the [Iconify API](https://iconify.design/docs/api/). The Compose stack runs its own Iconify server (`iconify`, image `iconify/api`) with all free icon sets, so there are no rate limits and no search words leave the installation:

- The editor in the browser uses it at `https://<APP_HOST>/iconify/`, through the stack's proxy (read-only: `GET` only).
- The slide renderer uses it directly, `ICONIFY_API_URL=http://iconify:3000` (set in `docker-compose.yml`).

Without `ICONIFY_API_URL` (e.g. `npm start` in development), both use the public API at `api.iconify.design`, which sees the users' IP addresses and search words and limits how many requests it answers. The icon server downloads its icon sets (the npm package `@iconify/json`) into the volume `iconify-cache`. At every start it asks npm for a newer version and downloads only that; restart it (`docker compose restart iconify`) to get new icons. The first start takes a while longer, until the download has finished.

## Tokens

Renderer and API tokens are stored AES-256-GCM encrypted with `TOKEN_ENCRYPTION_KEY` (32 bytes, base64 or hex; required in production) and looked up by SHA-256 hash. Keep the key outside the database and stable across restarts: if it changes, existing tokens can no longer be shown and users must create new ones on the Renderer and API pages.

Renderer and API URLs carry their token in the path. Keep them out of access logs that others can read, or redact them there.
