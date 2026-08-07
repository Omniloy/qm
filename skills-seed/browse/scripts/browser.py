#!/usr/bin/env python3
"""Drive a real browser one call at a time.

Each invocation connects, does one thing, and exits — so an agent stays inside
its turn instead of handing a whole task to a background process it cannot
steer. The browser itself outlives the call: it is a long-running Chromium
whose CDP endpoint is recorded in a state file, so the next call reattaches.

  browser.py open [--provider local]     start (or reattach to) a browser
  browser.py go URL                      navigate, wait for load
  browser.py snapshot [--max N]          numbered interactive elements
  browser.py read [--selector S]         visible text
  browser.py click REF|--selector S      real mouse click
  browser.py type TEXT [--into REF] [--enter]
  browser.py key NAME                    Enter, Tab, Escape, ArrowDown...
  browser.py scroll [--by N|--to top|bottom]
  browser.py screenshot [--path P]
  browser.py status                      is anything open, and where
  browser.py close                       graceful shutdown

Refs come from `snapshot` and are stamped onto the DOM, so `click 3` acts on the
thing that was listed as 3. They survive until the page changes structurally;
take a fresh snapshot after a navigation.

Deliberately free of provider concepts. Every verb is plain CDP, so the same
surface works against a local Chromium, a hosted session, or a browser someone
is driving through an extension — the transport is a CDP URL and nothing else.

Speaks WebSocket over the standard library so it runs under any python3 in the
image, with no virtualenv to activate and nothing to install.
"""

import argparse
import base64
import json
import os
import re
import shutil
import socket
import struct
import subprocess
import sys
import time
import urllib.error
import urllib.request

STATE_DIR = os.path.expanduser("~/.browser")
STATE_FILE = os.path.join(STATE_DIR, "state.json")
PROFILE_DIR = os.path.expanduser("~/.config/chromium")
DEBUG_PORT = 9222
# Chromium needs a moment between "port is listening" and "a page target exists".
LAUNCH_TIMEOUT = 45


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
        m = re.match(r"ws://([^:/]+):(\d+)(/.*)", url)
        if not m:
            die(f"only ws:// URLs are supported here, got: {url[:60]}")
        host, port, path = m.group(1), int(m.group(2)), m.group(3)
        self.sock = socket.create_connection((host, port), timeout=timeout)
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
            chunk = self.sock.recv(min(1 << 20, n - len(out)))
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
    def __init__(self, ws_url, timeout=60):
        self.ws = WS(ws_url, timeout)
        self.n = 0

    def call(self, method, **params):
        self.n += 1
        mid = self.n
        self.ws.send(json.dumps({"id": mid, "method": method, "params": params}))
        while True:
            msg = json.loads(self.ws.recv())
            if msg.get("id") == mid:
                if "error" in msg:
                    raise RuntimeError(f"{method}: {msg['error'].get('message', msg['error'])}")
                return msg.get("result", {})
            # Events are not interesting to a one-shot verb; drop them.

    def eval(self, expr, timeout_note=""):
        r = self.call("Runtime.evaluate", expression=expr, returnByValue=True,
                      awaitPromise=True)
        if r.get("exceptionDetails"):
            exc = r["exceptionDetails"]
            msg = exc.get("exception", {}).get("description") or exc.get("text")
            raise RuntimeError(f"page script failed{timeout_note}: {str(msg)[:200]}")
        return r.get("result", {}).get("value")

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
    tmp = STATE_FILE + ".tmp"
    with open(tmp, "w") as f:
        json.dump(state, f)
    os.replace(tmp, STATE_FILE)


def clear_state():
    try:
        os.remove(STATE_FILE)
    except FileNotFoundError:
        pass


def http_json(url, timeout=5):
    with urllib.request.urlopen(url, timeout=timeout) as r:
        return json.loads(r.read().decode())


def page_ws_url(port):
    """The debugger URL of the first real page target."""
    for t in http_json(f"http://127.0.0.1:{port}/json/list"):
        if t.get("type") == "page":
            return t["webSocketDebuggerUrl"]
    # A browser with no page (all tabs closed) still answers /json/new.
    with urllib.request.urlopen(
        urllib.request.Request(f"http://127.0.0.1:{port}/json/new?about:blank", method="PUT"),
        timeout=5,
    ) as r:
        return json.loads(r.read().decode())["webSocketDebuggerUrl"]


def alive(port):
    try:
        http_json(f"http://127.0.0.1:{port}/json/version", timeout=2)
        return True
    except Exception:
        return False


def connect(fresh_page=False):
    """Attach to the browser this person already has open."""
    state = read_state()
    if not state:
        die("No browser is open. Run: browser.py open")
    port = state.get("port", DEBUG_PORT)
    if not alive(port):
        clear_state()
        die("The browser that was open has gone. Run: browser.py open")
    touch(state)
    return CDP(page_ws_url(port)), state


