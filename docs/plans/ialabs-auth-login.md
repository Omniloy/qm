# Sign in to qm through ialabs-auth-service, the people-app way

## Goal

People sign in to the qm portal (and through it every qm surface) with their Laberit
Entra ID account, brokered by `ialabs-auth-service` (MS-AUTH), exactly as `people-app` does:
qm is an **app** of the MS-AUTH catalog, signs in with PKCE using MS-AUTH's own API, and
validates the MS-AUTH access token locally against its JWKS. MS-AUTH does not change.

## How people-app does it

- `auth.yml` (ialabs-infra) declares the app: `app_id: people`, `access: assigned`,
  `redirect_uris` (labs + localhost), `services: [time-tracking, people-api]`,
  `roles: [viewer, admin]`. Access is granted with `ialabs-auth access grant <email> people`.
- The front (`@ngfwk/auth`, `provideNgfwkAuth`) is a public client: no secret.
  1. `GET /auth/api/auth/authorize?client_id=people&redirect_uri=…&code_challenge=…&state=…`
  2. MS-AUTH sends the browser to Entra ID, then back to `/auth/callback` with `code` + `state`.
  3. `POST /auth/api/tokens` `{code, code_verifier, redirect_uri}` gives an access token
     (15 min, RS256) and a refresh token (rotating, 7 day session).
- The access token carries `aud` = the app's services, `client_id` = `people`, `pty` = `user`,
  `roles` = the person's roles in the app, plus `sub`, `email`, `name`, `oid`.
- Each backend checks it locally with the MS-AUTH JWKS (`pyfwk-lib-auth`
  `require_access(apps={"people": []})`, admin area `["admin"]`). There is no id_token,
  userinfo or OIDC discovery anywhere.

## What changes for qm

qm's browser entry is `plugins/portal`, a server. So the flow is the same, but the portal
does the work the people front does in the browser, and the browser only gets the portal's
own session cookie.

### 1. Register qm in MS-AUTH (ialabs-infra `auth.yml`)

```yaml
services:
  - audience: qm
    name: qm
apps:
  - app_id: qm
    access: assigned
    redirect_uris:
      - https://<qm-portal-host>/auth/callback
      - http://localhost:<portal-port>/auth/callback
    services: [qm]
    roles: [member, admin]
```

Then `ialabs-auth access grant <email> qm --role member`.

### 2. Portal: an `ialabs` sign-in mode (`plugins/portal/src/oidc.ts`, `index.ts`)

Today `authLogin`/`authCallback` (`plugins/portal/src/index.ts` around lines 1690–1745) run
generic OIDC: `buildAuthorizeUrl`, `exchangeCode` (form + HTTP Basic), `verifyIdToken`
(nonce), `fetchUserinfo`, `resolvePrincipal`. MS-AUTH has none of the last three. Add one
provider mode selected by config, keeping the rest of the portal (temp cookie, `state`,
`consumeState`, `sanitizeReturnTo`, `setAuthenticatedSession`) untouched:

- **Authorize:** same URL builder, MS-AUTH params only: `client_id`, `redirect_uri`,
  `code_challenge`, `code_challenge_method=S256`, `state`. No `scope`, no `nonce`, and
  `prompt=select_account` passed through like people-app does.
- **Exchange:** `POST {IALABS_AUTH_URL}/api/tokens` as JSON
  `{code, code_verifier, redirect_uri}`; no client secret (public client, like people).
- **Verify:** `jose.jwtVerify(access_token, JWKS)` with `issuer` = MS-AUTH `TOKEN_ISSUER`,
  `audience` = `qm`, `algorithms: ["RS256"]`; then require `pty === "user"` and
  `client_id === "qm"`. This is exactly what people's backend checks.
- **Identity:** `email` (lowercased) is the principal, `name` the display name. It reuses
  `resolvePrincipal` for the allowlist/domain/invite rules. Since there is no
  `email_verified`, the ialabs mode treats the email as verified: MS-AUTH only issues tokens
  for Entra ID accounts of the Laberit tenant.
