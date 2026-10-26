# MCP connector credentials

Administrators register HTTP MCP servers through `PUT /v1/admin/mcp-servers/:id`.
Registration controls the outbound destination and the tools available to agents.

`credentialScope` selects the identity used for `tools/call`:

- `shared` (the default for existing and new registrations): all callers use the
  configured `auth`, `bearerToken`, or `clientId` and `clientSecret`.
- `per-user`: each call uses the initiating actor's bearer token from the encrypted
  connector keychain, under `credentialHost` in the selected `credentialAccountType`
  slot (`default`, `personal`, or `company`; defaults to `default`). The
  runtime supplies the actor; tool arguments cannot select another user.

For example:

```json
{
  "name": "Customer tools",
  "url": "https://tools.example.com/mcp",
  "auth": "none",
  "credentialScope": "per-user",
  "credentialHost": "accounts.example.com",
  "readOnly": false,
  "enabled": true
}
```

Per-user mode requires persistent keychain encryption (`CONNECTOR_SECRET_KEY`).
Connect the user's account using an existing QM OAuth connector, or have a trusted
integration save its token through the source-authenticated
`POST /v1/connectors/token` endpoint with `host`, `principalId`, `accessToken`, and
optional `expiresAt` (Unix milliseconds). Supported OAuth providers can also store
and refresh a `refreshToken`. An unsupported provider must manage token renewal
in its integration; do not store a refresh token that QM cannot refresh. For a
server that implements the MCP Authorization spec itself, use `auth: "oauth"`
instead (below): QM then runs the sign-in flow and the refresh on its own.

Missing, expired, revoked, or unrefreshable user credentials fail the call with a
connection-required message. Per-user MCP calls do not use operator environment
tokens, organization credentials, another user's account, or the shared discovery
credential as fallback. Tokens are resolved again for every call rather than
cached across users. Triggered work uses its existing initiating actor identity.

Tool discovery (`tools/list`, including registration probes) remains connector-wide
and uses the configured `auth`. In per-user mode those credentials are only for
catalog discovery. The server must expose a common, non-sensitive catalog and
check each caller's permissions when executing a tool. A public catalog can use
`auth: "none"`; a private catalog can use a dedicated shared discovery credential.
Do not put user-specific data into names, descriptions, or schemas.

`credentialHost` explicitly authorizes sending that connector's user token to the
registered server. Only register a trusted service permitted to receive those
tokens. Per-user endpoints an admin registers require HTTPS, except on loopback for
local development. The managed Microsoft 365 server below is the one exception: its
URL comes from deployment config, so it can reach a sidecar over plain HTTP on a
private network.

Tools of a `per-user` server act as one person, so they follow the same rule as that
person's connector credentials: they are offered and callable only in the person's own DM
with the agent, when the person is the live speaker in an Open shared conversation, or in
an owner-authorized automation, and never on external, guest, or strict read-only turns.
Open membership and sharing posture are checked again on every call. A server with a
`credentialHost` is also offered only to people who have a usable token for that host,
so people who never connected the account don't pay for its tool definitions. A call to
a per-user tool that changes data (a server not marked `readOnly`, and a tool without the
MCP `readOnlyHint` annotation) waits for the person's approval through the existing tool
approval flow, in every posture; the approval shows the call's arguments so the person
sees exactly what would be sent. `auth: "oauth"` servers (below) keep their own behaviour.

A per-user server whose `credentialHost` belongs to an OAuth connector that declares
apps (Microsoft 365, in `src/connectors/connector-apps.ts`) is also filtered by each
person's app settings: a tool is offered, and callable, only while one of the apps that
claims it is on. Tools no app claims are left to the server's own allowlist. These
settings manage the agent's context and speed; they are not access control, because the
connected account's permissions and the shared tools (file and attachment downloads take
any Graph path) still reach other apps' data. Settings apply from the person's next turn.
If they can't be read, the turn uses each app's default and the Keychain card says the
settings couldn't load rather than offering to overwrite them. In an Open shared
conversation the tool list follows the current speaker, so speakers with different
settings alternating in one thread lose some prompt caching.

HTTP redirects are rejected for every MCP authentication mode. Updating an endpoint
or credential host is an administrative trust decision. Tool call auditing records
the initiating actor as before; authentication does not expand the audience allowed
to receive the result.

## Discovery mode

A server registered with `"toolMode": "discovery"` (the admin form's **Discovery**
checkbox) is not offered as one agent tool per server tool. Instead the agent gets three
fixed tools, `<id>_search_tools` (by keyword or app), `<id>_describe_tool` (one tool's
description and input schema) and `<id>_call_tool` (run a tool by name with arguments),
about 900 characters in total whatever the server's size. They stay identical across
turns and speakers, which keeps the prompt cache warm. Use it for servers with many large
tools, such as the Microsoft 365 sidecar. The default, `"full"`, lists every tool as
before.

The three tools see exactly the tools a direct listing would offer this turn: per-person
access, connected account, connector app settings, and read-only turns all apply, and
search, describe and call are checked again at each use. A tool they don't offer can't be
described or called. `call_tool` runs the real tool through the same path as a direct call:
the same refusals and Open-membership check, the write approval keyed on the real tool name
with the real arguments shown, the same audit records, result handling and stop
behaviour. The lookups themselves are not held for approval. When no tool of the server is
available (no access, no account, every app off), the three tools are not offered.

