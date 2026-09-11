#!/usr/bin/env python3
"""Drive a real browser one call at a time.

Each invocation connects, does one thing, and exits — so an agent stays inside
its turn instead of handing a whole task to a background process it cannot
steer. The browser itself outlives the call: its CDP endpoint is recorded in a
state file, so the next call reattaches.

  browser.py open [--cdp URL]            attach to the person's Chrome, or one elsewhere
  browser.py go URL                      navigate, wait for load
  browser.py snapshot [--max N]          numbered interactive elements
  browser.py read [--selector S]         visible text
  browser.py click REF|--selector S      real mouse click
  browser.py type TEXT [--into REF] [--enter]
  browser.py key NAME                    Enter, Tab, Escape, ArrowDown...
  browser.py scroll [--by N|--to top|bottom]
  browser.py screenshot [--path P]
  browser.py status                      is anything open, and where
  browser.py close                       detach from the browser

Refs come from `snapshot` and are stamped onto the DOM, so `click 3` acts on the
thing that was listed as 3. They survive until the page changes structurally;
take a fresh snapshot after a navigation.

Deliberately free of provider concepts. Every verb is plain CDP, so the same
surface works against a hosted session or a browser someone is driving through
an extension — the transport is a CDP URL and nothing else.

Speaks WebSocket over the standard library so it runs under any python3 in the
image, with no virtualenv to activate and nothing to install.
"""

import argparse
import base64
import json
import os
import re
import socket
import ssl
import struct
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

STATE_DIR = os.path.expanduser("~/.browser")
STATE_FILE = os.path.join(STATE_DIR, "state.json")


def die(msg, code=1):
    print(msg, file=sys.stderr)
    sys.exit(code)


# --------------------------------------------------------------- websocket

class WS:
    """A minimal synchronous WebSocket client, enough for CDP on loopback.

    CDP screenshots arrive as multi-megabyte frames, so reads handle 64-bit
    lengths and continuation frames. Server frames are never masked; ours
    always are, per RFC 6455.
    """

    def __init__(self, url, timeout=60):
        u = urllib.parse.urlsplit(url)
        if u.scheme not in ("ws", "wss"):
            die(f"not a websocket URL: {url.split('?')[0][:60]}")
        secure = u.scheme == "wss"
        host = u.hostname or ""
        port = u.port or (443 if secure else 80)
        # A remote endpoint often carries its credentials in the query string
        # and no path at all, so the query has to survive into the request line.
        path = (u.path or "/") + (f"?{u.query}" if u.query else "")
        self.sock = socket.create_connection((host, port), timeout=timeout)
        if secure:
            self.sock = ssl.create_default_context().wrap_socket(self.sock, server_hostname=host)
        self.sock.settimeout(timeout)
        key = base64.b64encode(os.urandom(16)).decode()
        req = (
            f"GET {path} HTTP/1.1\r\nHost: {host}:{port}\r\n"
            f"Upgrade: websocket\r\nConnection: Upgrade\r\n"
            f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n"
        )
        self.sock.sendall(req.encode())
        buf = b""
        while b"\r\n\r\n" not in buf:
            chunk = self.sock.recv(4096)
            if not chunk:
                die("the browser closed the connection during the handshake")
            buf += chunk
        if b" 101 " not in buf.split(b"\r\n")[0]:
            die(f"websocket upgrade refused: {buf.split(chr(13).encode())[0][:80]!r}")
        self.rest = buf.split(b"\r\n\r\n", 1)[1]

    def _recv_exact(self, n):
        out = self.rest[:n]
        self.rest = self.rest[n:]
        while len(out) < n:
            try:
                chunk = self.sock.recv(min(1 << 20, n - len(out)))
            except (socket.timeout, TimeoutError):
                self.rest = out + self.rest
                raise
            if not chunk:
                die("the browser closed the connection")
            out += chunk
        return out

    def send(self, text):
        payload = text.encode()
        n = len(payload)
        header = bytearray([0x81])
        if n < 126:
            header.append(0x80 | n)
        elif n < (1 << 16):
            header.append(0x80 | 126)
            header += struct.pack(">H", n)
        else:
            header.append(0x80 | 127)
            header += struct.pack(">Q", n)
        mask = os.urandom(4)
        header += mask
        masked = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
        self.sock.sendall(bytes(header) + masked)

    def recv(self):
        chunks = []
        while True:
            b0, b1 = self._recv_exact(2)
            fin, opcode = b0 & 0x80, b0 & 0x0F
            n = b1 & 0x7F
            if n == 126:
                n = struct.unpack(">H", self._recv_exact(2))[0]
            elif n == 127:
                n = struct.unpack(">Q", self._recv_exact(8))[0]
            data = self._recv_exact(n)
            if opcode == 0x8:
                die("the browser closed the connection")
            if opcode == 0x9:  # ping
                continue
            chunks.append(data)
            if fin:
                break
        return b"".join(chunks).decode("utf-8", "replace")

    def close(self):
        try:
            self.sock.close()
        except Exception:
            pass


