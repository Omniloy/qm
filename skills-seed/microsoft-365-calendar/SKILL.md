---
name: microsoft-365-calendar
description: Read the user's Outlook calendar, find free time, and create, update, accept, or decline events in Microsoft 365.
---

# Outlook calendar

Read the `microsoft-365` skill first for access and approval rules.

- "What's on my calendar" questions: `microsoft-365_get-calendar-view` with
  `startDateTime` and `endDateTime` (ISO 8601). It expands recurring meetings into
  occurrences. Times come back in UTC unless you ask otherwise; always tell the user times
  in their own time zone.
- Other calendars: `list-calendars` shows the ones the user owns or shares.
- Free time: `find-meeting-times` proposes slots for a set of attendees;
  `get-schedule` returns busy blocks for specific people or rooms.
- Events: `get-calendar-event`, `create-calendar-event`, `update-calendar-event`,
  `delete-calendar-event`. Set `isOnlineMeeting: true` with
  `onlineMeetingProvider: "teamsForBusiness"` to add a Teams link.
- Invitations: `accept-calendar-event`, `tentatively-accept-calendar-event`,
  `decline-calendar-event`, with an optional comment and `sendResponse`.
- Every create, update, delete, accept, or decline needs the user's approval first: show
  the title, time with time zone, attendees, and whether invitations are sent.
- An event's `onlineMeeting.joinUrl` is the key to its Teams meeting and transcript; see
  `microsoft-365-meeting-transcripts`.
