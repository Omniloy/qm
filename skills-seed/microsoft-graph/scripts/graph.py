#!/usr/bin/env python3
"""Microsoft Graph helper: talks to graph.microsoft.com with the connector token.

Reads the resolved user's token from $VAULT_TOKEN_GRAPH_MICROSOFT_COM and calls
Microsoft Graph v1.0 with a Bearer header. Reads paginate over @odata.nextLink;
downloads follow Graph's 302 to a pre-authorized URL without resending the Bearer;
uploads PUT raw bytes (a PUT to an existing item id creates a new version).

Usage (token from $VAULT_TOKEN_GRAPH_MICROSOFT_COM):
  graph.py mail list [--folder inbox] [--limit 20]
  graph.py mail search 'text' [--limit 20]
  graph.py mail read MESSAGE_ID [--full]
  graph.py mail send --to a@b.com[,c@d.com] --subject TEXT --body-file FILE
  graph.py mail reply MESSAGE_ID --body-file FILE [--all]
  graph.py mail draft --to a@b.com --subject TEXT --body-file FILE
  graph.py mail send-draft MESSAGE_ID

  graph.py calendar list --start ISO --end ISO
  graph.py calendar create --subject TEXT --start ISO --end ISO [--timezone TZ]
                           [--attendees a@b.com,c@d.com] [--body-file FILE]
  graph.py calendar update EVENT_ID [--subject ...] [--start ISO] [--end ISO]
                           [--timezone TZ] [--attendees ...] [--body-file FILE]
  graph.py calendar cancel EVENT_ID [--comment TEXT] [--delete]
  graph.py calendar freebusy --start ISO --end ISO --emails a@b.com,c@d.com
                           [--timezone TZ]

  graph.py files sites 'query'
  graph.py files drives [--site SITE_ID]
  graph.py files browse [--drive DRIVE_ID] [--item ITEM_ID | --path PATH]
  graph.py files search 'query' [--drive DRIVE_ID]
  graph.py files download --drive DRIVE_ID --item ITEM_ID --out PATH
  graph.py files upload --drive DRIVE_ID (--parent PARENT_ID --name NAME | --item ITEM_ID) --in PATH

  graph.py teams chats
  graph.py teams teams
  graph.py teams channels --team TEAM_ID
  graph.py teams messages (--chat CHAT_ID | --team TEAM_ID --channel CHANNEL_ID) [--limit 20]
  graph.py teams send (--chat CHAT_ID | --team TEAM_ID --channel CHANNEL_ID) --body-file FILE

Body files are plain text (one paragraph per block). Graph mail and Teams take a
Text content type, so no MIME construction is needed.
"""

import argparse
import json
import mimetypes
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

API = "https://graph.microsoft.com/v1.0"
MAIL_SELECT = "id,subject,from,toRecipients,receivedDateTime,bodyPreview,isRead"


def token() -> str:
    tok = os.environ.get("VAULT_TOKEN_GRAPH_MICROSOFT_COM", "")
    if not tok:
        sys.exit("no Microsoft token: ask the user to connect Microsoft")
    return tok


def call(
    method: str,
    path: str,
    body: dict | None = None,
    query: dict | None = None,
    raw_body: bytes | None = None,
    content_type: str | None = None,
    headers: dict | None = None,
    is_binary: bool = False,
):
    url = path if path.startswith("http") else f"{API}/{path}"
    if query:
        url += ("&" if "?" in url else "?") + urllib.parse.urlencode(query, doseq=True)
    hdrs = {"Authorization": f"Bearer {token()}"}
    if headers:
        hdrs.update(headers)
    if raw_body is not None:
        data = raw_body
        hdrs["Content-Type"] = content_type or "application/octet-stream"
    elif body is not None:
        data = json.dumps(body).encode()
        hdrs["Content-Type"] = "application/json"
    else:
        data = None
    req = urllib.request.Request(url, data=data, headers=hdrs, method=method)
    for attempt in range(5):
        try:
            with urllib.request.urlopen(req, timeout=120) as res:
                raw = res.read()
                if is_binary:
                    return raw
                return json.loads(raw) if raw else {}
        except urllib.error.HTTPError as e:
            if e.code in (429, 503) and attempt < 4:
                after = e.headers.get("Retry-After")
                time.sleep(float(after) if after and after.strip().isdigit() else 2**attempt)
                continue
            sys.exit(f"graph api {e.code} on {method} {path}: {e.read().decode(errors='replace')[:500]}")
        except urllib.error.URLError as e:
            sys.exit(f"graph api unreachable on {method} {path}: {e.reason}")


