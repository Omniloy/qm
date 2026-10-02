---
name: slack-drafts
description: Create Slack message drafts in the user's own composer, as the user, through their per-user Slack OAuth. Drafting only — the user reviews and sends from Slack.
requiredCapabilities:
  - egress:slack.com
---

# Slack drafts

Use this skill when the user wants a Slack message prepared for them to review and
send themselves: "draft a reply to X", "prep a message for #general", "write that up
as a Slack draft". The draft lands in their own Slack composer, attributed to them,
targeted at the conversation you choose — nothing is posted.

This is an OAuth connector. The resolved user's Slack user token is delivered per
command, never left on the computer: pass `connector_slack_com_default` (or the Slack handle your instructions list) in
`execute.credentials` on every command that calls Slack, with the execute scope it lists
under "Execution credentials" in your instructions, and it sets `$VAULT_TOKEN_SLACK_COM`
for that command only. Do not ask the user for a token, log it, or use another
principal's. An empty variable means the handle was not requested, so re-run with it. If
the handle is not listed in your instructions, connector tokens are not offered here: they reach only the user's direct DM with you, or
the live speaker in an Open shared conversation. In a channel or group, don't tell a
connected user to reconnect; ask them to DM you to run this. Only a missing handle inside
their DM, or Slack returning 401/403, means they have not connected Slack (or connected
before this permission existed) — then tell them to (re)connect it through the product
OAuth flow.

Use the bundled helper for every draft — it owns destination resolution, rich-text
block construction, and the required draft envelope:

```bash
python3 skills/slack-drafts/scripts/slack_drafts.py create --to '#general' --text 'hello'
python3 skills/slack-drafts/scripts/slack_drafts.py create --to '@jane' --text-file body.txt
python3 skills/slack-drafts/scripts/slack_drafts.py create --to C0123ABCDEF --thread-ts 1712345678.000100 --text '...'
python3 skills/slack-drafts/scripts/slack_drafts.py resolve --to '#general'
```

- `--to` takes a channel/IM ID (`C…`/`G…`/`D…`), a user ID (`U…`/`W…`), `#channel-name`,
  or `@name` (matched against username, display name, real name, or email; ambiguous
  matches are refused — fall back to a user ID).
- Text is plain; URLs become clickable links. Write it exactly as the user would send
  it — it goes out under their name, in their voice, once they hit send.
- `--thread-ts` targets the draft at a thread reply instead of the channel composer.
- Drafts are create-only through this API: you cannot list, edit, or delete a draft
  once made. To revise, tell the user to discard the old draft in Slack and create a
  fresh one. Never work around this by posting messages — drafting means the user
  sends.
- Opening a brand-new DM needs the `im:write` scope; tokens connected before that
  scope existed can only draft into conversations that already exist. On a
  `missing_scope` error, tell the user to reconnect Slack.
- Slack keeps at most one draft per composer: a second draft into the same channel or
  thread fails with `attached_draft_exists`. Tell the user to send or discard the
  existing draft, then retry.
