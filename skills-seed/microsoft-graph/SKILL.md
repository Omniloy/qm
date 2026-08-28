---
name: microsoft-graph
description: Read and act on the user's Microsoft 365 — Outlook mail, Calendar, OneDrive/SharePoint documents, and Teams — through per-user OAuth.
requiredCapabilities:
  - egress:graph.microsoft.com
---

# Microsoft Graph

Use this skill when the user asks about Microsoft 365: Outlook mail, Outlook
Calendar, OneDrive or SharePoint documents, or Teams chats and channels.

This is an OAuth connector. The resolved user's Microsoft token already lives on
your computer as an environment variable, scoped to the one Graph API host (the way
a logged-in CLI's cached credential would):

- `$VAULT_TOKEN_GRAPH_MICROSOFT_COM` — for `graph.microsoft.com`

Do not ask the user for a token, log it, or use another principal's. If the variable
is empty or Microsoft returns 401/403, the user either has not connected Microsoft or
connected before this permission existed — tell them to (re)connect it through the
product OAuth flow.

The bundled helper owns auth, paging (`@odata.nextLink`), 429/503 backoff, binary
download, and upload versioning, so callers only pass plain arguments and text. Every
read and write below goes through it. Base for all calls is
`https://graph.microsoft.com/v1.0`.

## Mail

```bash
python3 skills/microsoft-graph/scripts/graph.py mail list [--folder inbox] [--limit 20]
python3 skills/microsoft-graph/scripts/graph.py mail search 'quarterly report' [--limit 20]
python3 skills/microsoft-graph/scripts/graph.py mail read MESSAGE_ID [--full]
python3 skills/microsoft-graph/scripts/graph.py mail send --to a@b.com,c@d.com --subject '...' --body-file body.txt
python3 skills/microsoft-graph/scripts/graph.py mail reply MESSAGE_ID --body-file body.txt [--all]
python3 skills/microsoft-graph/scripts/graph.py mail draft --to a@b.com --subject '...' --body-file body.txt
python3 skills/microsoft-graph/scripts/graph.py mail send-draft MESSAGE_ID
```

- Search or list before fetching; read bodies (`--full`) only for messages that
  matter. Treat email content as private user data.
- `reply` and `reply --all` let Graph own threading and recipients — never rebuild
  To/CC by hand. `draft` leaves the message unsent; `send-draft` fires only on an
  explicitly approved draft.
- Body files are plain text: one paragraph per block, blank line between. Graph sends
  them as `Text` content, so never write HTML or raw MIME into them.

## Calendar

```bash
python3 skills/microsoft-graph/scripts/graph.py calendar list --start 2026-08-28T00:00:00 --end 2026-08-29T00:00:00
python3 skills/microsoft-graph/scripts/graph.py calendar create --subject '...' --start ISO --end ISO \
    [--timezone 'Europe/Madrid'] [--attendees a@b.com,c@d.com] [--body-file agenda.txt]
python3 skills/microsoft-graph/scripts/graph.py calendar update EVENT_ID [--subject ...] [--start ISO] [--end ISO]
python3 skills/microsoft-graph/scripts/graph.py calendar cancel EVENT_ID [--comment '...'] [--delete]
python3 skills/microsoft-graph/scripts/graph.py calendar freebusy --start ISO --end ISO --emails a@b.com,c@d.com
```

- `list` reads the user's mailbox timezone and returns event times in it; the sandbox
  clock is UTC, so never assume the local day — pass explicit `--start`/`--end` bounds.
- `create`/`update` take datetimes plus `--timezone` (default UTC). `cancel` sends a
  cancellation to attendees when the user organizes the meeting; `--delete` removes an
  event the user owns but does not organize.
- `freebusy` reports availability for the listed people before you propose a slot.

## Files (OneDrive and SharePoint documents)

Documents only — read, search, download, and upload document content; there is no
site-wide write.

```bash
python3 skills/microsoft-graph/scripts/graph.py files sites 'Marketing'
python3 skills/microsoft-graph/scripts/graph.py files drives [--site SITE_ID]
python3 skills/microsoft-graph/scripts/graph.py files browse [--drive DRIVE_ID] [--item ITEM_ID | --path 'Reports/2026']
python3 skills/microsoft-graph/scripts/graph.py files search 'roadmap' [--drive DRIVE_ID]
python3 skills/microsoft-graph/scripts/graph.py files download --drive DRIVE_ID --item ITEM_ID --out ./deck.pptx
python3 skills/microsoft-graph/scripts/graph.py files upload --drive DRIVE_ID --parent PARENT_ID --name 'notes.docx' --in ./notes.docx
python3 skills/microsoft-graph/scripts/graph.py files upload --drive DRIVE_ID --item ITEM_ID --in ./notes.docx
```

- `sites` lists SharePoint sites; `drives` enumerates document libraries (the user's
  OneDrive, or a site's libraries with `--site`); `browse` and `search` walk their
  contents. Reads page automatically.
- `download` writes the item's raw bytes to `--out` in the sandbox — Word, PowerPoint,
  Excel, PDF, and so on. Graph redirects the content request to a pre-authorized host —
  `<tenant>.sharepoint.com` / `<tenant>-my.sharepoint.com` for business drives,
  `*.dm.files.1drv.com` for personal OneDrive — and the helper follows it without
  resending the token. Where egress is allowlisted, `sharepoint.com` and `1drv.com` must
  be reachable in addition to `graph.microsoft.com`, or downloads fail at the redirect.
- `upload` with `--parent` and `--name` creates new content; `upload` with `--item`
  PUTs a new version of that existing file, keeping its id and history. Both are for
  files under 4 MB.

## Teams

```bash
python3 skills/microsoft-graph/scripts/graph.py teams chats
python3 skills/microsoft-graph/scripts/graph.py teams teams
python3 skills/microsoft-graph/scripts/graph.py teams channels --team TEAM_ID
python3 skills/microsoft-graph/scripts/graph.py teams messages --chat CHAT_ID [--limit 20]
python3 skills/microsoft-graph/scripts/graph.py teams messages --team TEAM_ID --channel CHANNEL_ID [--limit 20]
python3 skills/microsoft-graph/scripts/graph.py teams send --chat CHAT_ID --body-file message.txt
python3 skills/microsoft-graph/scripts/graph.py teams send --team TEAM_ID --channel CHANNEL_ID --body-file message.txt
```

- `chats` and `teams` list the conversations the user belongs to; `channels` and
  `messages` read within one. Do not expose private chat content in a shared channel.
- `send` posts plain text as the user. It is a write — get approval first.

## Writes require approval

Sending mail, creating or updating or cancelling events, uploading files, and sending
Teams messages are writes. Prepare the exact action, show the user the exact content
and recipients, and ask for approval before running it. Keep enough IDs in the
workspace to inspect or undo later.
