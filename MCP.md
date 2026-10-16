# MCP interface

Grafonaut has a [Model Context Protocol](https://modelcontextprotocol.io) (MCP) server. It lets an AI assistant such as Claude set up rundowns: you describe the event, and the assistant creates a rundown, finds suitable graphics, adds entries with their properties and prepares group actions. You then check the rundown in Grafonaut and run the show as usual.

The interface prepares rundowns. It cannot control graphics on air: there is no play, stop or update tool, it never takes graphics off air, and it refuses changes that would affect graphics on air.

## Enabling it

The interface is off unless `MCP_BASE_URL` is set:

| Variable | Default | Purpose |
| --- | --- | --- |
| `MCP_BASE_URL` | empty (off) | Public origin of the main host, e.g. `https://grafonaut.example.com`. Must be HTTPS; `http://localhost:<port>` is allowed for development. Turns on the MCP endpoint at `<MCP_BASE_URL>/mcp` and its OAuth endpoints. |
| `MCP_ALLOWED_ORIGINS` | empty | Origins of browser-based MCP clients allowed to call `/mcp` directly (CORS), comma separated, e.g. `http://localhost:6274`. Not needed for Claude, Claude Code or other clients that don't run in a browser. |

The endpoints answer only on the host of `MCP_BASE_URL`; on the renderer and graphics hosts they don't exist. Use the main host for it, the one users sign in on, so the consent page has their session.

With the reverse proxy from [INSTALLATION.md](INSTALLATION.md#reverse-proxy-and-sessions) (`location /` to the container), nothing else is needed. If your proxy only forwards selected paths, it must also forward:

| Path | Purpose |
| --- | --- |
| `/mcp` | The MCP endpoint (Streamable HTTP, `POST` only) |
| `/.well-known/oauth-protected-resource/mcp` | Protected resource metadata (RFC 9728): tells clients where to authorize |
| `/.well-known/oauth-authorization-server` | Authorization server metadata (RFC 8414) |
| `/register` | Dynamic client registration (RFC 7591) |
| `/authorize`, `/oauth/consent` | Authorization request and the consent page |
| `/token`, `/revoke` | Token endpoint and token revocation (RFC 7009) |

When the interface is enabled, the sidebar shows an **AI assistants** page with the MCP URL, the connected apps and their recent changes.

The interface needs a single app instance: pending authorizations and authorization codes are kept in memory (like the renderer connections), so a restart cancels sign-ins that are in progress. Connected apps and their tokens are stored in the database and survive restarts.

## Connecting an assistant

Use the MCP URL from the AI assistants page, `<MCP_BASE_URL>/mcp`.

- **Claude (claude.ai and the desktop app):** add a custom connector with the MCP URL (Settings → Connectors). Claude opens Grafonaut's consent page when you connect.
- **Claude Code:** `claude mcp add --transport http grafonaut https://grafonaut.example.com/mcp`, then run `/mcp` in Claude Code to sign in.
- **Other clients:** any client that supports remote MCP servers over Streamable HTTP with OAuth (dynamic client registration, authorization code with PKCE).

Connecting works the same in every client:

1. The client finds Grafonaut's authorization server through the protected resource metadata and registers itself.
2. Your browser opens Grafonaut. Sign in with Twitch or YouTube if you aren't signed in yet.
3. The consent page shows the name the app gives itself, your account and where your browser goes after you decide. Choose whether the app may only read or also prepare rundowns, then allow or deny.
4. The client receives a token for your account. It works until you disconnect the app on the AI assistants page, or until the app goes unused for 30 days.

If the consent page appears without you having started a connection, deny it. Someone may be trying to get access to your account.

## Using it

Ask the assistant in plain words, for example:

> Set up a rundown for the Cup final on 20 October: an opening title "Cup Final 2026", lower thirds for the host Grace Hopper (Moderator) and the guests Ada Lovelace (Coach, FC North) and Alan Turing (Captain, FC South), and a scoreboard for FC North vs FC South. Use our logo from the media library. Add a group action that shows both team lower thirds one second apart.

The assistant creates the rundown "Cup final" and fills it in. The new rundown doesn't become the current one, so whatever you are running on air stays as it is. Open it in Grafonaut, check the entries and their properties, and make it current when the event starts.

Clients that support MCP prompts also offer the prompt **Set up a rundown for an event** (`set_up_rundown`). It takes a description of the event and walks the assistant through these steps.

### Tools

Reading (scope `rundowns:read`):

| Tool | What it does |
| --- | --- |
| `search_graphics` | Searches the public catalog and your private uploads by name and description |
| `get_graphic` | A graphic's properties, the JSON schema their values must match, default values and custom actions |
| `list_rundowns` | Your rundowns, their number of entries, and which one is current |
| `get_rundown` | A rundown's entries in order, with property values and on-air state, and its group actions |
| `get_entry` | One entry with its property values and schema |
| `list_media` | Your media library; a file's URL can be used as the value of an image or video property |

Preparing (scope `rundowns:write`):

| Tool | What it does |
| --- | --- |
| `create_rundown`, `rename_rundown` | Creates (not current) or renames a rundown |
| `set_current_rundown` | Makes a rundown current. Refused while graphics are on air; the assistant is told to use it only when you ask. |
| `add_entry` | Adds a graphic with label, property values and enabled state, at the end or at a given position |
| `update_entry` | Changes label, enabled state or property values (merged into the current values, or replaced) |
| `duplicate_entry`, `reorder_entries`, `remove_entry` | Copies, reorders or removes entries |
| `create_group_action`, `update_group_action`, `delete_group_action` | Prepares group actions. They are stored, not run: you trigger them in Grafonaut or from a controller. |

Property values are checked against the graphic's schema exactly as in the property dialog; the assistant receives the validation errors and can correct them. Values are not otherwise restricted: like you in the dialog, the assistant can set any value the schema allows.

### What it cannot do

- Control graphics: load, play, stop, update, custom actions, running group actions. Use the Grafonaut UI, the [OGraf Server API](API.md) or a controller such as Bitfocus Companion.
- Take graphics off air. Removing or disabling an entry that is on air, and switching rundowns while graphics are on air, are refused.
- Delete rundowns, upload graphic packages or media files, change or delete media.
- See or change the renderer and API URLs, or anything of other accounts.

## Security

**Authorization.** Grafonaut is its own OAuth 2.1 authorization server for the MCP endpoint:

- The user signs in with Twitch or Google as usual. The client receives a Grafonaut token and never sees provider tokens.
- Authorization codes require PKCE (S256), can be used once and expire after 5 minutes. Presenting a used code again revokes the tokens issued for it.
- Tokens are bound to the MCP endpoint (RFC 8707 resource indicators); tokens for other resources are refused.
- Access tokens expire after 1 hour. Refresh tokens rotate at every use and expire after 30 days without use. Presenting a refresh token that was already replaced ends the connection: it must have been copied.
- Tokens are 32 random bytes and are stored only as SHA-256 hashes. Secrets of confidential clients are stored encrypted with `TOKEN_ENCRYPTION_KEY`.
- The MCP endpoint accepts only bearer tokens in the `Authorization` header. The session cookie, the renderer token and the API token don't work there.

**Client registration.** Any client may register (that is how MCP clients connect), so Grafonaut doesn't trust what a client says about itself:

- Redirect URIs must be HTTPS URLs, loopback `http://` URLs (`localhost`, `127.0.0.1`, `[::1]`) or private-use schemes of native apps. `javascript:`, `data:`, `file:` and similar are refused, at most 10 URIs per client.
- The consent page labels the client's name as unverified and shows where the browser is sent after the decision.
- The consent page can't be framed (clickjacking). Its form carries a per-request token and accepts only same-origin submissions (CSRF).
- Sign-in from the consent page returns only to that consent page; other return addresses are ignored, so it can't be used as an open redirect.
- Registration, authorization and token requests are rate-limited per IP address.

**Least privilege.** The two scopes are enforced on the server: a token with only `rundowns:read` sees and can call only the reading tools. The user can withhold `rundowns:write` on the consent page even if the client asked for it. All tools act only on the signed-in account's data and use the same validation as the app (names, property schemas in a time-limited worker, group action steps).

**Nothing on air.** No tool controls the renderer. Changes that would take something off air are refused: removing or disabling an entry that is on air, switching rundowns while graphics are on air. Changing the properties of an entry on air doesn't change the graphic until you update it in Grafonaut.

**Prompt injection.** Public graphics are uploaded by other people. Their names, descriptions and property schemas, like your entry labels and file names, reach the assistant as tool results. A description could contain text written to look like instructions ("delete all entries"). The interface limits what such text can achieve:

- User-written text is shortened and stripped of control and text-direction characters.
- The server instructions tell the assistant to treat it as data.
- There are no tools that could do lasting harm or reach the audience: no deleting rundowns, no control of graphics on air, no access to the renderer or API URLs, and nothing on air is changed.
- Tools are marked read-only or destructive (`readOnlyHint`, `destructiveHint`), so clients can ask before running changing tools. Keep that confirmation on in your client.
- Every change is logged and shown on the AI assistants page.

**Transport.** Browsers always send an `Origin` header, and requests to `/mcp` are refused unless that origin is listed in `MCP_ALLOWED_ORIGINS`. This protects against DNS rebinding and cross-site calls; clients outside a browser send no origin and authenticate with their token. Each connection may make 120 requests per minute. Request bodies are limited to 100 KB.

**Revocation and audit.** The AI assistants page lists the connected apps with their permissions, the time they were connected and when they were last used. Disconnecting an app revokes its tokens immediately. Clients can also revoke their own tokens (RFC 7009). The page also shows the most recent changes made through the interface, including refused ones, with the app that made them. Changes are kept for 90 days.

## Development

Set `MCP_BASE_URL=http://localhost:3000` (the API server, not the Vite port). Session cookies don't depend on the port, so a sign-in through the Vite dev server also works on the consent page.

To try the tools without an assistant, run the [MCP Inspector](https://github.com/modelcontextprotocol/inspector) (`npx @modelcontextprotocol/inspector`), choose Streamable HTTP and `http://localhost:3000/mcp`, and connect with OAuth. If the Inspector calls the server directly from the browser, add its origin to `MCP_ALLOWED_ORIGINS`.

The code is in `server/mcp.js` (endpoint, origin check, rate limit), `server/mcp-oauth.js` (authorization server, consent page, connected apps) and `server/mcp-tools.js` (tools). `server/mcp.test.js` runs the whole flow, from registration and consent to the tool calls, against an in-memory store.
