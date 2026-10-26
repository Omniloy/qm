---
name: microsoft-365-calendar
description: Read the user's Outlook calendar, check free and busy time, and create, update, accept, or decline events in Microsoft 365.
---

# Outlook calendar

Read the `microsoft-365` skill first for access and approval rules.

- Time zone: Graph returns times in UTC unless asked otherwise, and you can't read the
  user's mailbox time zone setting. Use the time zone from your instructions or the
  conversation if one is given; otherwise ask the user once. Then pass it in the tool's
  `timezone` parameter where it has one (Windows or IANA name, e.g. `Europe/Madrid`), and
  always tell the user times in their own zone.
- "What's on my calendar" questions: `microsoft-365_get-calendar-view` with
  `startDateTime` and `endDateTime` (ISO 8601). It expands recurring meetings into
  occurrences.
- Other calendars: `list-calendars` shows the ones the user owns or shares.
- Free and busy time: `get-schedule` returns busy blocks for the user and for specific
  people or rooms over a window; propose slots from the gaps.
- Events: `get-calendar-event`, `create-calendar-event`, `update-calendar-event`,
  `delete-calendar-event`. Set `isOnlineMeeting: true` with
  `onlineMeetingProvider: "teamsForBusiness"` to add a Teams link.
- Invitations: `accept-calendar-event`, `tentatively-accept-calendar-event`,
  `decline-calendar-event`, with an optional comment and `sendResponse`.
- Every create, update, delete, accept, or decline needs the user's approval first: show
  the title, time with time zone, attendees, and whether invitations are sent.
- An event's `onlineMeeting.joinUrl` is the key to its Teams meeting and transcript; see
  `microsoft-365-meeting-transcripts`.