def paginate(path: str, query: dict | None = None, headers: dict | None = None, limit: int | None = None) -> list:
    items: list = []
    res = call("GET", path, query=query, headers=headers)
    items += res.get("value", [])
    nxt = res.get("@odata.nextLink")
    while nxt and (limit is None or len(items) < limit):
        res = call("GET", nxt, headers=headers)
        items += res.get("value", [])
        nxt = res.get("@odata.nextLink")
    return items[:limit] if limit is not None else items


class _Redirect(Exception):
    def __init__(self, location: str):
        self.location = location


class _CaptureRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise _Redirect(newurl)


def download_content(url: str) -> bytes:
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token()}"})
    opener = urllib.request.build_opener(_CaptureRedirect)
    try:
        with opener.open(req, timeout=300) as res:
            return res.read()
    except _Redirect as r:
        with urllib.request.urlopen(r.location, timeout=300) as res:
            return res.read()
    except urllib.error.HTTPError as e:
        sys.exit(f"graph api {e.code} on GET {url}: {e.read().decode(errors='replace')[:500]}")
    except urllib.error.URLError as e:
        sys.exit(f"graph api unreachable on GET {url}: {e.reason}")


def read_body(path: str) -> str:
    if path == "-":
        return sys.stdin.read()
    with open(path, encoding="utf-8") as f:
        return f.read()


def recipients(csv: str) -> list:
    return [{"emailAddress": {"address": addr.strip()}} for addr in csv.split(",") if addr.strip()]


def timezone() -> str | None:
    return call("GET", "me/mailboxSettings").get("timeZone")


def event_body(a) -> dict:
    body: dict = {}
    if a.subject is not None:
        body["subject"] = a.subject
    if a.start is not None:
        body["start"] = {"dateTime": a.start, "timeZone": a.timezone}
    if a.end is not None:
        body["end"] = {"dateTime": a.end, "timeZone": a.timezone}
    if a.attendees:
        body["attendees"] = [
            {"emailAddress": {"address": addr.strip()}, "type": "required"}
            for addr in a.attendees.split(",")
            if addr.strip()
        ]
    if getattr(a, "body_file", None):
        body["body"] = {"contentType": "Text", "content": read_body(a.body_file)}
    return body


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser()
    groups = p.add_subparsers(dest="group", required=True)

    mail = groups.add_parser("mail").add_subparsers(dest="cmd", required=True)
    m = mail.add_parser("list")
    m.add_argument("--folder", default="inbox")
    m.add_argument("--limit", type=lambda v: max(1, int(v)), default=20)
    m = mail.add_parser("search")
    m.add_argument("query")
    m.add_argument("--limit", type=lambda v: max(1, int(v)), default=20)
    m = mail.add_parser("read")
    m.add_argument("id")
    m.add_argument("--full", action="store_true")
    m = mail.add_parser("send")
    m.add_argument("--to", required=True)
    m.add_argument("--subject", required=True)
    m.add_argument("--body-file", required=True)
    m = mail.add_parser("reply")
    m.add_argument("id")
    m.add_argument("--body-file", required=True)
    m.add_argument("--all", action="store_true")
    m = mail.add_parser("draft")
    m.add_argument("--to", required=True)
    m.add_argument("--subject", required=True)
    m.add_argument("--body-file", required=True)
    m = mail.add_parser("send-draft")
    m.add_argument("id")

    cal = groups.add_parser("calendar").add_subparsers(dest="cmd", required=True)
    c = cal.add_parser("list")
    c.add_argument("--start", required=True)
    c.add_argument("--end", required=True)
    c = cal.add_parser("create")
    c.add_argument("--subject", required=True)
    c.add_argument("--start", required=True)
    c.add_argument("--end", required=True)
    c.add_argument("--timezone", default="UTC")
    c.add_argument("--attendees")
    c.add_argument("--body-file")
    c = cal.add_parser("update")
    c.add_argument("id")
    c.add_argument("--subject")
    c.add_argument("--start")
    c.add_argument("--end")
    c.add_argument("--timezone", default="UTC")
    c.add_argument("--attendees")
    c.add_argument("--body-file")
    c = cal.add_parser("cancel")
    c.add_argument("id")
    c.add_argument("--comment", default="")
    c.add_argument("--delete", action="store_true")
    c = cal.add_parser("freebusy")
    c.add_argument("--start", required=True)
    c.add_argument("--end", required=True)
    c.add_argument("--emails", required=True)
    c.add_argument("--timezone", default="UTC")

    files = groups.add_parser("files").add_subparsers(dest="cmd", required=True)
    f = files.add_parser("sites")
    f.add_argument("query")
    f = files.add_parser("drives")
    f.add_argument("--site")
    f = files.add_parser("browse")
    f.add_argument("--drive")
    f.add_argument("--item")
    f.add_argument("--path")
    f = files.add_parser("search")
    f.add_argument("query")
    f.add_argument("--drive")
    f = files.add_parser("download")
    f.add_argument("--drive", required=True)
    f.add_argument("--item", required=True)
    f.add_argument("--out", required=True)
    f = files.add_parser("upload")
    f.add_argument("--drive", required=True)
    f.add_argument("--parent")
    f.add_argument("--name")
    f.add_argument("--item")
    f.add_argument("--in", dest="in_path", required=True)

    teams = groups.add_parser("teams").add_subparsers(dest="cmd", required=True)
    teams.add_parser("chats")
    teams.add_parser("teams")
    t = teams.add_parser("channels")
    t.add_argument("--team", required=True)
    t = teams.add_parser("messages")
    t.add_argument("--chat")
    t.add_argument("--team")
    t.add_argument("--channel")
    t.add_argument("--limit", type=lambda v: max(1, int(v)), default=20)
    t = teams.add_parser("send")
    t.add_argument("--chat")
    t.add_argument("--team")
    t.add_argument("--channel")
    t.add_argument("--body-file", required=True)
    return p


