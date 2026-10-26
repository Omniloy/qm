# Published apps

Anything MiniOmni publishes for you — a dashboard, a demo, an internal tool — runs as its
own small web server on the instance and gets an address you can open and share.

## Where your app lives

| The instance has                      | Your app is at                      |
| ------------------------------------- | ----------------------------------- |
| an apps domain (`DEPLOY_APPS_DOMAIN`) | `https://<app-name>.<apps domain>/` |
| no apps domain                        | `https://<instance>/d/<app-name>/`  |

On an instance with an apps domain, `/d/<app-name>/` still works and forwards to the app's
own address. Ask MiniOmni for the link, or open the app from the Apps list in the web UI.

## Naming

Give the app a name when you publish it: 2–40 characters, lowercase letters, digits and
hyphens (`sales-dashboard`, `maria-demo`). The name becomes the subdomain, so pick one
you are happy to share. Names are unique across the whole instance. An app published
without a name is reachable by its id instead.

## Who can open it

Only people signed in to the instance. The app starts private to you; share it from the
app's menu or ask MiniOmni to share it with someone. Anyone else who opens the link sees a
page where they can request access, and you decide. As the owner, opening your app shows
it with an editing panel beside it so you can ask for changes while you look at it.

## Building apps that work

- **Any framework works on an apps domain.** Vite, React, Next.js static exports and
  plain HTML all load normally, because the app has its own origin.
- **Without an apps domain**, the app runs inside a strict sandbox on the instance's
  origin. Pages that load ES-module scripts or stylesheets with `crossorigin` (the default
  output of Vite and most bundlers), or that call their own API with `fetch()`, render
  blank: the browser sends those requests without your sign-in and the console shows a
  CORS error. Ask the operator to enable an apps domain (see
  [`deploy/dokploy/README.md`](../deploy/dokploy/README.md#published-apps-on-their-own-subdomains-recommended))
  rather than working around it.
- **Use relative paths** (`./assets/app.js`, `fetch("api/items")`) so the app works at
  both addresses. A root-relative path such as `/api/items` points at the instance itself
  when the app is served under `/d/<app-name>/`.
- **Listen on `0.0.0.0`, port 8080** (or `$PORT`). The app's server receives requests
  already authenticated; don't build your own sign-in on top.
- **No WebSockets yet.** Upgrade requests are not passed through to apps, so realtime
  features built on WebSockets or socket.io fail; poll instead.
