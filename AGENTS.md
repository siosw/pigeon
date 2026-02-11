# Pigeon Agent Guidelines

## General

- Only write TypeScript. No JavaScript, no Python, no shell scripts as primary deliverables.
- Prefer existing CLI tools installable via `apt install` over writing custom implementations. For example: use `jq` for JSON processing, `curl` for HTTP, `ripgrep` for search, `pandoc` for document conversion, `ffmpeg` for media, `imagemagick` for images.
- Every completed feature or meaningful change gets its own git commit on dev. Use clear, concise commit messages. Commit early and often — don't batch unrelated changes.

## Pi Skills

Skills are markdown files with instructions and optional helper scripts. Place them in `.pi/skills/`.

Structure:
```
.pi/skills/my-skill/
├── SKILL.md          # Required: frontmatter + instructions
└── helper.ts         # Optional: helper scripts (TypeScript only)
```

SKILL.md format:
```markdown
---
name: my-skill
description: What this skill does and when to use it.
---

# My Skill

Instructions for using the skill. Reference helper scripts with relative paths.
```

Rules:
- `name` must be lowercase, a-z/0-9/hyphens, match the parent directory name.
- `description` must clearly explain what the skill does and when to use it.
- Helper scripts must be TypeScript. Run with `bun run`.
- Prefer wrapping existing CLI tools over reimplementing their functionality.

## Pi Extensions

Extensions are TypeScript modules that extend pi with custom tools, commands, and event handlers. Place them in `.pi/extensions/`.

Basic structure:
```typescript
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

export default function (pi: ExtensionAPI) {
  // Register a tool the LLM can call
  pi.registerTool({
    name: "my_tool",
    label: "My Tool",
    description: "What this tool does",
    parameters: Type.Object({
      input: Type.String({ description: "Input value" }),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      return {
        content: [{ type: "text", text: `Result: ${params.input}` }],
        details: {},
      };
    },
  });

  // Subscribe to events
  pi.on("tool_call", async (event, ctx) => {
    // inspect or block tool calls
  });

  // Register a command
  pi.registerCommand("mycommand", {
    description: "Does something",
    handler: async (args, ctx) => {
      // handle command
    },
  });
}
```

Available imports:
- `@mariozechner/pi-coding-agent` — ExtensionAPI, tools, types
- `@mariozechner/pi-ai` — model types, provider types
- `@sinclair/typebox` — parameter schemas

Rules:
- One extension per `.ts` file, default export is the factory function.
- Use `Type.Object()` from typebox for tool parameter schemas.
- Tools must return `{ content: [{ type: "text", text: "..." }], details: {} }`.
- Keep extensions focused — one concern per file.

## Data Directory

The `data/` directory is the persistent workspace. Use it for all file storage.

```
data/
├── memory/           # Weekly memory files (managed by memory tool)
│   └── 2026-W07.md
├── queue.json        # Task queue state (managed by queue system)
├── scratch/          # Working directory for temporary files, downloads, drafts
└── output/           # Finished artifacts to share with the user
```

- Use `data/scratch/` for intermediate work: cloned repos, downloaded files, drafts in progress.
- Use `data/output/` for final deliverables the user asked for.
- Don't write files outside `data/` unless the user explicitly asks.
- Clean up `data/scratch/` when done with a task.

## Service Management

Pigeon runs as a systemd service. To restart yourself after making changes:

```bash
sudo systemctl restart pigeon
```

The service auto-restarts on crash. Logs are available via `journalctl -u pigeon -f`.

## Git Workflow

- Work directly on dev.
- Commit after each completed feature, fix, or meaningful change.
- Use imperative commit messages: "add search skill", "fix memory tool error handling".
- Do not batch unrelated changes into a single commit.
