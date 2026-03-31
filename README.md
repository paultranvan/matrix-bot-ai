# matrix-bot-ai

A Matrix bot that bridges chat rooms to any OpenAI-compatible API.

- Responds in DMs and when mentioned in rooms
- Per-room conversation history (in-memory, up to 20 messages)
- Markdown rendering in Matrix messages
- Typing indicators while the AI is thinking
- System prompt loaded from `prompt.txt`

## Setup

```bash
cp .env.example .env
# Edit .env with your values
```

| Variable | Required | Default | Description |
|---|---|---|---|
| `MATRIX_HOMESERVER` | yes | | Matrix server URL |
| `MATRIX_ACCESS_TOKEN` | yes | | Bot access token |
| `AI_API_URL` | yes | | OpenAI-compatible API base URL |
| `AI_API_KEY` | no | `none` | API key |
| `AI_MODEL` | no | `gpt-4o` | Model name |

Edit `prompt.txt` to customize the bot's personality.

## Run

```bash
npm install
npm start
```

Or with Docker:

```bash
docker compose up --build
```