class CDP:
    """A CDP connection, optionally scoped to one page.

    A local chromium hands out a per-page websocket, so commands need no
    addressing. A remote endpoint hands out a browser-level one instead, where
    every command must name the page it is for. `session_id` carries that, and
    is the only difference between driving a browser here and one somewhere
    else — which is the point: the verbs above do not change.
    """

    def __init__(self, ws_url, timeout=60, session_id=None):
        self.ws = WS(ws_url, timeout)
        self.n = 0
        self.session_id = session_id
        self.events = []

    def call(self, method, **params):
        self.n += 1
        mid = self.n
        msg = {"id": mid, "method": method, "params": params}
        if self.session_id:
            msg["sessionId"] = self.session_id
        self.ws.send(json.dumps(msg))
        while True:
            msg = json.loads(self.ws.recv())
            if msg.get("id") == mid:
                if "error" in msg:
                    raise RuntimeError(f"{method}: {msg['error'].get('message', msg['error'])}")
                return msg.get("result", {})
            if msg.get("method"):
                self.events.append(msg)
                del self.events[:-200]

    def wait_event(self, method, seconds=25):
        """The next event of this kind, from the buffer or from the wire."""
        for i, held in enumerate(self.events):
            if held.get("method") == method:
                return self.events.pop(i).get("params", {})
        deadline = time.time() + seconds
        previous = self.ws.sock.gettimeout()
        try:
            while time.time() < deadline:
                self.ws.sock.settimeout(max(1, deadline - time.time()))
                try:
                    msg = json.loads(self.ws.recv())
                except (socket.timeout, TimeoutError, OSError):
                    break
                if msg.get("method") == method:
                    return msg.get("params", {})
                if msg.get("method"):
                    self.events.append(msg)
                    del self.events[:-200]
        finally:
            self.ws.sock.settimeout(previous)
        raise RuntimeError(f"{method} never arrived")

    def eval(self, expr, timeout_note=""):
        r = self.call("Runtime.evaluate", expression=expr, returnByValue=True,
                      awaitPromise=True)
        if r.get("exceptionDetails"):
            exc = r["exceptionDetails"]
            msg = exc.get("exception", {}).get("description") or exc.get("text")
            raise RuntimeError(f"page script failed{timeout_note}: {str(msg)[:200]}")
        return r.get("result", {}).get("value")

    def cookies(self, urls=None):
        """Every cookie the site holds, HttpOnly included.

        This is the point of driving a real browser rather than fetching: a
        curl-based skill needs the session the person is signed in with, and an
        HttpOnly cookie — the kind that actually authenticates — is invisible to
        `document.cookie`. CDP hands it over; page script cannot.
        """
        params = {"urls": urls} if urls else {}
        return self.call("Network.getCookies", **params).get("cookies", [])

    def storage(self, which):
        """A snapshot of localStorage or sessionStorage as a plain object.

        Some sites keep their bearer token here instead of in a cookie, so a
        skill that calls their API needs to read it out.
        """
        store = "sessionStorage" if which == "session" else "localStorage"
        return self.eval(
            "JSON.stringify(Object.fromEntries(Object.entries(%s)))" % store) or "{}"

    def watch(self, match, seconds, want_bodies):
        """Collect requests and responses whose URL contains `match`.

        The credential some sites hand out never sits in a cookie or in storage
        at all: it arrives once, in the body of a login response, and is only
        ever held in memory. The single way to capture it is to be listening
        when it lands — so enable the network domain, watch traffic go by, and
        return what matched. Request headers come too, because the same login
        often carries device or location identifiers the API then demands back.
        """
        self.call("Network.enable")
        by_req = {}
        deadline = time.time() + seconds
        old = self.ws.sock.gettimeout()
        try:
            while time.time() < deadline:
                self.ws.sock.settimeout(max(0.1, deadline - time.time()))
                try:
                    msg = json.loads(self.ws.recv())
                except socket.timeout:
                    continue
                method, pr = msg.get("method"), msg.get("params", {})
                if method == "Network.requestWillBeSent":
                    url = pr.get("request", {}).get("url", "")
                    if match in url:
                        e = by_req.setdefault(pr.get("requestId"), {})
                        e["url"] = url
                        e["requestHeaders"] = pr.get("request", {}).get("headers", {})
                elif method == "Network.responseReceived":
                    url = pr.get("response", {}).get("url", "")
                    if match in url:
                        e = by_req.setdefault(pr.get("requestId"), {})
                        e["url"] = url
                        e["status"] = pr.get("response", {}).get("status")
                        e["responseHeaders"] = pr.get("response", {}).get("headers", {})
                elif method == "Network.loadingFinished" and want_bodies:
                    rid = pr.get("requestId")
                    if rid in by_req and "body" not in by_req[rid]:
                        try:
                            self.ws.sock.settimeout(old)
                            b = self.call("Network.getResponseBody", requestId=rid)
                            by_req[rid]["body"] = b.get("body", "")
                            by_req[rid]["bodyBase64"] = b.get("base64Encoded", False)
                        except Exception:
                            pass  # body already evicted; the meta is still useful
        finally:
            self.ws.sock.settimeout(old)
        return [v for v in by_req.values() if v.get("url")]

    def close(self):
        self.ws.close()


# ------------------------------------------------------------------- state

def read_state():
    try:
        with open(STATE_FILE) as f:
            return json.load(f)
    except Exception:
        return None


def write_state(state):
    os.makedirs(STATE_DIR, exist_ok=True)
    tmp = STATE_FILE + f".{os.getpid()}.tmp"
    with open(tmp, "w") as f:
        json.dump(state, f)
    os.replace(tmp, STATE_FILE)


def clear_state():
    try:
        os.remove(STATE_FILE)
    except FileNotFoundError:
        pass


# ------------------------------------------------------------------- core

def core_call(method, path, body=None, timeout=8):
    """Talk to MiniOmni. Returns None when MiniOmni is unreachable or says no.

    Every caller treats failure as "no pane", never as "no browser": the person
    asked to browse, and losing the picture is not a reason to refuse the task.
    """
    status, payload = core_call_status(method, path, body, timeout)
    return payload if status and 200 <= status < 300 else None


