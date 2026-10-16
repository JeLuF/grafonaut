# Installation

How to run Grafonaut in production: Docker, configuration, sign-in providers, reverse proxy and host names. For a development setup, see [DEVELOPMENT.md](DEVELOPMENT.md).

## Run with Docker

1. Copy `.env.example` to `.env` and set `SESSION_SECRET` (at least 32 characters, e.g. `openssl rand -base64 48`; the app refuses to start in production without it), `TOKEN_ENCRYPTION_KEY` (`openssl rand -base64 32`) and Twitch OAuth values.
2. Set `TWITCH_REDIRECT_URI` to your public HTTPS callback URL (for example, `https://grafonaut.example.com/api/auth/twitch/callback`) and register that exact URL in Twitch.
3. Place fixed sample packages in `seeds/builtin/` and operator-provided packages in `seeds/volume/`.
4. Start the stack:

```sh
docker compose up --build
```

Open the public HTTPS hostname served by your reverse proxy. The app exposes `GET /health` and `GET /api/catalog`; these also work on `http://localhost:3000`, but production sign-in requires HTTPS.

The Compose stack runs the app (including the renderer), MySQL 8.4, a volume for uploaded and unpacked files (`/app/storage`) and a read-only seed volume (`./seeds/volume`). The database schema is created at startup.

## Configuration

All settings are environment variables, set in `.env` (see `.env.example`).

