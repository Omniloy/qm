# QM Browser Bridge

Lets your QM agent use **your own Chrome**, so it works with your real sign-ins and doesn't
look like automation. It exists because Chrome refuses `--remote-debugging-port` on a real
profile on purpose — an extension using `chrome.debugger` is the only supported way into the
browser where you are actually logged in.

## What it does, and its boundary

While the extension is connected, the agent can open tabs of its own and read and act on any
tab in this browser as you — including reading its cookies (HttpOnly ones too) and the tokens
it holds. That is the point: a site that blocks a sandbox browser, or needs a login you already
have, works because this _is_ your browser.

There is nothing to click first. When the agent needs a page and is not already on one, the
extension opens a tab in your front window and drives it. The agent can list every open tab,
in every window, and move to any of them; Chrome's own pages, the Web Store and other
extensions' pages stay off limits. It drives one tab at a time: the green banner and the
toolbar badge always mark that tab. A tab it opens is followed automatically, and when the
tab it is on closes it goes back to the one before.

**Share this tab** points the agent at the tab you are on. **Stop** (or Cancel on Chrome's
"started debugging this browser" bar) is a real stop: the agent is locked out, and nothing
re-opens until you press Share this tab again, or remove and reinstall the extension.

Because that capability is real, treat the pairing token like a password: anyone holding it
and able to reach your QM can stand in for your Chrome in front of your agent, seeing the pages
it opens and what it types. While the extension is connected, QM hands it a fresh token once a
day, so a pairing lasts about 30 days from the last time Chrome was connected.

## Ending a pairing

Each person has one current pairing, and QM keeps its number in its database. Every token
carries the number of the pairing it belongs to. QM refuses one from an older pairing when it
connects, and checks an open connection again every minute, before it would hand it a fresh token.

- **Disconnect Chrome** (QM → Keychain → Browser → Your Chrome) ends the pairing: the extension
  is cut off within a minute, every token it ever held stops working, and the agent stops using
  your Chrome. To use it again, download the extension and load it fresh.
- **Download again** starts a new pairing, so the copy you had loaded stops connecting. Remove
  it and load the new folder.

The QM server you used cuts the extension off at once; another one notices on its next check. If
QM cannot read the pairing, it closes the connection rather than trust it.

Tokens from before pairings were numbered count as pairing 0, the number everyone starts with, so
they keep working, and keep being renewed, until the person downloads again or disconnects.
Rotating QM's capability secret still ends every pairing at once.

## Install (unpacked, for now)

1. Open `chrome://extensions`, turn on **Developer mode**.
2. **Load unpacked**, and pick this `extension/` folder.
3. Click the extension, enter your QM address and the pairing token from
   **QM → Keychain → Browser → Your Chrome**, and Save.
4. That's it — the agent opens a tab when it needs one. To point it at a tab you already have
   open, click the extension and **Share this tab**. A green `●` badge marks the tab in use.

## How it connects

The extension opens a WebSocket to QM's relay and speaks the Chrome DevTools Protocol over
it. QM pairs your extension with your agent by the identity inside your token, and relays the
protocol between them. Your agent points its existing `open --cdp` at the relay, so every
browse verb works against your tabs unchanged. The extension sends a small keepalive every
20 seconds so Chrome does not put it to sleep and the agent can always reach it.

Only your own agent, working live in your DM with QM, can reach your browser. Each such turn gets
its own short-lived relay key; channel, group, and scheduled turns never get one, so nothing
other people start, and nothing that runs on a timer, can drive your browser.