def core_call_status(method, path, body=None, timeout=8):
    """As above, but says what MiniOmni answered.

    Some refusals are meant to be obeyed rather than shrugged off — "there is
    no room for another browser" is a real answer, not a failed lookup.
    """
    base = os.environ.get("AGENT_API_URL", "").rstrip("/")
    token = os.environ.get("AGENT_API_TOKEN", "")
    if not base or not token:
        return None, None
    req = urllib.request.Request(
        f"{base}{path}", method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"x-agent-capability": token,
                 **({"content-type": "application/json"} if body is not None else {})},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read().decode()
            return r.status, (json.loads(raw) if raw.strip() else {})
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read().decode())
        except Exception:
            return e.code, {}
    except Exception:
        return None, None


def control_mode(state):
    """Who has the wheel right now, as far as MiniOmni knows.

    Unknown counts as the agent's: a browser nobody registered still has to be
    drivable, and refusing on a failed lookup would strand the task.
    """
    sid = state.get("sessionId")
    if not sid or not state.get("registered"):
        return "agent"
    r = core_call("GET", f"/v1/browser-sessions/{sid}/state", timeout=5)
    if not isinstance(r, dict):
        return "agent"
    return r.get("controlMode") or "agent"


def attach_remote(cdp_url, timeout=60):
    """Attach to a page on a browser somewhere else.

    A remote endpoint speaks browser-level CDP, so there is a step a local one
    does not need: find a page, attach to it, and address everything after that
    to the session it hands back.
    """
    c = CDP(cdp_url, timeout)
    targets = c.call("Target.getTargets").get("targetInfos", [])
    page = next((t for t in targets if t.get("type") == "page"), None)
    if not page:
        page = c.call("Target.createTarget", url="about:blank")
        target_id = page["targetId"]
    else:
        target_id = page["targetId"]
    # flatten puts the session on the same socket rather than a nested protocol,
    # which is what lets one connection be used like a page connection.
    c.session_id = c.call("Target.attachToTarget", targetId=target_id, flatten=True)["sessionId"]
    return c


def connect():
    """Attach to the browser this person already has open, wherever it runs."""
    state = read_state()
    if not state or not state.get("cdpUrl"):
        die("No browser is open. Run: browser.py open")
    try:
        return attach_remote(state["cdpUrl"]), state
    except SystemExit:
        raise
    except Exception as e:
        clear_state()
        die(f"The browser that was open has gone ({str(e)[:80]}). Run: browser.py open")


# ------------------------------------------------------------------- verbs

# Stamping refs onto the DOM keeps `click 3` bound to what `snapshot` listed as
# 3, without inventing brittle CSS paths for an agent to copy around.
SNAPSHOT_JS = r"""
(() => {
  const SEL = 'a[href],button,input,textarea,select,summary,[role=button],[role=link],' +
              '[role=tab],[role=checkbox],[role=radio],[onclick],[contenteditable=""],' +
              '[contenteditable=true]';
  document.querySelectorAll('[data-qmref]').forEach(e => e.removeAttribute('data-qmref'));
  const seen = [], out = [];
  let n = 0;
  for (const el of document.querySelectorAll(SEL)) {
    const r = el.getBoundingClientRect();
    const st = getComputedStyle(el);
    if (!r.width || !r.height) continue;
    if (st.visibility === 'hidden' || st.display === 'none' || +st.opacity === 0) continue;
    if (el.disabled) continue;
    if (seen.some(p => p.contains(el))) continue;   // skip nested duplicates
    seen.push(el);
    n += 1;
    el.setAttribute('data-qmref', String(n));
    const tag = el.tagName.toLowerCase();
    const label = (
      el.getAttribute('aria-label') || el.getAttribute('placeholder') ||
      el.getAttribute('title') || el.value || el.innerText || el.getAttribute('name') || ''
    ).replace(/\s+/g, ' ').trim().slice(0, 70);
    const kind = tag === 'a' ? 'link'
      : tag === 'input' ? ('input:' + (el.type || 'text'))
      : tag === 'textarea' ? 'input:textarea'
      : tag === 'select' ? 'select' : tag === 'button' ? 'button' : (el.getAttribute('role') || tag);
    const off = (r.top < 0 || r.top > innerHeight) ? ' (off-screen)' : '';
    out.push(`[${n}] ${kind} ${JSON.stringify(label)}${off}`);
  }
  return JSON.stringify({count: n, items: out});
})()
"""

READ_JS = r"""
(() => {
  const root = %s;
  if (!root) return JSON.stringify({missing: true});
  const t = (root.innerText || '').replace(/\n{3,}/g, '\n\n').trim();
  return JSON.stringify({text: t, chars: t.length, title: document.title, url: location.href});
})()
"""

# A page that blocks automation usually says so in a nearly-empty document.
# Naming that explicitly turns a confusing blank screen into an actionable
# result, and is what tells the caller to reach for a different browser.
BLOCK_JS = r"""
(() => {
  const t = (document.body ? document.body.innerText : '').replace(/\s+/g, ' ').trim();
  const hit = /just a moment|checking your browser|verify you are human|unusual traffic|
access denied|are you a robot|enable javascript and cookies|access is temporarily restricted|
developer or inspection tools/i.test(t);
  // An all-but-empty document on a real http(s) page is the other tell: a
  // challenge that refused to render. about:blank is legitimately empty.
  const real = location.protocol.startsWith('http');
  return JSON.stringify({blocked: hit || (real && t.length < 40),
                         chars: t.length, sample: t.slice(0, 160)});
})()
""".replace("|\n", "|")


def wait_ready(c, seconds=25):
    end = time.time() + seconds
    while time.time() < end:
        try:
            if c.eval("document.readyState") in ("interactive", "complete"):
                return True
        except Exception:
            pass
        time.sleep(0.2)
    return False


