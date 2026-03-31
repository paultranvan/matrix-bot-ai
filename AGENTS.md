# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Matrix AI bot — a single-file Node.js bot (`bot.js`) that bridges Matrix chat rooms to any OpenAI-compatible chat completions API. It responds in DMs and when mentioned in rooms, maintains per-room conversation history in memory, and sends typing indicators while waiting for the AI.

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

Single file `bot.js` with these sections:
- **Config** — reads env vars, exits on missing required ones
- **History** — in-memory per-room message history (`histories` map, capped at `MAX_HISTORY=20`)
- **`askAI`** — calls `/chat/completions` with system prompt + room history
- **`shouldRespond`** — replies in DMs (2-member rooms) or when bot is mentioned
- **`stripBotMention`** — removes bot user ID from message text
- **Listener** — `room.message` handler: filters, calls AI, sends reply as a thread reply
- **Startup** — `client.start()`, resolves `botUserId`

State is persisted to `./data/bot.json` via `SimpleFsStorageProvider` (Matrix SDK sync state only; conversation history is ephemeral).
