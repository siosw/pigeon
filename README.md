# Pigeon

Telegram bot backed by a headless [pi](https://github.com/badlogic/pi-mono) agent instance.

Single-user personal assistant with persistent weekly memory, bash/file tools, and web search.

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
| `ANTHROPIC_API_KEY` | yes | — | Anthropic API key |
| `DATA_DIR` | no | `./data` | Persistence directory |
| `MODEL` | no | `claude-sonnet-4-20250514` | Model ID |
| `THINKING` | no | `off` | Thinking level |
| `DEBUG` | no | — | Enable debug logging |

## Bot Commands

- `/start` — Greeting
- `/reset` — Fresh session (clears context)
- `/memory` — Show current week's memory
- `/weeks` — List available memory weeks
- `/status` — Uptime and session info

## Deploy (Hetzner VPS)

```bash
# Copy files to /opt/pigeon, create .env
sudo cp pigeon.service /etc/systemd/system/
sudo systemctl enable pigeon
sudo systemctl start pigeon

# Logs
journalctl -u pigeon -f
```