def box_of(c, ref=None, selector=None):
    if ref is not None:
        expr = f'document.querySelector({json.dumps(f"[data-qmref={json.dumps(str(ref))}]")})'
    else:
        expr = f"document.querySelector({json.dumps(selector)})"
    raw = c.eval(f"""
      (() => {{ const el = {expr};
        if (!el) return null;
        el.scrollIntoView({{block: 'center', inline: 'center'}});
        const r = el.getBoundingClientRect();
        return JSON.stringify({{x: r.x + r.width / 2, y: r.y + r.height / 2,
                                tag: el.tagName.toLowerCase()}}); }})()
    """)
    if not raw:
        die(f"nothing matches {'ref ' + str(ref) if ref is not None else selector!r}. "
            "Run: browser.py snapshot")
    return json.loads(raw)


def do_click(c, ref, selector):
    b = box_of(c, ref, selector)
    for typ in ("mousePressed", "mouseReleased"):
        c.call("Input.dispatchMouseEvent", type=typ, x=b["x"], y=b["y"],
               button="left", clickCount=1)
    time.sleep(0.6)
    wait_ready(c, 10)
    info = json.loads(c.eval("JSON.stringify({url: location.href, title: document.title})"))
    print(f"clicked {b['tag']} -> {info['title'][:60]} ({info['url'][:100]})")


def click_without_waiting(c, ref):
    """Click and return immediately.

    do_click settles the page and reads location afterwards, which never comes
    back when the click turned the tab into Chrome's PDF viewer — the exact
    case interception exists for.
    """
    b = box_of(c, ref, "")
    for typ in ("mousePressed", "mouseReleased"):
        c.call("Input.dispatchMouseEvent", type=typ, x=b["x"], y=b["y"],
               button="left", clickCount=1)
    return b


MAX_NAME = 120


def safe_output_path(folder, name):
    """Where a download is allowed to land.

    Both halves are attacker-influenced: the folder and name come from an agent
    that has been reading a web page, and the fallback name comes from the
    server. A file that escapes the workspace is the whole risk of this verb.
    """
    leaf = os.path.basename((name or "").strip().replace("\\", "/").rstrip("/")) or "download.bin"
    if leaf in (".", ".."):
        leaf = "download.bin"
    leaf = leaf[:MAX_NAME]
    root = os.path.realpath(os.getcwd())
    folder = (folder or "").strip()
    if os.path.isabs(folder) or ".." in folder.replace("\\", "/").split("/"):
        die(f"--dir must stay inside the workspace, and {folder!r} does not.")
    outdir = os.path.realpath(os.path.join(root, folder))
    if outdir != root and not outdir.startswith(root + os.sep):
        die(f"--dir must stay inside the workspace, and {folder!r} does not.")
    path = os.path.realpath(os.path.join(outdir, leaf))
    if not path.startswith(root + os.sep):
        die("That filename would write outside the workspace.")
    return outdir, path


def tab_ids(c):
    """The tabs open right now, or None when this browser has no notion of them."""
    try:
        return {t["tabId"] for t in c.call("qm.listTabs").get("tabs", [])}
    except Exception:
        return None


def new_tab_url(c, before):
    """The URL of a tab that appeared since, if one did.

    A Download button that targets a new tab puts the file somewhere our
    interception is not listening, and the new tab is often a viewer we cannot
    drive — but its URL is all we need to fetch the file properly.
    """
    try:
        for t in c.call("qm.listTabs").get("tabs", []):
            if t["tabId"] not in before and str(t.get("url", "")).startswith("http"):
                return t["url"]
    except Exception:
        return ""
    return ""


def href_behind(c, ref):
    """The link a ref sits in, if any.

    A file behind a plain link never needs clicking: fetching the href keeps the
    tab where it is, so nothing navigates into a viewer and nothing breaks.
    """
    sel = json.dumps(f'[data-qmref="{ref}"]')
    try:
        got = c.eval("(() => { const e = document.querySelector(%s);"
                     " const a = e && e.closest && e.closest('a');"
                     " return (a && a.href) || ''; })()" % sel)
    except Exception:
        return ""
    return got if isinstance(got, str) and got.startswith("http") else ""


def press_key(c, name):
    """Send a key the way a keyboard would.

    Enter needs the full rawKeyDown / char / keyUp sequence: with only
    keyDown+keyUp Chromium never produces the keypress that submits a form, so
    a search box takes the text and then quietly does nothing.
    """
    code, key = KEYS[name]
    c.call("Input.dispatchKeyEvent", type="rawKeyDown", key=key, code=key,
           windowsVirtualKeyCode=code, nativeVirtualKeyCode=code)
    if name == "Enter":
        c.call("Input.dispatchKeyEvent", type="char", text="\r", key=key, code=key,
               windowsVirtualKeyCode=code, nativeVirtualKeyCode=code)
    elif name == "Tab":
        c.call("Input.dispatchKeyEvent", type="char", text="\t", key=key, code=key,
               windowsVirtualKeyCode=code, nativeVirtualKeyCode=code)
    c.call("Input.dispatchKeyEvent", type="keyUp", key=key, code=key,
           windowsVirtualKeyCode=code, nativeVirtualKeyCode=code)


def focus_field(c, into_ref, into_sel):
    if into_ref is not None or into_sel:
        b = box_of(c, into_ref, into_sel)
        for typ in ("mousePressed", "mouseReleased"):
            c.call("Input.dispatchMouseEvent", type=typ, x=b["x"], y=b["y"],
                   button="left", clickCount=1)
        time.sleep(0.15)


