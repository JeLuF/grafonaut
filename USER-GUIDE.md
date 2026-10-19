# User guide

How Grafonaut works for signed-in users: catalogs, uploads, the media library, rundowns, group actions and the renderer. Setup is described in [INSTALLATION.md](INSTALLATION.md), the APIs in [API.md](API.md).

## Catalog

The public catalog lists the published graphics, with search, pages of six and a detail page per graphic (description, thumbnails, manifest). Signed-in users add a graphic to their current rundown from the catalog or its detail page.

## Private catalog

Signed-in users upload `.ograf.zip` packages on the Private catalog page. The graphics are only visible to their owner and can be added to rundowns like catalog graphics. Uploading a graphic whose manifest `id` already exists in the account adds a new version of that package; rundown entries keep the version they were added with. Re-uploading an identical file is skipped.

Every upload is checked before anything is saved (requirements §6):

- At most `UPLOAD_MAX_ZIP_BYTES` (10 MB), `UPLOAD_MAX_FILES` (5,000) entries and `UPLOAD_MAX_UNCOMPRESSED_BYTES` (50 MB) unpacked. The unpacked size is counted while extracting, so forged size headers cannot get around it; extraction also has a time limit.
- No absolute paths, `..` segments, backslashes or symbolic links.
- Only allowed file types: by default `.json .mjs .js .jpg .jpeg .png .apng .webp .gif .svg .mp3 .mp4` (the requirements list) plus `.css .html .htm .ttf .otf .woff .woff2 .md .txt`, which real graphics need (stylesheets, HTML templates, fonts, read-me files). Set `UPLOAD_ALLOWED_EXTENSIONS` to change the list, e.g. to the strict requirements list.
- Every `*.ograf.json` manifest must validate against the official OGraf v1 JSON Schema (vendored in `server/schemas/ograf`), and its `main` must be an existing `.mjs`/`.js` file inside the package. The check is lenient where a detail does not affect playback: a property with `"gddType": "select"` but no `gddOptions.labels` uses its `enum` values as labels; the upload succeeds with a note, and the manifest is stored as uploaded. Error messages name the property (e.g. `property "layout" must have required property 'gddOptions'`) and leave out the schema's generic "must match then schema" lines.

Package files are served to graphic frames from `/render/assets/<version>/…`; HTML and SVG only ever in a CSP sandbox. Private versions are addressed by their random version UUID, which only the owner sees.

## Favourites

The star on a graphic card or on a graphic's page bookmarks the graphic; the **Favourites** page (sidebar link) lists your favourites from the public and your private catalog. A favourite is the graphic, not one version: it shows the current published version of a public graphic and the newest version of your own upload. You can keep up to 500 favourites. AI assistants connected through the [MCP interface](MCP.md) use your favourites first when they set up rundowns.

## Media library

