# Pigeon — Implementation Plan

Telegram bot backed by a headless pi instance. Minimal harness, easy to audit.

## Architecture

```
┌─────────────┐       ┌──────────────┐       ┌─────────────────┐
│  Telegram    │◄─────►│  pigeon      │◄─────►│  pi SDK         │
│  (telegraf)  │       │  (index.ts)  │       │  (AgentSession) │
└─────────────┘       └──────┬───────┘       └─────────────────┘
                             │
                        ┌────▼────┐
                        │  data/  │
                        │  └ memory/       weekly .md files
                        └─────────┘
```

Single process. One user (authorized Telegram chat ID). No web server, no database.

## Dependencies

- `telegraf` — Telegram Bot API
- `@mariozechner/pi-coding-agent` — pi SDK (headless agent)
- `@mariozechner/pi-ai` — model lookup (`getModel`)

Nothing else. Bun built-ins for fs, env, logging.

## Files

```
index.ts          entry point: init bot + pi session, wire together
src/
  bot.ts          telegraf setup, message handler, command registration
  agent.ts        pi session lifecycle: create, prompt, event streaming
  memory.ts       weekly markdown file read/write, old-week loading
  logger.ts       structured logging (timestamp, level, context)
  config.ts       env vars: BOT_TOKEN, CHAT_ID, ANTHROPIC_API_KEY, DATA_DIR, MODEL
data/             created at runtime
  memory/
    2026-W07.md   one file per ISO week
```

~6 source files, each < 150 LOC target.

## Implementation Steps

### 1. Config & Logger (`src/config.ts`, `src/logger.ts`)

**config.ts** — Read env vars, validate, export typed config object.

| Var | Required | Default | Purpose |
|-----|----------|---------|---------|
| `BOT_TOKEN` | yes | — | Telegram bot token |
| `CHAT_ID` | yes | — | Authorized user's chat ID |
| `ANTHROPIC_API_KEY` | yes | — | Pi model auth |
| `DATA_DIR` | no | `./data` | Persistence root |
| `MODEL` | no | `claude-sonnet-4-20250514` | Model ID |
| `THINKING` | no | `off` | Thinking level |

**logger.ts** — Thin wrapper: `log.info(ctx, msg)`, `log.error(ctx, msg)`, `log.debug(ctx, msg)`. Writes to stdout with ISO timestamps. No dependency.

### 2. Memory (`src/memory.ts`)

Weekly markdown files in `DATA_DIR/memory/`.

```
# Week 2026-W07

## Mon Feb 9
- User asked about X. Resolved by Y.

## Tue Feb 10
- ...
```

Functions:
- `getCurrentWeekFile(): string` — returns path for current ISO week
- `loadWeek(weekId?: string): string` — read a week file, defaults to current. Returns empty string if not found.
- `appendToMemory(entry: string): void` — append timestamped entry to current week file. Creates file + header if missing.
- `listWeeks(): string[]` — list available week IDs for on-demand loading.

The agent will be instructed (via system prompt) to call a custom `memory` tool to read/write these files.

### 3. Pi Agent Session (`src/agent.ts`)

Headless pi session via SDK.

**Setup:**
```ts
const session = await createAgentSession({
  model: getModel("anthropic", config.model),
  thinkingLevel: config.thinking,
  tools: codingTools,               // read, bash, edit, write
  customTools: [memoryTool],
  sessionManager: SessionManager.create(config.dataDir),
  resourceLoader: customLoader,     // custom system prompt
  settingsManager: SettingsManager.inMemory({
    compaction: { enabled: true },
    retry: { enabled: true, maxRetries: 3 },
  }),
  authStorage,
  modelRegistry,
});
```

**Custom tools (registered via `customTools`):**

`memory` tool:
- `action: "read_current"` — load current week
- `action: "read_week", weekId: "2026-W05"` — load old week
- `action: "append", entry: "..."` — append to current week
- `action: "list"` — list available weeks

**System prompt** (via `DefaultResourceLoader.systemPromptOverride`):