def same_origin(a, b):
    def parts(url):
        u = urllib.parse.urlparse(url or "")
        scheme = (u.scheme or "").lower()
        port = u.port or {"https": 443, "http": 80}.get(scheme)
        return scheme, (u.hostname or "").lower(), port
    pa, pb = parts(a), parts(b)
    return pa[1] != "" and pa == pb


def do_type(c, text, into_ref, into_sel, enter):
    focus_field(c, into_ref, into_sel)
    # insertText goes through the real input pipeline in one shot; per-character
    # key events are slower and no more faithful for plain text.
    c.call("Input.insertText", text=text)
    if enter:
        press_key(c, "Enter")
        time.sleep(1.0)
        wait_ready(c, 25)
        info = json.loads(c.eval("JSON.stringify({url: location.href, title: document.title})"))
        print(f"typed {len(text)} chars and pressed Enter -> "
              f"{info['title'][:60]} ({info['url'][:100]})")
        return
    print(f"typed {len(text)} chars")


KEYS = {
    "Enter": (13, "Enter"), "Tab": (9, "Tab"), "Escape": (27, "Escape"),
    "Backspace": (8, "Backspace"), "ArrowDown": (40, "ArrowDown"),
    "ArrowUp": (38, "ArrowUp"), "ArrowLeft": (37, "ArrowLeft"),
    "ArrowRight": (39, "ArrowRight"), "PageDown": (34, "PageDown"),
    "PageUp": (33, "PageUp"), "Home": (36, "Home"), "End": (35, "End"),
}