def run_mail(a) -> None:
    if a.cmd == "list":
        q = {"$top": min(a.limit, 50), "$select": MAIL_SELECT, "$orderby": "receivedDateTime desc"}
        for msg in paginate(f"me/mailFolders/{a.folder}/messages", query=q, limit=a.limit):
            print(json.dumps(msg))
    elif a.cmd == "search":
        q = {"$search": f'"{a.query}"', "$select": MAIL_SELECT}
        for msg in paginate("me/messages", query=q, limit=a.limit):
            print(json.dumps(msg))
    elif a.cmd == "read":
        select = f"{MAIL_SELECT},body" if a.full else MAIL_SELECT
        msg = call("GET", f"me/messages/{a.id}", query={"$select": select})
        if not a.full:
            msg.pop("body", None)
        print(json.dumps(msg))
    elif a.cmd == "send":
        message = {
            "subject": a.subject,
            "body": {"contentType": "Text", "content": read_body(a.body_file)},
            "toRecipients": recipients(a.to),
        }
        call("POST", "me/sendMail", {"message": message, "saveToSentItems": True})
        print(json.dumps({"sent": True, "to": a.to, "subject": a.subject}))
    elif a.cmd == "reply":
        endpoint = "replyAll" if a.all else "reply"
        call("POST", f"me/messages/{a.id}/{endpoint}", {"comment": read_body(a.body_file)})
        print(json.dumps({"replied": True, "id": a.id, "all": a.all}))
    elif a.cmd == "draft":
        message = {
            "subject": a.subject,
            "body": {"contentType": "Text", "content": read_body(a.body_file)},
            "toRecipients": recipients(a.to),
        }
        res = call("POST", "me/messages", message)
        print(json.dumps({"id": res.get("id"), "subject": res.get("subject"), "webLink": res.get("webLink")}))
    elif a.cmd == "send-draft":
        call("POST", f"me/messages/{a.id}/send")
        print(json.dumps({"sent": True, "id": a.id}))


def run_calendar(a) -> None:
    if a.cmd == "list":
        tz = timezone()
        hdrs = {"Prefer": f'outlook.timezone="{tz}"'} if tz else None
        q = {
            "startDateTime": a.start,
            "endDateTime": a.end,
            "$orderby": "start/dateTime",
            "$select": "id,subject,start,end,location,attendees,organizer,isAllDay,onlineMeeting,webLink",
        }
        for ev in paginate("me/calendarView", query=q, headers=hdrs):
            print(json.dumps(ev))
    elif a.cmd == "create":
        res = call("POST", "me/events", event_body(a))
        print(json.dumps({"id": res.get("id"), "subject": res.get("subject"), "webLink": res.get("webLink")}))
    elif a.cmd == "update":
        res = call("PATCH", f"me/events/{a.id}", event_body(a))
        print(json.dumps({"id": res.get("id"), "subject": res.get("subject"), "webLink": res.get("webLink")}))
    elif a.cmd == "cancel":
        if a.delete:
            call("DELETE", f"me/events/{a.id}")
            print(json.dumps({"deleted": True, "id": a.id}))
        else:
            call("POST", f"me/events/{a.id}/cancel", {"Comment": a.comment})
            print(json.dumps({"cancelled": True, "id": a.id}))
    elif a.cmd == "freebusy":
        body = {
            "schedules": [e.strip() for e in a.emails.split(",") if e.strip()],
            "startTime": {"dateTime": a.start, "timeZone": a.timezone},
            "endTime": {"dateTime": a.end, "timeZone": a.timezone},
            "availabilityViewInterval": 30,
        }
        print(json.dumps(call("POST", "me/calendar/getSchedule", body)))


