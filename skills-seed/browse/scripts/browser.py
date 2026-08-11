#!/usr/bin/env python3
"""Drive a real browser one call at a time.

Each invocation connects, does one thing, and exits — so an agent stays inside
its turn instead of handing a whole task to a background process it cannot
steer. The browser itself outlives the call: it is a long-running Chromium
whose CDP endpoint is recorded in a state file, so the next call reattaches.

  browser.py open [--cdp URL]            start, reattach, or drive one elsewhere
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
import ssl
import struct
import subprocess
import sys
import time
import urllib.error
import urllib.parse
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
            # Most verbs have no use for events, but interception is waiting for
            # one — and over a relay it routinely arrives before the reply to the
            # command that caused it. Dropping it here hung every download.
            if msg.get("method"):
                self.events.append(msg)
                del self.events[:-200]

    def wait_event(self, method, seconds=25):
        """The next event of this kind, from the buffer or from the wire."""
        for i, held in enumerate(self.events):
            if held.get("method") == method:
                return self.events.pop(i).get("params", {})
        deadline = time.time() + seconds
        while time.time() < deadline:
            self.ws.sock.settimeout(max(1, deadline - time.time()))
            msg = json.loads(self.ws.recv())
            if msg.get("method") == method:
                return msg.get("params", {})
            if msg.get("method"):
                self.events.append(msg)
                del self.events[:-200]
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


class OpenLock:
    """Serialise opening, so two turns cannot each start a browser.

    Two concurrent `open` calls both saw an empty state file and both launched
    a watchdog. Two watchdogs is not merely wasteful: when one decides its
    browser is idle it closes the port the other is still using, so the second
    turn's browser dies under it and the pane goes blank while everything
    reports success.
    """

    def __init__(self):
        self.fd = None

    def __enter__(self):
        os.makedirs(STATE_DIR, exist_ok=True)
        self.fd = os.open(os.path.join(STATE_DIR, "open.lock"), os.O_CREAT | os.O_RDWR, 0o600)
        import fcntl

        # Blocking: the loser should end up reusing the winner's browser, which
        # is exactly what it would have done had it arrived a moment later.
        fcntl.flock(self.fd, fcntl.LOCK_EX)
        return self

    def __exit__(self, *_):
        try:
            import fcntl

            fcntl.flock(self.fd, fcntl.LOCK_UN)
        except Exception:
            pass
        try:
            os.close(self.fd)
        except Exception:
            pass
        return False


def merge_state(**fields):
    """Update some fields without discarding what another writer just added.

    Two processes write this file: `open` records the session it claimed, and
    the watchdog records the port once chromium is actually listening. They
    race, and a plain write means whoever finishes second wins — which cost a
    whole deploy cycle when `open` clobbered the port and every later call
    reported no browser at all.
    """
    state = read_state() or {}
    state.update(fields)
    write_state(state)
    return state


def clear_state():
    try:
        os.remove(STATE_FILE)
    except FileNotFoundError:
        pass


def http_json(url, timeout=5):
    with urllib.request.urlopen(url, timeout=timeout) as r:
        return json.loads(r.read().decode())


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


def register(state):
    """Claim a browser with MiniOmni, before spending a gigabyte starting one.

    Registered as a streamed viewer with no URL: this browser is reached
    through MiniOmni's own authenticated endpoint, so unlike a hosted one there is no
    link that would work for whoever found it.

    Returns "ok", "full" (MiniOmni says there is no room — obey it), or "no-pane"
    (MiniOmni could not be reached, so browse anyway without one).
    """
    session_id = state.get("sessionId") or os.urandom(8).hex()
    state["sessionId"] = session_id
    merge_state(sessionId=session_id)
    status, payload = core_call_status("POST", "/v1/browser-sessions", {
        "provider": "local",
        "sessionId": session_id,
        "viewer": "stream",
        # The pane stops showing a browser that has gone; the watchdog below
        # enforces the same bound on the browser itself.
        "expiresAt": int((time.time() + 30 * 60) * 1000),
    })
    if status == 409:
        return "full", (payload or {}).get("message", "there is no room for another browser right now")
    ok = bool(status and 200 <= status < 300)
    merge_state(registered=ok)
    return ("ok" if ok else "no-pane"), ""


def unregister(state):
    sid = state.get("sessionId")
    if sid:
        core_call("DELETE", f"/v1/browser-sessions/{sid}")


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


def connect(fresh_page=False):
    """Attach to the browser this person already has open, wherever it runs."""
    state = read_state()
    if not state:
        die("No browser is open. Run: browser.py open")
    touch(state)
    cdp_url = state.get("cdpUrl")
    if cdp_url:
        try:
            return attach_remote(cdp_url), state
        except SystemExit:
            raise
        except Exception as e:
            clear_state()
            die(f"The browser that was open has gone ({str(e)[:80]}). Run: browser.py open")
    port = state.get("port", DEBUG_PORT)
    if not alive(port):
        clear_state()
        die("The browser that was open has gone. Run: browser.py open")
    return CDP(page_ws_url(port)), state


def touch(state):
    """Record activity, so an idle reaper can tell a parked browser from a busy one.

    Merges rather than writes: the watchdog owns `port` in the same file, and a
    full write from here would erase it.
    """
    state["lastUsedAt"] = int(time.time())
    merge_state(lastUsedAt=state["lastUsedAt"])


# ------------------------------------------------------------------ launch

def clear_profile_lock():
    """Remove a profile lock left behind by a browser that no longer exists.

    Chromium guards a profile with a symlink naming the host and pid holding
    it. That guard assumes the host outlives the lock — but this profile sits
    on a volume that survives its container, so after a restart the lock names
    a hostname that is gone, and chromium refuses to start FOREVER: "the
    profile appears to be in use by another Chromium process on another
    computer".

    It presents as a browser that dies instantly with no error anyone sees. The
    same persistence that keeps sign-ins is what makes this permanent, so the
    lock is cleared whenever nothing is actually listening on the debug port.
    """
    if alive(DEBUG_PORT):
        return  # A real browser is running; its lock is legitimate.
    for name in ("SingletonLock", "SingletonSocket", "SingletonCookie"):
        p = os.path.join(PROFILE_DIR, name)
        try:
            if os.path.islink(p) or os.path.exists(p):
                os.remove(p)
        except OSError:
            pass


def spawn_chromium(headless=True):
    """Start chromium as a CHILD of this process, and hand back the handle.

    Deliberately not detached. A chromium orphaned to PID 1 becomes a zombie
    when it exits, because PID 1 in this computer is the exec daemon and does
    not reap anyone — measured, after a handful of sessions, as ~14 dead
    process entries each. They hold no memory but they do hold PIDs. The
    watchdog owns the process instead, and waits on it.
    """
    exe = shutil.which("chromium") or shutil.which("chromium-browser") or shutil.which("google-chrome")
    if not exe:
        die("no chromium on PATH in this sandbox")
    os.makedirs(PROFILE_DIR, exist_ok=True)
    clear_profile_lock()
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
    return subprocess.Popen([a for a in args if a],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def wait_for_port(seconds=LAUNCH_TIMEOUT):
    end = time.time() + seconds
    while time.time() < end:
        if alive(DEBUG_PORT):
            return True
        time.sleep(0.4)
    return False


# --------------------------------------------------------------- watchdog

IDLE_LIMIT = 30 * 60          # seconds a browser may sit unused
CLOSE_GRACE = 15              # how long to wait for a graceful close
WATCH_TICK = 30               # how often the watchdog looks


def close_browser(state, reason):
    """Shut the browser down without losing what it learned.

    Chromium batches its cookie writes, so killing the process throws away
    exactly the sign-in someone just completed — measured, not theorised. So
    ask it to close, wait, and only then insist.
    """
    port = state.get("port", DEBUG_PORT)
    try:
        c = CDP(page_ws_url(port), timeout=10)
        try:
            c.call("Browser.close")
        finally:
            c.close()
    except Exception:
        pass
    for _ in range(CLOSE_GRACE * 2):
        if not alive(port):
            break
        time.sleep(0.5)
    if alive(port):
        # It ignored us. Losing recent cookies beats leaking a gigabyte, but
        # this is the unhappy path and it is deliberately last.
        subprocess.run(["pkill", "-f", f"user-data-dir={PROFILE_DIR}"], check=False)
        time.sleep(2)
    unregister(state)
    clear_state()
    return reason


def become_subreaper():
    """Adopt the browser's whole process tree, not just its root.

    Chromium is a dozen processes — a zygote, a GPU process, one per renderer —
    and they are children of the one we start, not of us. When it exits they
    are re-parented to PID 1, which in this computer is the exec daemon and
    reaps nobody, so each session left a handful of dead entries behind.
    Becoming a subreaper makes them ours to bury instead.
    """
    try:
        import ctypes

        PR_SET_CHILD_SUBREAPER = 36
        ctypes.CDLL("libc.so.6", use_errno=True).prctl(PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0)
    except Exception:
        # Not fatal, and not worth failing a browser over: without it the only
        # cost is a few dead process entries per session.
        pass


def reap_orphans():
    while True:
        try:
            pid, _ = os.waitpid(-1, os.WNOHANG)
        except ChildProcessError:
            return
        except Exception:
            return
        if pid == 0:
            return


def watchdog(headless=True):
    """Own the browser: start it, outlive it, and close it when it is forgotten.

    This process is the browser's parent for its whole life. That is what keeps
    it from becoming a zombie, and it is also the only thing that can close it
    gracefully — MiniOmni can forget a session, but only something inside this
    computer can ask Chromium to flush its cookies and stop.
    """
    become_subreaper()
    started = time.time()
    proc = spawn_chromium(headless)
    if not wait_for_port():
        proc.kill()
        return
    # Stamp lastUsedAt as this browser starts. Without it the watchdog would
    # inherit whatever a previous session left in the file and could judge a
    # brand-new browser idle before anyone has touched it — observed: the
    # browser was reaped seconds after opening, and the pane sat on "waiting"
    # forever while chromium was still running.
    merge_state(provider="local", port=DEBUG_PORT, lastUsedAt=int(time.time()))

    try:
        while True:
            time.sleep(WATCH_TICK)
            # Renderers come and go all session; bury each as it exits rather
            # than letting them pile up while the browser is still open.
            reap_orphans()
            if proc.poll() is not None:
                # It went on its own — a crash, or someone closed it directly.
                clear_state()
                return
            state = read_state()
            if not state:
                break
            # Never idle before it has had a chance to be used: a stale
            # timestamp from a previous session must not condemn this browser.
            last = max(state.get("lastUsedAt", 0), started)
            if time.time() - last >= IDLE_LIMIT:
                close_browser(state, "idle")
                break
    finally:
        # Waiting is the point: an unwaited child left behind by this process
        # is exactly the zombie this structure exists to avoid.
        try:
            proc.wait(timeout=CLOSE_GRACE)
        except Exception:
            proc.kill()
            try:
                proc.wait(timeout=5)
            except Exception:
                pass
        # Chromium's helpers land here once it is gone, having been inherited
        # rather than orphaned. Give them a moment to exit, then bury them.
        for _ in range(10):
            reap_orphans()
            time.sleep(0.3)


def start_watchdog(headless=True):
    subprocess.Popen(
        [sys.executable, os.path.abspath(__file__), "watch"] + ([] if headless else ["--headful"]),
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True,
    )


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
    # Set by MiniOmni when it relays what a person did in the pane. Their input must
    # not be refused by the check that stops the agent driving while they hold
    # the wheel — they ARE the wheel.
    p.add_argument("--from-pane", action="store_true", help=argparse.SUPPRESS)
    sub = p.add_subparsers(dest="cmd", required=True)

    po = sub.add_parser("open", help="start or reattach to a browser")
    po.add_argument("--force-built-in", action="store_true",
                    help="use the built-in browser even when another was chosen")
    pp = sub.add_parser("pane", help="show a browser you started elsewhere in the person's pane")
    pp.add_argument("--provider", default="", help="the provider id, as named by BROWSE_PROVIDER")
    pp.add_argument("--session", default="", help="that provider's session id")
    pp.add_argument("--url", default="", help="the provider's viewer URL — never the CDP URL")
    pp.add_argument("--minutes", type=int, default=30, help="how long the pane should expect it to live")
    pp.add_argument("--end", action="store_true", help="take it out of the pane again")
    po.add_argument("--headful", action="store_true")
    # Drive a browser that is already running somewhere else, given its CDP
    # endpoint. Every verb behaves identically against it — a CDP URL is plain
    # protocol, not a vendor concept, which is what keeps this surface honest.
    po.add_argument("--cdp", help="attach to an existing browser instead of starting one")

    pg = sub.add_parser("go"); pg.add_argument("url")
    ps = sub.add_parser("snapshot"); ps.add_argument("--max", type=int, default=60)
    pr = sub.add_parser("read")
    pr.add_argument("--selector"); pr.add_argument("--max", type=int, default=6000)
    pc = sub.add_parser("click")
    pc.add_argument("ref", nargs="?", type=int); pc.add_argument("--selector")
    # Viewport coordinates, for a click a person made in the pane. Refs are for
    # the agent, which can see the snapshot; a person clicks a picture.
    pc.add_argument("--at", help="X,Y in page coordinates")
    pt = sub.add_parser("type")
    pt.add_argument("text", nargs="?"); pt.add_argument("--into", type=int)
    pt.add_argument("--into-selector"); pt.add_argument("--enter", action="store_true")
    # What a person typed in the pane arrives base64-encoded so it never has to
    # survive a shell. Their keystrokes are arbitrary text; interpolating that
    # into a command line is how a password with a quote in it becomes an
    # injection.
    pt.add_argument("--text-b64")
    pk = sub.add_parser("key"); pk.add_argument("name")
    psc = sub.add_parser("scroll")
    psc.add_argument("--by", type=int, default=600); psc.add_argument("--to")
    psh = sub.add_parser("screenshot"); psh.add_argument("--path", default="/tmp/page.jpg")
    pf = sub.add_parser("frame", help="one JPEG plus its viewport size, as JSON on stdout")
    # Sized for the pane, which renders about 730px wide. Measured on a real
    # article: 800px/q55 is 42 KB, where full resolution is 87 KB for detail
    # that is scaled away before anyone sees it.
    pf.add_argument("--quality", type=int, default=55)
    pf.add_argument("--width", type=int, default=800)
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
    pw = sub.add_parser("watch", help=argparse.SUPPRESS)
    pw.add_argument("--headful", action="store_true")

    a = p.parse_args()

    # ------------------------------------------------------------ open
    if a.cmd == "pane":
        # A browser running on someone else's hardware cannot be streamed, but
        # it can still be shown: the pane embeds the provider's own viewer.
        # Without this the person is handed a bare link in the conversation and
        # has to leave the app to watch their own browser work.
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
        print("Showing in the pane. They can watch it and take control there.")
        return

    if a.cmd == "open":
        # The person's own Chrome, chosen in the app, is not a hosted provider
        # with a doc and a create step: the extension is already running it and
        # the relay is already reachable. Resolve it to a --cdp attach BEFORE
        # anything else, so plain `open` just works — and before the local
        # launch path below, which is the bug that sent it to the sandbox
        # browser instead.
        chosen = "" if a.force_built_in else os.environ.get("BROWSE_PROVIDER", "").strip()
        via_extension = chosen == "extension" and not a.cdp
        if via_extension:
            relay = os.environ.get("QM_RELAY_URL", "").strip()
            if not relay:
                die("This person chose their own Chrome, but no relay URL reached this turn.\n"
                    "Their extension may not be connected. Tell them to open the MiniOmni Browser Bridge\n"
                    "extension and share a tab, or run: open --force-built-in to use the built-in one.")
            a.cdp = relay

        if a.cdp:
            # Someone else started this one; it is theirs to close, and its
            # pane (if it has one) is registered by whoever created it.
            try:
                c = attach_remote(a.cdp)
            except (Exception, SystemExit) as e:
                # die() raises SystemExit, and a refused websocket upgrade or a
                # closed connection both take that path.
                if not via_extension:
                    raise
                clear_state()
                die("Their Chrome is not sharing a tab, so there is nothing to drive "
                    f"({str(e)[:80]}).\n"
                    "Ask them to open the MiniOmni Browser Bridge extension and press Share this tab,\n"
                    "then run: open\n"
                    "Do NOT quietly switch to the built-in browser: it has none of their sign-ins, "
                    "and a task aimed at their own browser will fail in a way that looks like your "
                    "mistake rather than a disconnected extension.\n"
                    "If they would rather use the built-in browser anyway, they can say so and you "
                    "run: open --force-built-in")
            c.close()
            write_state({"provider": "remote", "cdpUrl": a.cdp,
                         "startedAt": int(time.time()), "lastUsedAt": int(time.time())})
            print("Attached to the browser you pointed at. Every verb works the same.")
            return

        # A hosted provider is different: it needs its own doc
        # and a create step first. Saying so here is the only reliable place —
        # a doc read top-down gets acted on before its later sections, and by
        # then the built-in browser is already running.
        if chosen and chosen != "built-in" and re.fullmatch(r"[a-z][a-z0-9-]*", chosen):
            die(f"This person chose the {chosen} browser, not the built-in one.\n"
                f"Read skills/browse/providers/{chosen}.md, create the browser it describes,\n"
                f"then come back and run: open --cdp \"$CDP_URL\".\n"
                "To use the built-in browser anyway (say why), run: open --force-built-in")

        # Under the lock, because two turns opening at once each used to start
        # their own browser and then reap each other's.
        with OpenLock():
            state = read_state()
            if state and state.get("cdpUrl") and a.force_built_in:
                stale = state.get("cdpUrl", "")
                clear_state()
                state = None
                # Only a hosted provider bills for a browser we are letting go
                # of. The relay is the person's own Chrome and costs nothing.
                if stale and stale != os.environ.get("QM_RELAY_URL", "").strip():
                    print("Let go of the browser that was open elsewhere. It is still running and "
                          "billing until its own timeout — follow your provider doc's Clean up step.")
            if state and (state.get("cdpUrl") or alive(state.get("port", DEBUG_PORT))):
                touch(state)
                print(f"A browser is already open (provider={state.get('provider')}). Reusing it.")
                return
            # Claim first, launch second. A browser costs about a gigabyte, and
            # being told "no room" after spending it helps nobody.
            write_state({"provider": "local", "startedAt": int(time.time()),
                         "lastUsedAt": int(time.time())})
            state = read_state() or {}
            outcome, why = register(state)
            if outcome == "full":
                clear_state()
                die(f"No browser was opened: {why}\n"
                    "Nothing is broken and nothing is lost — say so, and offer to try again shortly.")

            # The watchdog starts the browser and stays its parent for life. It
            # records the port itself once chromium is listening, so nothing here
            # writes the whole file again — that race cost a deploy cycle.
            start_watchdog(headless=not a.headful)
            if not wait_for_port():
                clear_state()
                die(f"chromium did not start within {LAUNCH_TIMEOUT}s")
            merge_state(lastUsedAt=int(time.time()))

        print(f"Browser open (local chromium, profile {PROFILE_DIR}).")
        print("Sign-ins here persist between sessions.")
        print("The person can see it in the pane below the conversation, and take control."
              if outcome == "ok" else
              # Worth saying rather than swallowing: the browser works, but
              # nobody can watch it, so "press Take control" is not advice to give.
              "MiniOmni did not accept the session, so there is no pane — the person cannot watch "
              "or take over. Browsing still works; say so if a sign-in comes up.")
        return

    if a.cmd == "watch":
        watchdog(headless=not a.headful)
        return

    # ------------------------------------------------------------ status
    if a.cmd == "status":
        state = read_state()
        if not state or not (state.get("cdpUrl") or alive(state.get("port", DEBUG_PORT))):
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

    if a.cmd == "download":
        if not a.url and a.click is None:
            die("Give a URL, or --click REF to keep whatever file a button starts.")
        c, state = connect()
        target = a.url
        name = a.name or (urllib.parse.urlparse(target).path.rsplit("/", 1)[-1] if target else "") or "download.bin"
        outdir = os.path.join(os.getcwd(), a.dir)
        os.makedirs(outdir, exist_ok=True)
        path = os.path.join(outdir, name)
        try:
            # Response stage: the bytes exist and Chrome has not yet decided to
            # save them, which is the only moment we can take them instead.
            pattern = target if target else "*"
            c.call("Fetch.enable", patterns=[{"urlPattern": pattern, "requestStage": "Response"}])
            if target:
                # Issued from the page so it carries the person's session, and
                # deliberately NOT a navigation: navigating to a PDF or an
                # attachment tears down the very tab we are driving.
                c.call("Runtime.evaluate", expression=(
                    "fetch(%s, {credentials:'include', mode:'no-cors'}).catch(()=>{}); 1" % json.dumps(target)))
            else:
                do_click(c, a.click, "")
            # With a click we do not know the URL, so everything in the tab is
            # paused and let through until the one that is a file shows up.
            deadline = time.time() + a.timeout
            paused = None
            while time.time() < deadline:
                ev = c.wait_event("Fetch.requestPaused", seconds=max(1, int(deadline - time.time())))
                hs = {h.get("name", "").lower(): h.get("value", "")
                      for h in (ev.get("responseHeaders") or [])}
                looks_like_a_file = ("attachment" in hs.get("content-disposition", "").lower()
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
            # A web page where a file was expected is almost always a sign-in
            # wall or an error page, and saving it produces a file that looks
            # fine until someone opens it.
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
            # Aborted on purpose: letting it through would hand the file to
            # Chrome's downloader, which means their Downloads folder and, if
            # they ask where to save, a dialog nothing here can answer.
            c.call("Fetch.failRequest", requestId=rid, errorReason="Aborted")
            rel = os.path.relpath(path, os.getcwd())
            print(f"Saved {rel} ({total // 1024} KB, {headers.get('content-type', 'unknown type')}).")
            print("It is in the workspace, so it is on the Files page and you can open it here.")
            return
        finally:
            try:
                c.call("Fetch.disable")
            except Exception:
                # A pattern left armed would hang every matching request in
                # that tab until the browser is closed.
                pass
            c.close()

    if a.cmd in ("tabs", "tab"):
        state = read_state()
        if not state or not state.get("cdpUrl"):
            die("Moving between tabs is for the person's own Chrome, through the extension.\n"
                "The built-in browser has one page and `go` is how you move it.")
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
        if not state:
            print("Nothing to close.")
            return
        if state.get("cdpUrl"):
            # Not ours to shut down, and pretending otherwise would leave a
            # browser running somewhere while the person believes it stopped.
            unregister(state)
            clear_state()
            print("Detached. That browser is running somewhere else — follow your provider "
                  "doc's Clean up step to actually stop it, or it bills until its own timeout.")
            return
        if not alive(state.get("port", DEBUG_PORT)):
            clear_state()
            print("Nothing to close.")
            return
        # Graceful, not a kill: chromium batches cookie writes, so a SIGKILL
        # here discards the sign-in someone just completed.
        close_browser(state, "asked")
        print("Browser closed. Sign-ins were saved.")
        return

    c, state = connect()

    # Two writers in one browser is how a half-finished sign-in gets clicked
    # away underneath someone. One check per call is all this needs — the calls
    # are short, so there is no long action to interrupt and nothing to park.
    if a.cmd in ("go", "click", "type", "key", "scroll") and not a.from_pane:
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

        elif a.cmd == "frame":
            # For the pane, not for the agent. The viewport size travels with
            # the image because the pane scales it to fit, and a click has to
            # be mapped back to page coordinates — guessing that from the JPEG
            # alone puts every click in the wrong place.
            size = json.loads(c.eval(
                "JSON.stringify({w: innerWidth, h: innerHeight, url: location.href,"
                " title: document.title, sx: scrollX, sy: scrollY})"))
            # Downscale on the way out. The pane shows this in a box a few
            # hundred pixels wide, so sending full-resolution pixels spends
            # bandwidth on detail that is thrown away before anyone sees it.
            scale = min(1.0, a.width / size["w"]) if size["w"] else 1.0
            # The clip is in PAGE coordinates, not viewport ones, so it has to
            # follow the scroll. Clipping at the document origin while the
            # viewport sits further down captures an unpainted region: the pane
            # went white the moment anyone scrolled, and a real screenshot of
            # 43KB collapsed to 2KB of blank.
            r = c.call("Page.captureScreenshot", format="jpeg", quality=a.quality,
                       optimizeForSpeed=True,
                       clip={"x": size["sx"], "y": size["sy"],
                             "width": size["w"], "height": size["h"],
                             "scale": round(scale, 4)})
            sys.stdout.write(json.dumps({
                "w": size["w"], "h": size["h"], "url": size["url"],
                "title": size["title"], "jpeg": r["data"],
            }))
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