def main():
    p = argparse.ArgumentParser(prog="browser.py", add_help=True)
    sub = p.add_subparsers(dest="cmd", required=True)

    po = sub.add_parser("open", help="attach to the person's Chrome, or reattach")
    pp = sub.add_parser("pane", help="show a browser you started elsewhere in the person's pane")
    pp.add_argument("--provider", default="", help="the provider id, as named by BROWSE_PROVIDER")
    pp.add_argument("--session", default="", help="that provider's session id")
    pp.add_argument("--url", default="", help="the provider's viewer URL — never the CDP URL")
    pp.add_argument("--minutes", type=int, default=30, help="how long the pane should expect it to live")
    pp.add_argument("--end", action="store_true", help="take it out of the pane again")
    # Drive a browser that is already running somewhere else, given its CDP
    # endpoint. Every verb behaves identically against it — a CDP URL is plain
    # protocol, not a vendor concept, which is what keeps this surface honest.
    po.add_argument("--cdp", help="attach to an existing browser given its CDP endpoint")

    pg = sub.add_parser("go"); pg.add_argument("url")
    ps = sub.add_parser("snapshot"); ps.add_argument("--max", type=int, default=60)
    pr = sub.add_parser("read")
    pr.add_argument("--selector"); pr.add_argument("--max", type=int, default=6000)
    pc = sub.add_parser("click")
    pc.add_argument("ref", nargs="?", type=int); pc.add_argument("--selector")
    pc.add_argument("--at", help="X,Y in page coordinates")
    pt = sub.add_parser("type")
    pt.add_argument("text", nargs="?"); pt.add_argument("--into", type=int)
    pt.add_argument("--into-selector"); pt.add_argument("--enter", action="store_true")
    # Base64 so arbitrary text never has to survive a shell — interpolating a
    # password with a quote in it into a command line is how it becomes an
    # injection.
    pt.add_argument("--text-b64")
    pts = sub.add_parser("type-secret",
                         help="fill a stored password into a field without ever handling the literal")
    pts.add_argument("--keychain", required=True, help="the fill-credential id from the keychain")
    pts.add_argument("--into", type=int); pts.add_argument("--into-selector")
    pk = sub.add_parser("key"); pk.add_argument("name")
    psc = sub.add_parser("scroll")
    psc.add_argument("--by", type=int, default=600); psc.add_argument("--to")
    psh = sub.add_parser("screenshot"); psh.add_argument("--path", default="/tmp/page.jpg")
    sub.add_parser("status")
    pdl = sub.add_parser("download", help="save a file into the workspace without downloading it in the browser")
    pdl.add_argument("url", nargs="?", default="")
    pdl.add_argument("--click", type=int, default=None,
                     help="a ref from snapshot: click it and keep whatever file it starts")
    pdl.add_argument("--as", dest="name", default="", help="what to call it (default: from the server)")
    pdl.add_argument("--dir", default="downloads", help="workspace folder to put it in")
    pdl.add_argument("--max-mb", dest="max_mb", type=int, default=100)
    pdl.add_argument("--timeout", type=int, default=25)
    sub.add_parser("tabs", help="the tabs you can move to, in the window you are sharing from")
    ptab = sub.add_parser("tab", help="move the share to another tab in that window")
    ptab.add_argument("tab_id", type=int)
    pc = sub.add_parser("cookies", help="the site's cookies, HttpOnly included, as JSON")
    pc.add_argument("--url", default="", help="only cookies a request to this URL would send")
    pc.add_argument("--domain", default="", help="keep only cookies whose domain contains this")
    ps = sub.add_parser("storage", help="localStorage (or --session) as JSON")
    ps.add_argument("--session", action="store_true", help="read sessionStorage instead")
    ps.add_argument("--key", default="", help="one key's value rather than the whole store")
    pn = sub.add_parser("net", help="capture requests/responses whose URL contains a string")
    pn.add_argument("match", help="capture traffic whose URL contains this substring")
    pn.add_argument("--for", dest="seconds", type=float, default=60.0, help="how many seconds to watch")
    pn.add_argument("--bodies", action="store_true", help="also capture response bodies (e.g. a login token)")
    sub.add_parser("close")

    a = p.parse_args()

    # ------------------------------------------------------------ open
    if a.cmd == "pane":
        # A hosted browser runs on someone else's hardware; it is shown by
        # embedding the provider's own viewer. Without this the person is handed
        # a bare link in the conversation and has to leave the app to watch
        # their own browser work.
        if a.end:
            if not a.session:
                die("Say which session to remove: pane --end --session ID")
            core_call("DELETE", f"/v1/browser-sessions/{a.session}")
            print("Taken out of the pane.")
            return
        if not (a.provider and a.session and a.url):
            die("pane needs --provider, --session and --url (the viewer URL, not the CDP URL).")
        status, payload = core_call_status("POST", "/v1/browser-sessions", {
            "provider": a.provider,
            "sessionId": a.session,
            "viewer": "iframe",
            "liveViewUrl": a.url,
            "expiresAt": int((time.time() + max(1, a.minutes) * 60) * 1000),
        })
        if status == 409:
            die((payload or {}).get("message", "there is no room for another browser right now"))
        if not (status and 200 <= status < 300):
            die(f"MiniOmni did not accept it ({status}): {(payload or {}).get('message', 'no reason given')}\n"
                "Browsing still works — say the pane is unavailable and give them the viewer link instead.")
        state = read_state() or {}
        state["sessionId"] = a.session
        state["registered"] = True
        write_state(state)
        print("Showing in the pane. They can watch it and take control there.")
        return

    if a.cmd == "open":
        # The person's own Chrome, chosen in the app, is not a hosted provider
        # with a doc and a create step: the extension is already running it and
        # the relay is already reachable. Resolve it to a --cdp attach BEFORE
        # anything else, so plain `open` just works.
        chosen = os.environ.get("BROWSE_PROVIDER", "").strip()
        via_extension = chosen == "extension" and not a.cdp
        if via_extension:
            relay = os.environ.get("QM_RELAY_URL", "").strip()
            if not relay:
                die("This person chose their own Chrome, but no relay URL reached this turn.\n"
                    "Their extension may not be connected. Tell them to open the MiniOmni Browser Bridge\n"
                    "extension and share a tab, then run: open")
            a.cdp = relay

        if a.cdp:
            # Someone else started this one; it is theirs to close, and its
            # pane (if it has one) is registered by whoever created it.
            try:
                c = attach_remote(a.cdp)
            except (Exception, SystemExit) as e:
                if not via_extension:
                    raise
                clear_state()
                die("Their Chrome is not sharing a tab, so there is nothing to drive "
                    f"({str(e)[:80]}).\n"
                    "Ask them to open the MiniOmni Browser Bridge extension and press Share this tab,\n"
                    "then run: open\n"
                    "Do NOT quietly attach to a different browser: it has none of their sign-ins, "
                    "and a task aimed at their own browser will fail in a way that looks like your "
                    "mistake rather than a disconnected extension.")
            c.close()
            write_state({"provider": "remote", "cdpUrl": a.cdp, "startedAt": int(time.time())})
            print("Attached to the browser you pointed at. Every verb works the same.")
            return

        # No extension relay and no --cdp endpoint: there is nothing to attach
        # to. Say how to connect one rather than launching anything, because
        # there is nothing to launch.
        if chosen and chosen != "extension" and re.fullmatch(r"[a-z][a-z0-9-]*", chosen):
            die(f"This person chose the {chosen} browser.\n"
                f"Read skills/browse/providers/{chosen}.md, create the browser it describes,\n"
                "then come back and run: open --cdp \"$CDP_URL\".")
        die("No browser is connected for this person.\n"
            "Their own Chrome: ask them to open the MiniOmni Browser Bridge extension and share a tab,\n"
            "then run: open.\n"
            "A hosted browser: read its provider doc under skills/browse/providers/, create it,\n"
            "then run: open --cdp \"$CDP_URL\".")

    # ------------------------------------------------------------ status
    if a.cmd == "status":
        state = read_state()
        if not state or not state.get("cdpUrl"):
            print("No browser is open.")
            return
        c, _ = connect()
        try:
            info = json.loads(c.eval("JSON.stringify({url: location.href, title: document.title})"))
            print(f"open (provider={state.get('provider')}) — "
                  f"{info['title'][:60]} ({info['url'][:120]})")
        finally:
            c.close()
        return

    if a.cmd == "download":
        if not a.url and a.click is None:
            die("Give a URL, or --click REF to keep whatever file a button starts.")
        c, state = connect()
        target = a.url
        if not target and a.click is not None:
            target = href_behind(c, a.click)
            if target:
                print(f"Following the link behind [{a.click}] instead of clicking it.")
        name = a.name or (urllib.parse.urlparse(target).path.rsplit("/", 1)[-1] if target else "")
        outdir, path = safe_output_path(a.dir, name)
        try:
            opened_tabs = None
            pattern = target if target else "*"
            c.call("Fetch.enable", patterns=[{"urlPattern": pattern, "requestStage": "Response"}])
            if target:
                c.call("Runtime.evaluate", expression=(
                    "fetch(%s, {credentials:'include', mode:'no-cors'}).catch(()=>{}); 1" % json.dumps(target)))
            else:
                opened_tabs = tab_ids(c)
                click_without_waiting(c, a.click)
            deadline = time.time() + a.timeout
            paused = None
            while time.time() < deadline:
                if not target and opened_tabs is not None:
                    fresh = new_tab_url(c, opened_tabs)
                    if fresh:
                        die("That opened a new tab instead of sending the file to this one:\n"
                            f"  {fresh}\n"
                            "Download it directly — the tab it landed in is a viewer, not a page:\n"
                            f'  download "{fresh}"')
                try:
                    ev = c.wait_event("Fetch.requestPaused", seconds=3)
                except RuntimeError:
                    continue
                hs = {h.get("name", "").lower(): h.get("value", "")
                      for h in (ev.get("responseHeaders") or [])}
                ct = hs.get("content-type", "").split(";")[0].strip().lower()
                opens_in_the_tab = ev.get("resourceType") == "Document" and ct and not ct.startswith("text/html")
                looks_like_a_file = ("attachment" in hs.get("content-disposition", "").lower()
                                     or opens_in_the_tab
                                     or (target != "" and ev.get("request", {}).get("url") == target))
                if target or looks_like_a_file:
                    paused = ev
                    break
                try:
                    c.call("Fetch.continueRequest", requestId=ev["requestId"])
                except Exception:
                    pass
            if paused is None:
                die("Nothing that looked like a file came back within the timeout.\n"
                    "If the button opens a new tab, run `tabs` and `tab <id>` first, then retry.")
            rid = paused["requestId"]
            status = paused.get("responseStatusCode")
            headers = {h.get("name", "").lower(): h.get("value", "")
                       for h in (paused.get("responseHeaders") or [])}
            if status and not (200 <= int(status) < 300):
                c.call("Fetch.failRequest", requestId=rid, errorReason="Aborted")
                die(f"That URL answered {status}, so there is nothing to save. "
                    "If it needs a sign-in, open the page in the shared tab first.")
            ctype = headers.get("content-type", "")
            disp = headers.get("content-disposition", "")
            if "text/html" in ctype and "attachment" not in disp.lower():
                c.call("Fetch.failRequest", requestId=rid, errorReason="Aborted")
                die("That URL returned a web page, not a file — usually a sign-in wall or an\n"
                    "error page. Open it in the shared tab first so the session is established,\n"
                    "then find the real file URL and download that.")
            if not a.name:
                m = re.search(r'filename\*?=(?:UTF-8\'\'|")?([^";]+)', disp)
                if m:
                    name = urllib.parse.unquote(m.group(1).strip().strip('"'))
                    path = os.path.join(outdir, os.path.basename(name))
            stream = c.call("Fetch.takeResponseBodyAsStream", requestId=rid)["stream"]
            total = 0
            with open(path, "wb") as f:
                while True:
                    r = c.call("IO.read", handle=stream, size=1 << 16)
                    data = r.get("data", "")
                    raw = base64.b64decode(data) if r.get("base64Encoded") else data.encode()
                    f.write(raw)
                    total += len(raw)
                    if total > a.max_mb * 1024 * 1024:
                        raise RuntimeError(f"larger than --max-mb {a.max_mb}")
                    if r.get("eof"):
                        break
            c.call("IO.close", handle=stream)
            c.call("Fetch.failRequest", requestId=rid, errorReason="Aborted")
            rel = os.path.relpath(path, os.getcwd())
            print(f"Saved {rel} ({total // 1024} KB, {headers.get('content-type', 'unknown type')}).")
            print("It is in the workspace, so it is on the Files page and you can open it here.")
            return
        finally:
            try:
                c.call("Fetch.disable")
            except Exception:
                pass
            c.close()

    if a.cmd in ("tabs", "tab"):
        state = read_state()
        if not state or not state.get("cdpUrl"):
            die("Moving between tabs is for the person's own Chrome, through the extension.")
        c, _ = connect()
        try:
            if a.cmd == "tabs":
                tabs = c.call("qm.listTabs").get("tabs", [])
                if not tabs:
                    print("No tabs to move to.")
                    return
                for t in tabs:
                    mark = "*" if t.get("shared") else " "
                    where = " (front)" if t.get("active") else ""
                    print(f"{mark} [{t['tabId']}] {t.get('title','')[:70]}{where}")
                    print(f"      {t.get('url','')[:110]}")
                print("\n* is the tab you are driving. Move with: tab <id>")
                return
            r = c.call("qm.switchTab", tabId=a.tab_id)
            print(f"Now driving [{r['tabId']}] {r.get('title','')[:70]}")
            print(f"  {r.get('url','')[:110]}")
            print("The person can see the banner move; you are still on one tab only.")
            return
        finally:
            c.close()

    # ------------------------------------------------------------ close
    if a.cmd == "close":
        state = read_state()
        if not state or not state.get("cdpUrl"):
            clear_state()
            print("Nothing to close.")
            return
        # Not ours to shut down, and pretending otherwise would leave a
        # browser running somewhere while the person believes it stopped.
        clear_state()
        print("Detached. That browser is running somewhere else — follow your provider "
              "doc's Clean up step to actually stop it, or it bills until its own timeout.")
        return

    c, state = connect()

    # Two writers in one browser is how a half-finished sign-in gets clicked
    # away underneath someone. One check per call is all this needs — the calls
    # are short, so there is no long action to interrupt and nothing to park.
    if a.cmd in ("go", "click", "type", "type-secret", "key", "scroll"):
        if control_mode(state) == "human_control":
            c.close()
            die("The person has taken control of this browser. Wait for them to hand it back "
                "before acting — tell them what you were about to do, and let them finish.")

    try:
        if a.cmd == "go":
            # Any scheme is taken as written — about:blank and data: have no
            # "//" and must not get an https:// prefix bolted on.
            url = a.url if re.match(r"^[a-z][a-z0-9+.-]*:", a.url) else "https://" + a.url
            c.call("Page.enable")
            c.call("Page.navigate", url=url)
            wait_ready(c, 30)
            time.sleep(0.4)
            info = json.loads(c.eval(
                "JSON.stringify({url: location.href, title: document.title})"))
            blocked = json.loads(c.eval(BLOCK_JS))
            print(f"{info['title'][:80]}\n{info['url']}")
            if blocked.get("blocked"):
                print("\nThis page looks like an automation block rather than the real "
                      "content. Nothing is wrong with the browser — the site refuses "
                      "automated visits. Tell the person, and try a hosted browser for "
                      "this site if one is configured.")
                if blocked.get("sample"):
                    print(f"page says: {blocked['sample']}")

        elif a.cmd == "snapshot":
            data = json.loads(c.eval(SNAPSHOT_JS))
            items = data["items"][: a.max]
            n = data["count"]
            print(f"{n} interactive element{'' if n == 1 else 's'}"
                  + (f" (showing {len(items)})" if len(items) < n else ""))
            print("\n".join(items) if items else "(none — the page may still be loading)")

        elif a.cmd == "read":
            expr = (f"document.querySelector({json.dumps(a.selector)})"
                    if a.selector else "document.body")
            data = json.loads(c.eval(READ_JS % expr))
            if data.get("missing"):
                die(f"nothing matches {a.selector!r}")
            text = data["text"]
            print(f"{data['title']}\n{data['url']}\n")
            print(text[: a.max])
            if len(text) > a.max:
                print(f"\n[...{len(text) - a.max} more characters; "
                      "use --selector to narrow, or --max to raise the limit]")

        elif a.cmd == "click":
            if a.at:
                try:
                    x, y = (float(v) for v in a.at.split(",", 1))
                except ValueError:
                    die("--at wants X,Y")
                for typ in ("mousePressed", "mouseReleased"):
                    c.call("Input.dispatchMouseEvent", type=typ, x=x, y=y,
                           button="left", clickCount=1)
                print(f"clicked at {int(x)},{int(y)}")
            elif a.ref is None and not a.selector:
                die("give a ref from `snapshot`, --selector, or --at X,Y")
            else:
                do_click(c, a.ref, a.selector)

        elif a.cmd == "type":
            text = a.text
            if a.text_b64:
                try:
                    text = base64.b64decode(a.text_b64).decode("utf-8")
                except Exception:
                    die("--text-b64 is not valid base64 utf-8")
            if text is None:
                die("give the text to type, or --text-b64")
            do_type(c, text, a.into, a.into_selector, a.enter)

        elif a.cmd == "type-secret":
            status, payload = core_call_status("POST", "/v1/keychain/fill", {"credentialId": a.keychain})
            if status != 200 or not isinstance(payload, dict) or "value" not in payload:
                msg = payload.get("message") if isinstance(payload, dict) else None
                die("Could not fetch the stored password"
                    + (f": {msg}" if msg else "")
                    + ".\nIt fills only from the owner's own DM, on a turn they sent, and only for a "
                      "credential they stored as a browser fill-credential.")
            origin = payload.get("origin", "")

            def on_pinned_site():
                here = json.loads(c.eval("JSON.stringify({url: location.href})"))["url"]
                if not same_origin(here, origin):
                    die(f"Refusing to fill: this page ({here}) is not the site this password is "
                        f"pinned to ({origin}).\nThe stored password is only ever typed on its own "
                        "site — navigate there first, or check the URL for a look-alike.")

            on_pinned_site()
            focus_field(c, a.into, a.into_selector)
            on_pinned_site()
            c.call("Input.insertText", text=payload["value"])
            print(f"Filled the stored password into the focused field on {origin}.")

        elif a.cmd == "key":
            if a.name not in KEYS:
                die(f"unknown key {a.name!r}. Known: {', '.join(sorted(KEYS))}")
            press_key(c, a.name)
            time.sleep(0.5)
            wait_ready(c, 15)
            print(f"pressed {a.name}")

        elif a.cmd == "scroll":
            if a.to in ("top", "bottom"):
                c.eval(f"window.scrollTo(0, {'0' if a.to == 'top' else 'document.body.scrollHeight'})")
                print(f"scrolled to {a.to}")
            else:
                c.call("Input.dispatchMouseEvent", type="mouseWheel", x=640, y=400,
                       deltaX=0, deltaY=a.by)
                time.sleep(0.3)
                print(f"scrolled {a.by}px")

        elif a.cmd == "screenshot":
            r = c.call("Page.captureScreenshot", format="jpeg", quality=70)
            raw = base64.b64decode(r["data"])
            with open(a.path, "wb") as f:
                f.write(raw)
            print(f"{a.path} ({len(raw) // 1024} KB)")

        elif a.cmd == "cookies":
            urls = [a.url] if a.url else None
            cookies = c.cookies(urls)
            if a.domain:
                cookies = [ck for ck in cookies if a.domain in (ck.get("domain") or "")]
            # JSON to stdout so a skill can pipe it straight into a curl call.
            # The values ARE secrets — the skill must not echo them into the
            # conversation, only into the request it is about to make.
            sys.stdout.write(json.dumps(cookies))

        elif a.cmd == "storage":
            which = "session" if a.session else "local"
            if a.key:
                store = "sessionStorage" if which == "session" else "localStorage"
                val = c.eval("%s.getItem(%s)" % (store, json.dumps(a.key)))
                sys.stdout.write(json.dumps(val))
            else:
                sys.stdout.write(c.storage(which))

        elif a.cmd == "net":
            hits = c.watch(a.match, a.seconds, a.bodies)
            sys.stdout.write(json.dumps(hits))

    finally:
        c.close()


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        sys.exit(130)
    except RuntimeError as e:
        # A CDP-level failure is something the caller can act on ("that URL is
        # invalid", "no such element"). A traceback is not, and an agent reading
        # one tends to conclude the whole browser is broken.
        die(str(e))