def run_files(a) -> None:
    if a.cmd == "sites":
        for site in paginate("sites", query={"search": a.query}):
            print(json.dumps(site))
    elif a.cmd == "drives":
        path = f"sites/{a.site}/drives" if a.site else "me/drives"
        for drive in paginate(path):
            print(json.dumps(drive))
    elif a.cmd == "browse":
        if a.drive and a.item:
            path = f"drives/{a.drive}/items/{a.item}/children"
        elif a.drive and a.path:
            path = f"drives/{a.drive}/root:/{urllib.parse.quote(a.path)}:/children"
        elif a.drive:
            path = f"drives/{a.drive}/root/children"
        elif a.item:
            path = f"me/drive/items/{a.item}/children"
        elif a.path:
            path = f"me/drive/root:/{urllib.parse.quote(a.path)}:/children"
        else:
            path = "me/drive/root/children"
        for child in paginate(path, query={"$select": "id,name,size,file,folder,webUrl"}):
            print(json.dumps(child))
    elif a.cmd == "search":
        qesc = urllib.parse.quote(a.query.replace("'", "''"))
        root = f"drives/{a.drive}/root" if a.drive else "me/drive/root"
        for hit in paginate(f"{root}/search(q='{qesc}')"):
            print(json.dumps(hit))
    elif a.cmd == "download":
        data = download_content(f"{API}/drives/{a.drive}/items/{a.item}/content")
        with open(a.out, "wb") as fp:
            fp.write(data)
        print(json.dumps({"saved": a.out, "bytes": len(data)}))
    elif a.cmd == "upload":
        if a.item:
            path = f"drives/{a.drive}/items/{a.item}/content"
            ctype = mimetypes.guess_type(a.in_path)[0] or "application/octet-stream"
        elif a.parent and a.name:
            path = f"drives/{a.drive}/items/{a.parent}:/{urllib.parse.quote(a.name)}:/content"
            ctype = mimetypes.guess_type(a.name)[0] or "application/octet-stream"
        else:
            sys.exit("upload: pass --item (new version) or --parent and --name (new content)")
        with open(a.in_path, "rb") as fp:
            raw = fp.read()
        res = call("PUT", path, raw_body=raw, content_type=ctype)
        print(json.dumps({"id": res.get("id"), "name": res.get("name"), "size": res.get("size"), "webUrl": res.get("webUrl")}))


def run_teams(a) -> None:
    if a.cmd == "chats":
        for chat in paginate("me/chats", query={"$expand": "members"}):
            print(json.dumps(chat))
    elif a.cmd == "teams":
        for team in paginate("me/joinedTeams"):
            print(json.dumps(team))
    elif a.cmd == "channels":
        for channel in paginate(f"teams/{a.team}/channels"):
            print(json.dumps(channel))
    elif a.cmd == "messages":
        if a.chat:
            path = f"chats/{a.chat}/messages"
        elif a.team and a.channel:
            path = f"teams/{a.team}/channels/{a.channel}/messages"
        else:
            sys.exit("messages: pass --chat or both --team and --channel")
        for msg in paginate(path, query={"$top": min(a.limit, 50)}, limit=a.limit):
            print(json.dumps(msg))
    elif a.cmd == "send":
        message = {"body": {"contentType": "text", "content": read_body(a.body_file)}}
        if a.chat:
            path = f"chats/{a.chat}/messages"
        elif a.team and a.channel:
            path = f"teams/{a.team}/channels/{a.channel}/messages"
        else:
            sys.exit("send: pass --chat or both --team and --channel")
        res = call("POST", path, message)
        print(json.dumps({"id": res.get("id"), "sent": True}))


def main() -> None:
    a = build_parser().parse_args()
    {"mail": run_mail, "calendar": run_calendar, "files": run_files, "teams": run_teams}[a.group](a)


if __name__ == "__main__":
    main()
