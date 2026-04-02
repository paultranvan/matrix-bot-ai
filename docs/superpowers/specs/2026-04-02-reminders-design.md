# Reminder Feature Design

## Overview

Add scheduling/reminder capability to the Matrix AI bot. Users ask for reminders in natural language; the AI uses OpenAI-compatible tool calling to trigger structured actions; the bot executes them.

## Tool Definitions

Three tools are exposed in the `tools` parameter of the `/chat/completions` request:

### `schedule_reminder`

| Parameter | Type | Required | Description |
|---|---|---|---|
| `delay_seconds` | integer | yes | Seconds from now until the reminder fires |
| `message` | string | yes | What to remind the user about |
| `repeat_interval_seconds` | integer | no | If set, the reminder recurs at this interval |

The AI converts natural language ("in 30 minutes", "every Monday at 9am") into seconds.

### `list_reminders`

No parameters. Returns the caller's active reminders for the current room.

### `cancel_reminder`

| Parameter | Type | Required | Description |
|---|---|---|---|
| `reminder_id` | string | yes | ID of the reminder to cancel |

## Request/Response Loop

The current `askAI` function is extended to handle tool calls:

1. Send the chat completions request with `tools` defined.
2. If the response contains `tool_calls`:
   - Execute each tool call (schedule/list/cancel).
   - Append results as `tool` role messages.
   - Send a follow-up request so the AI can craft a natural confirmation.
3. If the response is plain text content (no tool calls), behave as today.

This means `askAI` may make 2 API calls per user message when a reminder is involved.

## Data Model

Reminders are organized by sender in `./data/reminders.json`:

```json
{
  "@user:matrix.org": [
    {
      "id": "r_1712345678_abc",
      "roomId": "!abc:matrix.org",
      "fireAt": 1712345678000,
      "message": "check the oven",
      "createdAt": 1712344000000,
      "repeatIntervalSeconds": null
    }
  ]
}
```

### Fields

| Field | Type | Description |
|---|---|---|
| `id` | string | Unique ID, e.g. `r_<timestamp>_<random>` |
| `roomId` | string | Room where the reminder was set and will be delivered |
| `fireAt` | integer | Unix timestamp (ms) when the reminder should fire |
| `message` | string | Reminder text |
| `createdAt` | integer | Unix timestamp (ms) when the reminder was created |
| `repeatIntervalSeconds` | integer or null | If set, the reminder recurs at this interval |

## In-Memory Runtime

A nested `Map` structure: `Map<senderId, Map<reminderId, { reminder, timeoutHandle }>>`.

### When a reminder fires

1. Send a message to the room mentioning the user with the reminder text (plain message, not a reply).
2. If `repeatIntervalSeconds` is set: compute next `fireAt` = now + interval, update the file, schedule next `setTimeout`.
3. If one-shot: remove from file and map.

### setTimeout overflow

Node.js `setTimeout` overflows at ~24.8 days (2^31 ms). For reminders further out, a periodic scan (every hour) checks for reminders due within the next hour and schedules their `setTimeout` then.

## Persistence

- `./data/reminders.json` is written on every create, cancel, and recurring reschedule.
- The `data/` directory is already volume-mounted in Docker.

## Startup: Missed Reminders

On startup, load `reminders.json` and check for reminders with `fireAt` in the past:

- Discard missed one-shot reminders.
- For recurring reminders missed multiple times, advance `fireAt` to the next future occurrence.
- Group all missed reminders per sender per room and send **one** summary message:
  > "Sorry for the inconvenience -- I was offline and missed some reminders: check the oven, call the dentist, weekly standup (x3)"
- The "(xN)" notation is used when a recurring reminder was missed N times.
- Then schedule all remaining valid reminders.

## System Prompt

Tool instructions are injected programmatically in `askAI`, appended to the system message content (not added to `prompt.txt`). Example:

> You can schedule reminders for the user. When they ask to be reminded of something, use the `schedule_reminder` tool. Convert relative times ("in 30 minutes", "in 2 hours", "tomorrow at 9am") into a number of seconds from now. When they ask to see or cancel reminders, use `list_reminders` and `cancel_reminder`.

## Delivery

- Reminders are delivered in the same room where they were requested.
- The bot mentions the user in the reminder message.

## Permissions

- `list_reminders` returns only the caller's reminders in the current room.
- `cancel_reminder` only operates on the caller's own reminders.
- No cross-user access.

## Edge Cases

- **Duplicates**: No dedup. Two identical requests create two reminders.
- **Max active reminders**: No limit enforced (can be added later if needed).
- **Bot not in room**: If the bot has left the room when a reminder fires, one-shot reminders are discarded. Recurring reminders reschedule silently (the user will get the next one if the bot rejoins).
