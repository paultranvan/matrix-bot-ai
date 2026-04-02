# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Matrix AI bot — a Node.js bot that bridges Matrix chat rooms to any OpenAI-compatible chat completions API. It responds in DMs and when mentioned in rooms, maintains per-room conversation history in memory, sends typing indicators while waiting for the AI, and supports scheduling reminders via AI tool calling.

Uses **matrix-bot-sdk** and native `fetch`. ESM (`"type": "module"`). No build step, no tests, no linter.

## Commands

- `npm start` — runs `node bot.js`
- `docker compose up --build` — build and run via Docker

## Required Environment Variables

| Variable | Purpose |
|---|---|
| `MATRIX_HOMESERVER` | Matrix server URL |
| `MATRIX_ACCESS_TOKEN` | Bot access token |
| `AI_API_URL` | OpenAI-compatible API base (e.g. `https://ai.example.com/v1`) |
| `AI_API_KEY` | API key (default `"none"`) |
| `AI_MODEL` | Model name (default `"gpt-4o"`) |
| `AI_SYSTEM_PROMPT` | System prompt (default: French assistant prompt) |

## Architecture

Two files: `bot.js` (main) and `reminders.js` (reminder module).

### `bot.js`
- **Config** — reads env vars, exits on missing required ones
- **Tool definitions** — `TOOLS` array and `TOOL_INSTRUCTIONS` for AI tool calling (schedule/list/cancel reminders)
- **History** — in-memory per-room message history (`histories` map, capped at `MAX_HISTORY=20`)
- **`executeToolCall`** — dispatches AI tool calls to reminder functions
- **`askAI`** — calls `/chat/completions` with system prompt + tools; handles tool-calling loop (execute tools, follow-up API call for confirmation)
- **`shouldRespond`** — replies in DMs (2-member rooms) or when bot is mentioned
- **`stripBotMention`** — removes bot user ID from message text
- **Listener** — `room.message` handler: filters, calls AI, sends reply
- **Startup** — `client.start()`, registers reminder fire callback, loads/schedules persisted reminders, notifies about missed reminders

### `reminders.js`
- **Persistence** — reads/writes `./data/reminders.json` (organized by sender)
- **Scheduling** — `setTimeout`-based with overflow handling for >24.8 day delays; hourly scan for far-future reminders
- **Public API** — `init(callback)`, `scheduleReminder()`, `listReminders()`, `cancelReminder()`, `loadAndProcessMissed()`
- Supports one-shot and recurring reminders (`repeatIntervalSeconds`)

State is persisted to `./data/bot.json` (Matrix SDK sync) and `./data/reminders.json` (reminder data). Conversation history is ephemeral.
