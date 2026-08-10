# QM Browser Bridge

Lets your QM agent drive **one tab** in your own Chrome, so it works with your real
sign-ins and doesn't look like automation. It exists because Chrome refuses
`--remote-debugging-port` on a real profile on purpose — an extension using
`chrome.debugger` is the only supported way into the browser where you are actually
logged in.

## What it does, and its boundary

While you share a tab, the agent can read and act on that tab as you — including reading
its cookies (HttpOnly ones too) and the tokens it holds. That is the point: a site that
blocks a sandbox browser, or needs a login you already have, works because this _is_ your
browser.

The boundary is the tab. The extension attaches Chrome's debugger to exactly the one tab
you nominate and nothing else — other tabs, other windows, and the rest of Chrome stay out
of reach. Stop sharing (or close the tab) and the agent is locked out again.

Because that capability is real, treat the pairing token like a password: anyone holding it
and able to reach your QM can pair _their_ agent to a browser you share. The token expires
on its own, and you can revoke it in QM.

## Install (unpacked, for now)

1. Open `chrome://extensions`, turn on **Developer mode**.
2. **Load unpacked**, and pick this `extension/` folder.
3. Click the extension, enter your QM address and the pairing token from
   **QM → Keychain → Browser → Your Chrome**, and Save.
4. On any tab you want the agent to use, click the extension and **Share this tab**. A green
   `ON` badge means it is live.

## How it connects

The extension opens a WebSocket to QM's relay and speaks the Chrome DevTools Protocol over
it. QM pairs your extension with your agent by the identity inside your token, and relays the
protocol between them. Your agent points its existing `open --cdp` at the relay, so every
browse verb works against your tab unchanged.