- **Refresh token (decided: server-side refresh).** The goal is to cut off people removed in
  Entra ID or in MS-AUTH without breaking the UI.
  - On sign-in, store the MS-AUTH refresh token, encrypted, keyed by the portal session. It
    lives in Postgres through core over the chassis signed client, never in memory.
  - The `portal_session` cookie keeps its normal long TTL. The browser never sees an MS-AUTH
    token, and nothing in the UI changes.
  - When a request arrives more than 15 minutes after the last check, the portal calls
    `POST /api/tokens/refresh`, stores the rotated token, and refreshes `roles` (admin sync).
  - Refresh tokens rotate, and reusing one revokes the whole MS-AUTH session. So the refresh
    must be single-flight per session: a Postgres row lock or a compare-and-swap on the stored
    hash, because several tabs and instances share a session. The losing request uses the
    winner's result.
  - **401 `invalid_refresh_token`** (access or app removed, Entra rejected, session expired
    after 7 days): delete the portal session. A page load redirects to `/auth/login`, which
    ends at MS-AUTH `access_denied` and the sign-in error page. An API call gets the existing
    `401 {error: "sign in", loginUrl}` response.
  - **5xx or timeout:** keep the session and retry on the next request. Availability comes
    first, as in MS-AUTH itself.
  - **7-day MS-AUTH session cap:** at that point, re-sign in on the next page load, which is
    usually silent through Entra SSO. Do it before the cap expires, so an API call never hits
    it.
  - **Sign-out:** `POST /api/tokens/revoke` and delete the stored token.
  - **Cut-off time:** someone removed from the qm app is caught within 15 minutes.
    Someone disabled in Entra is caught within MS-AUTH `ENTRA_CHECK_INTERVAL_MINUTES` (60)
    plus 15. Lower that MS-AUTH setting if an hour is too long, and keep Entra's "Assignment
    required" on the MS-AUTH enterprise app so a removed user cannot sign in again.
- **Boot checks:** the ialabs mode needs `IALABS_AUTH_URL`, `IALABS_AUTH_ISSUER`,
  `OIDC_CLIENT_ID`, and does not require `OIDC_CLIENT_SECRET` or the userinfo/JWKS OIDC vars.
  Extend the existing production checks (`bootChecks`, around line 1750) rather than
  bypassing them.

Expected size: around 60–100 lines in `oidc.ts` plus a branch in `authLogin`/`authCallback`
and in `bootChecks`. `trusted-entry.ts` uses the same helpers and is left on generic OIDC.

### 3. qm deployment config

```
PORTAL_IDP=ialabs
IALABS_AUTH_URL=https://labs.laberit.ai/auth
IALABS_AUTH_ISSUER=<MS-AUTH TOKEN_ISSUER>
OIDC_CLIENT_ID=qm
OIDC_PRINCIPAL_CLAIM=email
OIDC_ALLOWED_EMAIL_DOMAIN=laberit.com
```

The names are a proposal. Set them through the deployment config and `qm secrets set`,
never in Git. Keep `plugins/auth` (password sign-in) only as break-glass until rollout is
done.

### 4. Verify

- Unit tests in `plugins/portal/test` with a fake MS-AUTH (JWKS + `/api/tokens`): happy path,
  wrong `aud`, wrong `client_id`, app token (`pty=application`), expired token, MS-AUTH
  `error=access_denied` on the callback (no access granted), domain refusal.
- Live: the ialabs-infra local stack (`scripts/local.sh up`) or labs MS-AUTH, plus qm
  `npm run dev-instance`, signing in through Firefox.
- Independent review at high effort before merging: this is auth.

## Open questions

1. Should qm admin come from the MS-AUTH `roles` claim (`admin` gives qm org admin), or stay
   managed inside qm?
2. `access: assigned` (only people granted, like people-app) or `open` (any Laberit account)?
3. Can the portal reach MS-AUTH on the private network, or only through
   `https://labs.laberit.ai/auth`?
