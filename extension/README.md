# MiniOmni Browser Bridge

Lets your MiniOmni agent drive **one tab** in your own Chrome, so it works with your real
sign-ins and doesn't look like automation. It exists because Chrome refuses
`--remote-debugging-port` on a real profile on purpose — an extension using
`chrome.debugger` is the only supported way into the browser where you are actually
logged in.

## What it does, and its boundary

While you share a tab, the agent can read and act on that tab as you — including reading
its cookies (HttpOnly ones too) and the tokens it holds. That is the point: a site that
blocks a sandbox browser, or needs a login you already have, works because this _is_ your
browser.

The boundary is one tab at a time, inside the window you shared from. The extension attaches
Chrome's debugger to a single tab, and the agent can list the other tabs in that window and
move to one of them — so a receipt that opens in a new tab still works. Other windows, and
the rest of Chrome, stay out of reach. A tab your shared tab opens is followed automatically,
which does mean a page you are on can move the share within that window. The green banner and
the toolbar badge always mark the tab being driven. Stop sharing (or close the tab) and the
agent is locked out again.

Because that capability is real, treat the pairing token like a password: anyone holding it
and able to reach your MiniOmni can pair _their_ agent to a browser you share. The token expires
on its own, and you can revoke it in MiniOmni.

## Install (unpacked, for now)

1. Open `chrome://extensions`, turn on **Developer mode**.
2. **Load unpacked**, and pick this `extension/` folder.
3. Click the extension, enter your MiniOmni address and the pairing token from
   **MiniOmni → Keychain → Browser → Your Chrome**, and Save.
4. On any tab you want the agent to use, click the extension and **Share this tab**. A green
   `ON` badge means it is live.

## How it connects

The extension opens a WebSocket to MiniOmni's relay and speaks the Chrome DevTools Protocol over
it. MiniOmni pairs your extension with your agent by the identity inside your token, and relays the
protocol between them. Your agent points its existing `open --cdp` at the relay, so every
browse verb works against your tab unchanged.