| Variable | Default | Purpose |
| --- | --- | --- |
| `SESSION_SECRET` | none (required in production) | Signs the session cookies; at least 32 characters. Keep it stable across restarts and identical across replicas; changing it signs everyone out. |
| `TOKEN_ENCRYPTION_KEY` | none (required in production) | 32 bytes, base64 or hex. Encrypts the renderer and API tokens at rest, see [Tokens](#tokens). |
| `TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET`, `TWITCH_REDIRECT_URI` | empty | Twitch sign-in; hidden unless all three are set. |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI` | empty | Google sign-in, labelled "Login with YouTube"; hidden unless all three are set. |
| `APP_HOST` | empty | Host names of the main page, comma separated. Used by the [referer check](#hotlink-protection). |
| `RENDERER_HOST` | empty (main host) | Host name or origin of the renderer page, see [Host names](#host-names). |
| `GRAPHICS_HOST` | empty (opaque origin) | Host name or origin for graphic frames, package and media files, see [Host names](#host-names). |
| `ASSET_REFERER_CHECK` | `strict` with `GRAPHICS_HOST`, else `lenient` | `strict`, `lenient` or `off`, see [Hotlink protection](#hotlink-protection). |
| `TRUST_PROXY` | `loopback,linklocal,uniquelocal` | Proxies whose `X-Forwarded-*` headers are trusted, see [Reverse proxy](#reverse-proxy-and-sessions). |
| `UPLOAD_MAX_ZIP_BYTES` | `10485760` (10 MB) | Largest package upload. |
| `UPLOAD_MAX_UNCOMPRESSED_BYTES` | `52428800` (50 MB) | Largest unpacked size of a package. |
| `UPLOAD_MAX_FILES` | `5000` | Most entries in a package. |
| `UPLOAD_ALLOWED_EXTENSIONS` | see [USER-GUIDE.md](USER-GUIDE.md#private-catalog) | Allowed file types in packages and the media library, comma separated. |
| `MEDIA_MAX_BYTES` | `20971520` (20 MB) | Largest media library upload. |
| `MCP_BASE_URL` | empty (off) | Public HTTPS origin of the main host; turns on the MCP interface for AI assistants, see [MCP.md](MCP.md). |
| `MCP_ALLOWED_ORIGINS` | empty | Origins of browser-based MCP clients allowed to call `/mcp`, see [MCP.md](MCP.md). |
| `APP_PORT` | `3000` | Host port Docker Compose publishes the app on. |
| `MYSQL_DATABASE`, `MYSQL_USER`, `MYSQL_PASSWORD`, `MYSQL_ROOT_PASSWORD` | see `.env.example` | Database credentials; Compose passes them to MySQL and the app. |

Docker Compose sets `MYSQL_HOST`, `MYSQL_PORT`, `STORAGE_ROOT`, `SEED_BUILTIN_DIR` and `SEED_VOLUME_DIR` for the container itself.

## Sign-in

Users sign in with Twitch or with Google, labelled "Login with YouTube". Each login has its own account: signing in with Twitch and with Google gives two separate accounts (no linking). The YouTube button only appears when `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and `GOOGLE_REDIRECT_URI` are set; Twitch likewise needs its three `TWITCH_*` values.

For Google, create a project in the Google Cloud console (free, no billing needed), configure the OAuth consent screen (external, scopes `openid` and `userinfo.profile`, privacy policy URL) and an OAuth client of type *Web application* with the authorised redirect URI `https://<your host>/api/auth/google/callback`.

Every login attempt carries a random `state` that is kept in the signed session cookie and checked on the callback (valid for 10 minutes, usable once), which protects against login CSRF; the Google login additionally uses PKCE (S256). Cancelled or failed logins show an explanation page.

## Reverse proxy and sessions

The container runs in production mode and uses `Secure`, `HttpOnly`, `SameSite=Lax` signed session cookies. When nginx terminates HTTPS and forwards HTTP to the container, Express must trust the proxy to recognize the original connection as HTTPS. `TRUST_PROXY` defaults to loopback and private-network addresses; restrict it to your proxy's IP address or CIDR ranges in deployments where other clients can reach the backend. Keep the backend reachable only through trusted infrastructure, and configure nginx to overwrite forwarded headers:

```nginx
location / {
	proxy_pass http://127.0.0.1:3000;
	# Uploads: nginx allows 1 MB by default. At least UPLOAD_MAX_ZIP_BYTES and MEDIA_MAX_BYTES (20 MB).
	client_max_body_size 25m;
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

This location belongs in your existing HTTPS server configuration. Without `X-Forwarded-Proto: https` from a trusted proxy, the callback redirects successfully but cannot issue the secure session cookie.

## Host names

Grafonaut uses up to three host names, all pointing to the same container:

| Host | Example | Serves | Setting |
| --- | --- | --- | --- |
| Main host | `grafonaut.example.com` | the app, its API and the OGraf Server API | `APP_HOST` |
| Renderer host | `render.example.com` | the renderer page `/render/<token>/` and its WebSocket | `RENDERER_HOST` (optional) |
| Graphics host | `graphics.example.com` | graphic frames `/render/frame`, package files `/render/assets/…`, media files `/render/media/…` | `GRAPHICS_HOST` |

Set all three in `.env`. `RENDERER_HOST` and `GRAPHICS_HOST` accept a host name (optionally with a port) or a full origin such as `https://graphics.example.com`; they must differ from the main host and from each other. The app answers `404` when a path is requested on the wrong host, and the graphics host serves nothing but graphics paths. When `RENDERER_HOST` is empty, the renderer page uses the main host.

The renderer and graphics hosts only proxy `/render/` and redirect everything else to the main host:

```nginx
server {
	listen 443 ssl;
	server_name render.example.com;
	# ssl_certificate / ssl_certificate_key …

	# Renderer page and its WebSocket
	location /render/ {
		proxy_pass http://127.0.0.1:3000;          # no trailing slash, see below
		proxy_set_header Host $host;
		proxy_set_header X-Forwarded-Proto $scheme;
		proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
		proxy_http_version 1.1;
		proxy_set_header Upgrade $http_upgrade;
		proxy_set_header Connection $connection_upgrade;
		proxy_read_timeout 1h;
	}

	# Everything else belongs to the app
	location / {
		return 301 https://grafonaut.example.com$request_uri;
	}
}

server {
	listen 443 ssl;
	server_name graphics.example.com;
	# ssl_certificate / ssl_certificate_key …

	# Graphic frames, package files and media files
	location /render/ {
		proxy_pass http://127.0.0.1:3000;          # no trailing slash, see below
		proxy_set_header Host $host;
		proxy_set_header X-Forwarded-Proto $scheme;
		proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
	}

	location / {
		return 301 https://grafonaut.example.com$request_uri;
	}
}
```

`proxy_pass` must not end with a slash here: inside `location /render/`, a trailing slash would make nginx replace `/render/` with `/`, and every renderer request would reach the wrong path.

**Why a graphics host.** Graphics are uploaded code. Graphics that script their own HTML pages (for example SPX templates) must share an origin with their package files, so their frames cannot run in an opaque origin. On the graphics host, that origin belongs to graphics alone: package code can neither use the signed-in user's session (main host) nor read the renderer page, whose URL carries the renderer token (renderer host). The renderer page talks to the graphic frames with `postMessage` only. Without `GRAPHICS_HOST`, every graphic runs in an opaque origin; such graphics then cannot fill their content. Graphics on the same renderer still share the graphics origin with each other.

As a second line of defence, add this to the main host's `server` block (nothing on the main host needs `/render/` once `RENDERER_HOST` and `GRAPHICS_HOST` are set; the renderer URL and the preview in the rundown view point to the renderer host):

```nginx
	location /render/ {
		return 404;
	}
```

The session cookie is bound to the main host, so it is never sent to the renderer or graphics host. Changing API requests must come from the main host's own origin (`Origin`/`Sec-Fetch-Site` check), so pages on the other hosts cannot use a signed-in user's session even though they are same-site.

## Hotlink protection

Package files (`/render/assets/…`) and media files (`/render/media/…`) are not served when the request's `Referer` names another site than the renderer or graphics host, a host in `APP_HOST` or the requested host itself; such requests get `403`. Media files are always served to requests without `Referer` (direct downloads). Renderer pages and graphic frames send only their origin as referrer (`Referrer-Policy: strict-origin`), never the token path. `ASSET_REFERER_CHECK` sets the mode for package files (for media files, only `off` applies):

- `strict` (default with `GRAPHICS_HOST`): requests without `Referer` are refused as well.
- `lenient` (default without `GRAPHICS_HOST`): requests without `Referer` are served, foreign referers are refused. Without a graphics host, graphics run in an opaque origin, and browsers send no `Referer` for their images and nested pages.
- `off`: no check.

The check stops other web pages from embedding the files; it is not access control, since anyone can send any `Referer` with a direct request.

## Tokens

Renderer and API tokens are stored AES-256-GCM encrypted with `TOKEN_ENCRYPTION_KEY` (32 bytes, base64 or hex; required in production) and looked up by SHA-256 hash. Keep the key outside the database and stable across restarts: if it changes, existing tokens can no longer be shown and users must create new ones on the Renderer and API pages.

Renderer and API URLs carry their token in the path. Keep them out of access logs that others can read, or redact them there.