```
You are Pigeon, a personal assistant reachable via Telegram.

You have tools to run bash commands, read/write files, search the web, and manage your memory.

## Behavior
- Be concise. Telegram messages should be short and readable.
- For simple questions: answer immediately.
- For complex tasks: work through steps, then reply with results.
- Use your memory (weekly markdown files) to maintain context across conversations.
- At the start of each conversation turn, read your current week's memory.

## Memory
Use the `memory` tool to persist important context, decisions, and outcomes.
Load old weeks when the user references past events.

## Tools
You have bash, read, write, edit for general file/system work.
Use bash with `curl` for web searches when needed.

## Response Format
- Use plain text or simple markdown (Telegram supports basic markdown).
- Keep replies under ~4000 chars (Telegram message limit).
- For long outputs, summarize and offer to provide details.
```

**Key function:**

```ts
async function prompt(text: string): Promise<string>
```

Sends user text to the pi session, collects the full assistant response text via `session.subscribe`, returns it. Handles:
- Streaming events → accumulate final text
- Errors → return error message string
- Logging of tool calls and results
- Timeout for long-running tasks (configurable, default 5 min)

### 4. Telegram Bot (`src/bot.ts`)

Telegraf setup with auth guard and message handling.

**Auth middleware:** Drop all messages where `ctx.chat.id !== config.chatId`. Log rejected attempts.

**Message handler (`bot.on('text')`):**

```
1. Log incoming message
2. Send "typing" indicator
3. Call agent.prompt(message.text)
4. Send response back (split if > 4096 chars)
5. Log completion + timing
```

**Commands:**
- `/start` — greeting
- `/reset` — create new pi session (fresh context)
- `/memory` — show current week's memory summary

- `/weeks` — list available memory weeks
- `/status` — uptime, session info, token usage

**Typing indicator:** Send `chat_action: typing` every 4s while the agent is working (Telegram typing indicator expires after 5s). Use a simple interval that's cleared when the response is ready.

**Message splitting:** Telegram has a 4096 char limit. Split long responses at paragraph boundaries.

### 5. Entry Point (`index.ts`)

```ts
import { createBot } from "./src/bot"
import { createAgent } from "./src/agent"
import { config } from "./src/config"
import { log } from "./src/logger"

log.info("main", "Starting pigeon...")
const agent = await createAgent(config)
const bot = createBot(config, agent)

bot.launch()
log.info("main", `Bot running. Authorized chat: ${config.chatId}`)

// Graceful shutdown
process.on("SIGINT", () => { bot.stop("SIGINT"); agent.dispose(); })
process.on("SIGTERM", () => { bot.stop("SIGTERM"); agent.dispose(); })
```

### 6. Deployment

**VPS setup:**
- Systemd service file (`pigeon.service`)
- `.env` file with secrets
- `bun install && bun run index.ts`

**pigeon.service:**
```ini
[Unit]
Description=Pigeon Telegram Bot
After=network.target

[Service]
Type=simple
User=pigeon
WorkingDirectory=/opt/pigeon
ExecStart=/usr/local/bin/bun run index.ts
Restart=always
RestartSec=5
EnvironmentFile=/opt/pigeon/.env

[Install]
WantedBy=multi-user.target
```

**Monitoring:** Logging to stdout → journald captures it. That's enough.

## Implementation Order

1. `src/config.ts` + `src/logger.ts` — foundation
2. `src/memory.ts` — data layer
3. `src/agent.ts` — pi session + custom tools + system prompt
4. `src/bot.ts` — telegram glue
5. `index.ts` — wire everything, test end-to-end
6. `pigeon.service` — deployment config

## Non-Goals

- No multi-user support. Single authorized chat ID.
- No web UI. Telegram only.
- No database. Flat files.
- No message queue. Synchronous request-response (one message at a time; queue if agent is busy).
- No Docker. Direct bun on VPS.

## Concurrency

Only one prompt runs at a time. If a message arrives while the agent is working:
- Queue it (simple array).
- After current prompt completes, process the next queued message.
- Log when messages are queued.

This avoids pi session concurrency issues entirely.
