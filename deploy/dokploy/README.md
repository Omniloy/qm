# QM on Dokploy

A single-host Docker deployment of QM, driven by [Dokploy](https://dokploy.com) as a
Compose application. It is the same topology the `qm` CLI's `docker` backend builds
(`cli/src/backends/docker.ts`), expressed as Compose so Dokploy owns the lifecycle,
build, logs, and env storage.

Upstream's supported targets are Fly.io and AWS. This directory is a third target and
is not covered by `qm init` or the CLI's preflight checks — the env contract below is
maintained by hand against `cli/src/services.ts` and `cli/src/secrets.ts`.

## Topology

| Service  | Image                            | Exposure                                     |
| -------- | -------------------------------- | -------------------------------------------- |
| `pg`     | `postgres:16`                    | private                                      |
| `core`   | `deploy/dokploy/core.Dockerfile` | private, mounts the host Docker socket       |
| `auth`   | `deploy/auth/Dockerfile`         | private                                      |
| `web-ui` | `deploy/web-ui/Dockerfile`       | private                                      |
| `admin`  | `deploy/admin/Dockerfile`        | private                                      |
| `portal` | `deploy/portal/Dockerfile`       | **public**, via Traefik on `dokploy-network` |

The portal is the only Internet-facing service, as on Fly and AWS. It proxies the web
UI, `/admin`, and the sign-in broker's two browser routes under `/idp`.

`core` differs from the Fly/AWS image in exactly one respect: `SANDBOX_BACKEND=local`
runs each scope's agent computer as a container on this host's Docker daemon, so the
image carries the `docker` CLI and runs as root to reach the mounted socket. Anything
the agent can run in its sandbox is therefore bounded by that daemon — treat the host
as part of the trust boundary and read [`SECURITY.md`](../../SECURITY.md) before
widening access.

## Prerequisite: the sandbox image

`core` refuses to start a sandbox unless the local image exists on the host. Build it
once, on the server, and rebuild it whenever `fly/Dockerfile`, `local/Dockerfile`,
`aws/microvm-agent/agent.mjs`, or `fly/tools/*` change:

```bash
git clone https://github.com/yc-software/qm.git && cd qm
docker build --platform linux/amd64 -f fly/Dockerfile -t qm-sandbox-base:dev .
npm ci   # needed only to compute the staleness fingerprint
LOCAL_SANDBOX_IMAGE=qm-sandbox-local:latest bash scripts/local-sandbox-build.sh
```

A fingerprint mismatch only logs `[local-sandbox] sandbox image … is stale`; a missing
image is a hard failure.

The image carries two separate things, and it is worth knowing which is which:

- The **browse client** (`/opt/browser-engine/venv`, ~308MB), in every build. `skills-seed/browse`
  drives a _remote_ browser over CDP and its runner imports `browser_use`, so the client is needed
  even though the browser is not local.
- A **local headless chromium** (~700MB), because `scripts/local-sandbox-build.sh` defaults
  `INSTALL_BROWSER_ENGINE=1` even though the Dockerfile ARG itself defaults to 0. Three skills need
  it: `taste-skill` and `popular-web-designs` screenshot a dev server on the sandbox's own loopback,
  which a remote browser cannot reach, and `browse` itself says to fall back to the local binary for
  loopback URLs.

Both costs land **once, in the shared image layer** — not per sandbox. The `qm-home-*` volumes hold
`/root`, not image layers, so image size does not multiply by the number of scopes.

**Agent computers are bounded by `LOCAL_SANDBOX_CPUS` and `LOCAL_SANDBOX_MEMORY_MB`,** set in
the Compose file. `docker run` omits `--cpus`/`--memory` entirely when they are unset, which
on a single host that also runs core, Postgres and Traefik means one runaway agent can take
the whole stack down. Do not remove them.

**Do not enable Dokploy's Docker Cleanup on this host.** It runs
`docker system prune --all --force --volumes`, which reclaims every image no
running container is using — including this one, since a sandbox container only
exists while an agent is working. It also removes unused _volumes_, which would
take a stopped deployed app's data with it. Cleanup is instead a host cron
(`/usr/local/bin/qm-docker-cleanup.sh`) that prunes only untagged layers, old
build cache and long-idle networks. The `sandbox-keepalive` service in the
Compose file is a second line of defence: it holds a container open on the image
so even an aggressive prune spares it.

## The containerised-core constraint

**Read this before changing anything about core's networking or `DATA_DIR`.** QM's two
`docker` backends — `SANDBOX_BACKEND=local` and `DEPLOY_PROVIDER=docker`, the default —
are written for a core running _directly on the Docker host_. Core drives the host
daemon over the mounted socket, so anything it hands that daemon is interpreted from
the host's point of view, not core's. Here core is itself a container, which breaks
that assumption in two distinct ways. Both have already bitten this deployment.

**Addresses.** Both backends publish their workload on the host's loopback
(`-p 127.0.0.1:<port>:8080`) and hand core back `127.0.0.1:<port>`. From inside core
that is core's _own_ loopback, so nothing is reachable: sandboxes fail with
`exec daemon never became reachable: fetch failed` and deployed apps 404, while both
are demonstrably healthy when curled from the host.

`CORE_CONTAINER` names core's own container. When set, core joins the workload's
network and addresses it by container name, so nothing depends on the published host
port. It must match `container_name` on the `core` service. Host networking would also
fix it, but this host has no firewall — core would be exposed on port 8080 publicly.

**Paths.** `DATA_DIR` must be a **host bind mount at the identical path inside and
out** — never a named volume. A deployed app is started by bind-mounting its snapshot
directory, and core passes that path (`/data/deployments/<id>`) to the host daemon
verbatim. With a named volume the real files live under
`/var/lib/docker/volumes/…/_data/`, the daemon finds nothing there, silently creates an
empty directory, and the app starts with an empty `/app` and dies with
`MODULE_NOT_FOUND`. Binding the host path to a _different_ container path fails the
same way, so `DATA_HOST_DIR` is used for both sides of the bind and for `DATA_DIR`
itself — there is deliberately no second value to keep in sync.

A third, unrelated trap: the portal 404s `/d/*` on its own unless
`PORTAL_DEPLOYMENTS_ENABLED=1`, so published apps look like they do not exist and core
never sees the request.

## Application env

Set these on the Dokploy Compose application. Nothing here belongs in git.

### Identity and URLs

| Key                        | Value                                                                          |
| -------------------------- | ------------------------------------------------------------------------------ |
| `ORG_ID`                   | org slug, e.g. `omniloy`                                                       |
| `PUBLIC_URL`               | portal origin, e.g. `https://qm.example.com` — no trailing slash               |
| `PUBLIC_HOST`              | the same host without the scheme; Traefik's router rule                        |
| `HARNESS`                  | `pi`, `claude`, `codex`, or `opencode`                                         |
| `HARNESS_SECURITY_POSTURE` | `strict`, `auto`, or `dangerous`                                               |
| `LOCAL_SANDBOX_IMAGE`      | `qm-sandbox-local:latest`                                                      |
| `DATA_HOST_DIR`            | host path for core's data, e.g. `/opt/qm/data`; it _is_ `DATA_DIR` — see above |
| `ADMIN_GRANTS`             | `someone@example.com:org_admin`, comma-separated                               |

`ADMIN_GRANTS` is the only source of admin identity. `org_admin` is the sole accepted
role, and the principal is whatever `OIDC_PRINCIPAL_CLAIM` yields — the lowercased
email under the default wiring. It seeds the roster only while the `admin_grants`
table is empty; once anyone holds a grant, edit the roster at `${PUBLIC_URL}/admin`
instead, since changing the variable will no longer have any effect.

### Sign-in

| Key                         | Value                                             |
| --------------------------- | ------------------------------------------------- |
| `AUTH_EMAIL_FROM`           | verified sender, e.g. `QM <no-reply@example.com>` |
| `AUTH_ALLOWED_EMAIL_DOMAIN` | domain allowed to sign in                         |
| `AUTH_BRAND_NAME`           | name shown on the sign-in page                    |
| `RESEND_API_KEY`            | Resend key that can send as `AUTH_EMAIL_FROM`     |

The broker sends one-time sign-in links through Resend. The sender domain must be
verified in Resend, or delivery is limited to the Resend account's own address.

### Secrets

`POSTGRES_PASSWORD` and every key below must be distinct. Mint each with
`openssl rand -hex 32`, except `AUTH_SIGNING_JWK`:

```
POSTGRES_PASSWORD
CORE_SIGNING_SECRET        shared by core and every surface plugin
CAPABILITY_SECRET          scoped agent capabilities and egress grants
PORTAL_IDENTITY_SECRET     portal-bound user identity
CONNECTOR_SECRET_KEY       encrypts durable connector credentials
SKILL_SIGNING_SECRET       signs reviewed skills
PORTAL_SESSION_SECRET      portal session cookies
AUTH_TOKEN_SECRET          broker-issued tokens
AUTH_CLIENT_SECRET         portal ↔ broker client credential
ANTHROPIC_API_KEY          bills the base model
```

`AUTH_SIGNING_JWK` is a single-line P-256 private JWK:

```bash
node -e "const {generateKeyPairSync}=require('node:crypto');process.stdout.write(JSON.stringify(generateKeyPairSync('ec',{namedCurve:'P-256'}).privateKey.export({format:'jwk'})))"
```

Connector OAuth clients and the optional Slack bot tokens are not set here — enter them
at `${PUBLIC_URL}/admin` once the stack is up.

## Deploying

Point a Dokploy Compose application at this repository with
`Compose Path = ./deploy/dokploy/docker-compose.yml`, set the env above, and deploy.
Builds run on the host, so the first deploy is slow; later ones reuse layer cache.