def touch(state):
    """Record activity, so an idle reaper can tell a parked browser from a busy one."""
    state["lastUsedAt"] = int(time.time())
    write_state(state)


# ------------------------------------------------------------------ launch

def launch_local(headless=True):
    exe = shutil.which("chromium") or shutil.which("chromium-browser") or shutil.which("google-chrome")
    if not exe:
        die("no chromium on PATH in this sandbox")
    os.makedirs(PROFILE_DIR, exist_ok=True)
    args = [
        exe,
        "--headless=new" if headless else "",
        "--no-sandbox",
        "--disable-dev-shm-usage",
        # The profile lives on the sandbox's persistent volume, so sign-ins
        # outlive the browser and the container.
        f"--user-data-dir={PROFILE_DIR}",
        f"--remote-debugging-port={DEBUG_PORT}",
        "--window-size=1280,800",
        "--disable-blink-features=AutomationControlled",
        "--no-first-run",
        "--no-default-browser-check",
        "about:blank",
    ]
    args = [a for a in args if a]
    subprocess.Popen(args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                     start_new_session=True)
    end = time.time() + LAUNCH_TIMEOUT
    while time.time() < end:
        if alive(DEBUG_PORT):
            return DEBUG_PORT
        time.sleep(0.4)
    die("chromium did not start within %ds" % LAUNCH_TIMEOUT)


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


def do_type(c, text, into_ref, into_sel, enter):
    if into_ref is not None or into_sel:
        b = box_of(c, into_ref, into_sel)
        for typ in ("mousePressed", "mouseReleased"):
            c.call("Input.dispatchMouseEvent", type=typ, x=b["x"], y=b["y"],
                   button="left", clickCount=1)
        time.sleep(0.15)
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

    po = sub.add_parser("open", help="start or reattach to a browser")
    po.add_argument("--provider", default="local", choices=["local"])
    po.add_argument("--headful", action="store_true")

    pg = sub.add_parser("go"); pg.add_argument("url")
    ps = sub.add_parser("snapshot"); ps.add_argument("--max", type=int, default=60)
    pr = sub.add_parser("read")
    pr.add_argument("--selector"); pr.add_argument("--max", type=int, default=6000)
    pc = sub.add_parser("click")
    pc.add_argument("ref", nargs="?", type=int); pc.add_argument("--selector")
    pt = sub.add_parser("type")
    pt.add_argument("text"); pt.add_argument("--into", type=int)
    pt.add_argument("--into-selector"); pt.add_argument("--enter", action="store_true")
    pk = sub.add_parser("key"); pk.add_argument("name")
    psc = sub.add_parser("scroll")
    psc.add_argument("--by", type=int, default=600); psc.add_argument("--to")
    psh = sub.add_parser("screenshot"); psh.add_argument("--path", default="/tmp/page.jpg")
    sub.add_parser("status")
    sub.add_parser("close")

    a = p.parse_args()

    # ------------------------------------------------------------ open
    if a.cmd == "open":
        state = read_state()
        if state and alive(state.get("port", DEBUG_PORT)):
            touch(state)
            print(f"A browser is already open (provider={state.get('provider')}). Reusing it.")
            return
        port = launch_local(headless=not a.headful)
        state = {"provider": "local", "port": port,
                 "startedAt": int(time.time()), "lastUsedAt": int(time.time())}
        write_state(state)
        print(f"Browser open (local chromium, profile {PROFILE_DIR}).")
        print("Sign-ins here persist between sessions.")
        return

    # ------------------------------------------------------------ status
    if a.cmd == "status":
        state = read_state()
        if not state or not alive(state.get("port", DEBUG_PORT)):
            print("No browser is open.")
            return
        c, _ = connect()
        try:
            info = json.loads(c.eval("JSON.stringify({url: location.href, title: document.title})"))
            idle = int(time.time()) - state.get("lastUsedAt", 0)
            print(f"open (provider={state.get('provider')}, idle {idle}s) — "
                  f"{info['title'][:60]} ({info['url'][:120]})")
        finally:
            c.close()
        return

    # ------------------------------------------------------------ close
    if a.cmd == "close":
        state = read_state()
        if not state or not alive(state.get("port", DEBUG_PORT)):
            clear_state()
            print("Nothing to close.")
            return
        # Graceful, not a kill: chromium batches cookie writes, so a SIGKILL
        # here discards the sign-in someone just completed.
        try:
            c, _ = connect()
            try:
                c.call("Browser.close")
            finally:
                c.close()
        except SystemExit:
            raise
        except Exception:
            pass
        for _ in range(20):
            if not alive(state.get("port", DEBUG_PORT)):
                break
            time.sleep(0.5)
        clear_state()
        print("Browser closed. Sign-ins were saved.")
        return

    c, state = connect()
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
            if a.ref is None and not a.selector:
                die("give a ref from `snapshot` or --selector")
            do_click(c, a.ref, a.selector)

        elif a.cmd == "type":
            do_type(c, a.text, a.into, a.into_selector, a.enter)

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
