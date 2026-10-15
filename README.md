# Grafonaut

Grafonaut hosts, organizes and renders [OGraf](https://ograf.ebu.io) graphics: a public and a private catalog, rundowns with properties and group actions, a browser renderer that can be easily used in OBS, vMix, or any other software that can use a web browser overlay, and an implementation of the OGraf Server API to control it all. Planned home: `grafonaut.mov`.

**Naming:** *Grafonaut* is this application. *OGraf* is the EBU specification it implements (graphics packages with `*.ograf.json` manifests, the OGraf Server API under `/ograf/v1`). Code and documentation keep the OGraf name wherever they refer to the specification, e.g. "OGraf graphic", "OGraf Server API" or `ograf-api.js`.

## Features

- **Catalogs:** a public catalog of published graphics with search and detail pages, and a private catalog for each account's own uploads (`.ograf.zip`, checked before anything is stored).
- **Rundowns:** several prepared events per account. Entries keep their own label and properties, edited in a dialog generated from the graphic's schema (colour pickers, media file choosers, SPX file lists).
- **Group actions:** several play, stop, update and custom-action steps, with pauses, triggered with one click.
- **Media library:** images and other files for graphic properties, with hotlink protection.
- **Renderer:** one browser page per account for OBS/vMix, with every graphic in its own sandboxed frame.
- **OGraf Server API** per account, with interactive documentation at `/api-docs/`, for controllers such as Bitfocus Companion.
- Sign-in with Twitch or YouTube (Google).

## Documentation

| Document | Contents |
| --- | --- |
| [INSTALLATION.md](INSTALLATION.md) | Running with Docker, configuration reference, sign-in providers, reverse proxy, renderer and graphics hosts, security settings |
| [USER-GUIDE.md](USER-GUIDE.md) | Catalogs, uploads, media library, rundowns, properties, group actions, renderer and tokens |
| [API.md](API.md) | The OGraf Server API (and its `x-actions` extension) and the app's own API |
| [DEVELOPMENT.md](DEVELOPMENT.md) | Local development, tests, seed packages |
| [STATUS.md](STATUS.md) | Status of the work packages from `ograf-platform-requirements.md` |

## Quick start

```sh
cp .env.example .env    # set SESSION_SECRET, TOKEN_ENCRYPTION_KEY and a sign-in provider first
docker compose up --build
```

See [INSTALLATION.md](INSTALLATION.md) for the settings, the reverse proxy and the host names a production setup needs.