## Managed Microsoft 365 server

A deployment that runs the Microsoft 365 sidecar sets `MS365_MCP_URL` on core (the
Dokploy compose sets `http://ms365-mcp:3000/mcp`). While that is set and the
`microsoft` OAuth app is configured and enabled (in Admin → OAuth apps, or through
`MICROSOFT_CLIENT_ID` and `MICROSOFT_CLIENT_SECRET`), the server store includes a
managed `microsoft-365` server: that URL, `auth: "none"`, `per-user` with credential
host `graph.microsoft.com`, not read-only, and `toolMode: "discovery"`. It has no
stored row: `src/mcp/managed-mcp-servers.ts` derives it on every read, so its settings
can't drift and it disappears as soon as either condition stops holding. Saving or
removing an OAuth app refreshes the tool service at once; other instances pick the
change up on their next scheduled refresh.

Admins see it marked **Managed** in the MCP servers list and can't edit or remove it
(the admin API answers `409`); disabling or removing the Microsoft 365 OAuth app turns
it off. A `microsoft-365` server registered by hand stays stored but is hidden while
the managed one is present, and is listed again if the managed one goes away.

## Each person signs in (MCP Authorization)

`auth: "oauth"` is for remote MCP servers that implement the
[MCP Authorization spec](https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization)
(for example Granola at `https://mcp.granola.ai/mcp`). Each person signs in to the
server with their own account; QM holds their token and uses it only for their calls.

```json
{ "name": "Granola", "url": "https://mcp.granola.ai/mcp", "auth": "oauth", "readOnly": true }
```

Requirements: `PUBLIC_WEB_URL` (the redirect URI is built from it) and
`CONNECTOR_SECRET_KEY` (tokens and client secrets are encrypted with it). Without
them the admin route answers 400 and 501. The URL must be HTTPS; core needs
outbound HTTPS to the MCP server and its authorization server, and no sandbox egress
rule is involved.

Saving the server:

1. Sends an unauthenticated `initialize` to the URL and reads the `401`
   `WWW-Authenticate: Bearer resource_metadata=…` challenge, falling back to
   `/.well-known/oauth-protected-resource` (path-inserted, then root).
2. Checks the protected-resource `resource` against the server URL, then loads the
   authorization server metadata (RFC 8414, then OpenID discovery). The `issuer`
   must match and PKCE `S256` must be supported.
3. Registers QM as a client with dynamic client registration (RFC 7591), with the
   fixed redirect URI `${PUBLIC_WEB_URL}/v1/connectors/oauth/mcp-<id>/callback`.
   A server without a registration endpoint needs a client registered by hand
   with that redirect URI, passed as `oauthClientId` (and `oauthClientSecret`).
4. Stores the registration in `fork_mcp_oauth_clients`. It is reused on later saves
   and only redone when the URL or redirect URI changes, the client secret expires,
   or the body carries `"reregister": true`. A new registration or URL deletes every
   stored user token and the tool catalog, because their audience changed.

Scopes come from the challenge `scope`, else the protected-resource
`scopes_supported`; `offline_access` is added when the authorization server lists
it, so sign-in returns a refresh token. `oauthScopes` (space-separated) overrides
them. Every discovery, registration, token, and revocation request is HTTPS-only,
must resolve to public addresses, refuses redirects, times out after 10 seconds,
and caps responses at 256 KB. Loopback HTTP is allowed outside production only.

People connect from **Keychain** in the web app (`/keychain?connect=mcp-<id>`
highlights the card). The existing connector routes serve the flow under the
provider name `mcp-<id>`: `start` stores an opaque one-time state with the PKCE
verifier for 10 minutes and returns an authorize URL carrying `resource` (RFC 8707);
the public callback checks the state, the browser (the portal adds a short-lived
portal identity, which must match the person who started when portal identity is
enforced), the client registration, and `iss` (RFC 9207) before exchanging the code.
Tokens live encrypted in `fork_mcp_user_tokens`, separate from the connector
keychain, so they can never be granted to a conversation or injected into a
sandbox. Only core reads them, for that person's tool calls.

Tools: the first successful sign-in lists the server's tools with that person's
token and stores the shared catalog in `fork_mcp_catalogs`. Until someone connects,
the server has no tools, so an admin should connect first. If that listing fails,
the catalog is retried in the background when a connected person opens Keychain
(at most every five minutes per instance), or right away when someone reconnects.
Every instance re-reads the catalog each minute; a catalog older than a day is
re-listed in the background after a successful call. The catalog must be the same for everyone, as above.

Calls use the caller's token only. An unconnected caller gets an error telling the
agent to have the person connect at `${PUBLIC_WEB_URL}/keychain?connect=mcp-<id>`.
A token refreshes a minute before it expires, once across instances (advisory lock
plus compare-and-set, so rotating refresh tokens survive). A `401` from the server
forces one refresh and one retry; a second `401`, or a refresh rejected by the
authorization server, marks the account for reconnect. QM speaks the streamable-HTTP
session handshake (`initialize`, `Mcp-Session-Id`, `notifications/initialized`,
`MCP-Protocol-Version`) with these servers; other auth modes keep the single-POST
transport.

Disconnecting deletes the person's token and revokes it at the authorization server
when it publishes a revocation endpoint. Deleting the server, or switching it to
another auth mode, deletes its registration, catalog, and every user token.
