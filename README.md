# Pigeon

Telegram bot backed by a headless [pi](https://github.com/badlogic/pi-mono) agent instance.

Single-user personal assistant with persistent weekly memory, background task queue, and bash/file tools.

## Architecture

```
Telegram message
    ↓
Main agent (fast, conversational)
    ├── Simple → answer immediately
    └── Complex → queue_task tool → "Queued ✓" reply
                        ↓
                  Task Queue (data/queue.json)
                        ↓
              Background worker (poll loop)
                        ↓
              Background agent session
                        ↓
              Send result to Telegram
```

Two separate pi agent sessions: main stays responsive, background grinds through queued work.
The background worker gets the last 20 messages of conversation history + shared memory files for context.

## Setup

```bash
bun install
cp .env.example .env
# Edit .env with your tokens
bun run index.ts
```

## Environment Variables

| Var | Required | Default | Description |
|-----|----------|---------|-------------|
| `BOT_TOKEN` | yes | — | Telegram bot token from @BotFather |
| `CHAT_ID` | yes | — | Your Telegram chat ID |
| `ANTHROPIC_API_KEY` | yes | — | Anthropic API key (or use OAuth via `pi /login`) |
| `DATA_DIR` | no | `./data` | Persistence directory |
| `MODEL` | no | `claude-sonnet-4-20250514` | Model ID |
| `THINKING` | no | `off` | Thinking level |
| `DEBUG` | no | — | Enable debug logging |

## Bot Commands

- `/start` — Greeting
- `/reset` — Fresh session (clears context)
- `/todo` — Show task queue (pending, running, recent)
- `/memory` — Show current week's memory
- `/weeks` — List available memory weeks
- `/status` — Uptime, session info, task counts

## Deploy (Hetzner VPS)

```bash
# Copy files to server, create .env
sudo cp pigeon.service /etc/systemd/system/
sudo systemctl enable pigeon
sudo systemctl start pigeon

# Logs
journalctl -u pigeon -f
```

## OAuth (optional)

Use Claude Pro/Max subscription instead of API key. Run `pi` on the VPS as the pigeon user, `/login` with Anthropic, then restart the service. The API key in `.env` acts as automatic fallback if OAuth tokens expire.
