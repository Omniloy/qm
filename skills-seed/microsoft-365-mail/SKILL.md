---
name: microsoft-365-mail
description: Search, read, triage, draft, and send Outlook mail in the user's Microsoft 365 account.
---

# Outlook mail

Read the `microsoft-365` skill first for access and approval rules.

- Find mail with `microsoft-365_list-mail-messages`. For keyword search pass `search`
  wrapped in double quotes using KQL, for example `"from:ana@contoso.com subject:invoice"`;
  use `filter` for structured conditions such as `isRead eq false` or
  `receivedDateTime ge 2026-10-01T00:00:00Z`. `search` and `orderby` can't be combined.
- Triage many messages at once with `microsoft-365_read-mail-text` (up to 20 ids): it
  returns clean text without quoted history. Use `get-mail-message` only when you need one
  message's full body or headers.
- Folders: `list-mail-folders`, then `list-mail-folder-messages`. Well-known folder names
  such as `inbox`, `sentitems`, `drafts` and `archive` work as ids.
- Attachments: `list-mail-attachments`, then `get-mail-attachment-content`.
- Before saying a message still needs a reply, check the conversation: look for a later
  message from the user in `sentitems` with the same `conversationId`.
- Replies: `create-reply-draft` (then `update-mail-message` to set the body) and, after
  approval, `send-draft-message`. New mail: `create-draft-email` then `send-draft-message`,
  or `send-mail` for an approved message in one step.
- Organise with `move-mail-message`, and mark read or flag with `update-mail-message`.