Signed-in users manage their own files on the Media page (sidebar): upload (several at once), rename, replace and delete. Uploads use the same allowed file types as packages (`UPLOAD_ALLOWED_EXTENSIONS`) and are limited to `MEDIA_MAX_BYTES` (20 MB) each. Files are stored under `storage/media/<account>/` and served to graphics from `/render/media/<uuid>.<ext>` on the graphics host (else the renderer host), with the same CSP sandbox as package files. Other websites cannot embed them ([hotlink protection](INSTALLATION.md#hotlink-protection)).

Graphic properties with a `gddType` of `file-path` (e.g. `file-path/image-path`) get a file chooser in the property dialog and in custom-action dialogs: keep the graphic's default, pick a file from the media library or upload a new one. Choices are limited to the property's `gddOptions.extensions` (image types for `image-path`). The property gets the file's absolute URL. Replacing a file keeps its URL, so every graphic that uses it shows the new content; the media page shows how many rundown entries use a file and warns before deleting it.

## Rundowns

Graphics are prepared in rundowns, so several events can be prepared from one account; clicking a rundown in the sidebar opens it (and makes it current). New accounts start with a "Default rundown". The sidebar lists the rundowns; users create, rename, switch and delete them there. Deleting a rundown removes its graphics; the current rundown cannot be deleted (switch to another one first), so every account keeps at least one. The current rundown is stored per account (not per browser): added graphics go to it, and the rundown view, the renderer and the OGraf Server API only work with it. Switching takes the previous rundown's graphics off air; if any are loaded, the app asks for confirmation first.

## Rundown view

Each addition from the public or private catalog creates a new entry in the current rundown, pinned to that exact version, with an independent label, enabled flag and property state (starting with the manifest defaults). Disabled packages stay listed but cannot be enabled or controlled.

Each entry shows its label (the graphic's name until it is renamed) and, below it, its current property values in GDD order, e.g. "Jane Doe · Host". Properties marked `hidden` are left out, as the OGraf specification asks for labels and display names, and so are colours, file paths, SPX file lists and instructions, and on/off values. Select fields show their label. The values take up to two lines, or one line for renamed entries, which show the graphic's name above them. The version and source (catalog or upload) are shown in the tooltip of the label.

A successful addition briefly lights the add button green and displays a dismissible toast. Each entry's three-dot menu offers **Show details**, **Show manifest** for its pinned version, **Duplicate** (a copy with the same version, properties and enabled state, labelled "… (copy)", placed directly below) and **Delete**, with confirmation. Deletion removes only that entry; the package and other copies remain unchanged.

Reorder entries with the drag handle or the up/down arrows. The handle also supports keyboard sorting: focus it, press Space to pick up, use the arrow keys to move, and press Space to drop or Escape to cancel. The order is saved per rundown, survives reloads and defines the stacking in the renderer (first entry in front); failed saves leave the displayed order unchanged.

### Playing graphics

- **Play** loads the graphic with the saved properties (if it is not loaded, or has ended) and plays it; pressing it again while on air advances to the next step.
- **Stop** animates the graphic out and removes it.
- **Update** sends the entire saved property state to the loaded graphic.

Entries whose graphic declares custom actions get a ⚡ menu listing them; actions with a payload schema open a form generated from it, the others run directly. Like Play, a custom action first loads the graphic with the saved properties when it is not loaded or has ended (the OGraf spec allows any action once `load()` has resolved, so graphics can offer alternative ways to start).

Each entry shows whether it is on air, loaded or ready, and the heading shows how many renderers are connected. Graphics follow the OGraf step model: a graphic with `stepCount: 0` plays once and animates out by itself, so it is shown as "Played" afterwards, not on air.

The buttons use the account's public [OGraf Server API](API.md#ograf-server-api), not a separate internal endpoint.

### Properties

The property dialog is generated from the selected version's JSON `schema`. Fields follow the GDD `order` attribute (lower values first; fields without an order follow in manifest order) and use the GDD `label` as their title; a field's description is shown as a tooltip. Fields marked `hidden` remain editable. Saving validates the complete state in both the form and the backend; cancelling changes nothing. Property edits only save configuration; press Update to send them to a graphic on air.

Special field types:

- **Colours** (`color-rrggbb`, `color-rrggbbaa`): a colour picker popup with the last 8 colours picked in this browser, a hex field and, for `rrggbbaa`, an opacity slider.
- **Files** (`file-path`, e.g. `file-path/image-path`): the [media library](#media-library) chooser.
- **Multi-line text** (`multi-line` and specializations such as `multi-line/rich-formatted-text`, SPX `textarea`): a text area, as tall as the default value (4 to 12 lines) and resizable, that keeps line breaks and indentation.
- **Lists** (`type: array`): one row per item with buttons to move it up or down, copy (when enabled) and remove it, and *Add Item* below. Items use the same field types as single properties.
- **Selects** (`select`): the `gddOptions.labels`, or the `enum` values when labels are missing.
- **SPX file lists** (`ftype: filelist`): a select of the files in the package's asset folder. SPX instruction fields are shown as notes.

### Group actions

Each rundown has a list of group actions shown above its entries: a run button and a pencil (edit) per group, plus *New group action*. A group has a name and up to 50 steps: Play, Stop, Update or a custom action (with a payload form when the action has a schema) on an entry of the rundown, or Sleep (seconds).

Sleep steps split a group into phases that run one after the other; within a phase all steps start together, so e.g. "stop lower third, play coming next" happen at the same moment, and only steps on the same entry keep their order. A failing step does not stop the others; the result is shown as a toast. The sleep steps of a group may add up to at most 10 minutes.

Groups run on the server and are triggered through Grafonaut's extension of the OGraf Server API, `POST /x-actions/{id}` (the run button uses it too), so controllers such as Stream Deck/Companion can run them with one call.

## Renderer

Every account has one renderer: the page at `/render/<renderer-token>/`, used as an OBS/vMix browser source. Any number of renderer pages may be open for an account (OBS, a test tab, the preview in the rundown view); they all show the same graphics. Each page holds a WebSocket to `/render/<renderer-token>/ws`, authenticated by the token in its path, and receives the on-air state and the actions from it. The state is stored in the database, so renderers that connect later or reconnect after a restart show the same graphics. Ended graphics are not replayed when a renderer reconnects.

Each graphic runs in its own sandboxed iframe. To be forgiving with graphics whose `load()` resolves before the pages they create in nested frames have loaded (e.g. SPX-style templates that define `play()` there), the renderer waits up to 5 seconds for such frames before it reports the graphic as loaded, so an action sent right after loading finds them ready. The frames are stacked in rundown order: the first entry is in front. Frames, package files and media files come from the graphics host; HTML and SVG files are served with a CSP sandbox so they never run in the app's origin. SPX-style graphics need the graphics host (see [Host names](INSTALLATION.md#host-names)).

The sidebar has a page for each way to connect to your account:

- **Renderer:** the renderer URL for OBS/vMix browser sources, with setup steps.
- **API:** the URL of your [OGraf Server API](API.md) for controllers such as Bitfocus Companion, and a link to the interactive API documentation.
- **AI assistants:** shown when the server has the [MCP interface](MCP.md) enabled. It shows the MCP URL, the apps connected to your account (with a button to disconnect each) and the latest changes they made.

## Signing out

The button next to the account name at the bottom of the sidebar signs out.

## Tokens

The renderer and API URLs each contain a token: 32 random bytes created with the account, permanent so the URLs can stay in browser sources and controllers. The API token is separate from the renderer token, so a leaked renderer URL cannot be used to control graphics.

If a URL leaked, create a new token on the Renderer or API page. Every URL with the old token stops working, and open renderer pages are disconnected.
