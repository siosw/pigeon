import { getModel, getEnvApiKey } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import {
	AuthStorage,
	codingTools,
	createAgentSession,
	createExtensionRuntime,
	ModelRegistry,
	SessionManager,
	SettingsManager,
	type AgentSession,
	type ToolDefinition,
	type ResourceLoader,
} from "@mariozechner/pi-coding-agent";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import type { Config } from "./config.js";
import { Memory } from "./memory.js";
import { TaskQueue } from "./queue.js";
import { log } from "./logger.js";

// =============================================================================
// System prompts
// =============================================================================

const MAIN_SYSTEM_PROMPT = `You are Pigeon, a personal assistant reachable via Telegram.

You have tools to run bash commands, read/write files, search the web, and manage your memory and task queue.

## Task Handling
- For simple questions, factual lookups, quick answers: respond immediately.
- For tasks requiring multiple steps, research, file work, or anything taking more than ~30 seconds: use the queue_task tool with a clear, self-contained description of what needs to be done. Include all relevant context in the description. Then tell the user it's queued.
- Before queueing a complex task, save relevant context to memory so the background worker can access it.
- When unsure, prefer immediate response.

## Memory
Use the "memory" tool to persist important context, decisions, and outcomes.
Load old weeks when the user references past events.
At the start of each conversation turn, read your current week's memory.

## Tools
You have bash, read, write, edit for general file/system work.
Use bash with curl for web searches when needed.

## Response Format
- Be concise. Telegram messages should be short and readable.
- Use plain text or simple markdown (Telegram supports basic markdown).
- Keep replies under ~4000 chars (Telegram message limit).
- For long outputs, summarize and offer to provide details.
`;

const BACKGROUND_SYSTEM_PROMPT = `You are Pigeon's background worker. You execute tasks that were queued because they require multiple steps or significant work.

You have tools to run bash commands, read/write files, search the web, and read/write memory.

## Behavior
- Work through the task thoroughly and completely.
- Save important outcomes and decisions to memory using the memory tool.
- Your response will be sent directly to the user via Telegram, so keep it readable and under ~4000 chars.
- If the result is long, summarize the key points and mention that details are available.

## Tools
You have bash, read, write, edit for general file/system work.
Use bash with curl for web searches when needed.
`;

// =============================================================================
// Shared helpers
// =============================================================================

const MemoryParams = Type.Object({
	action: Type.Union(
		[Type.Literal("read_current"), Type.Literal("read_week"), Type.Literal("append"), Type.Literal("list")],
		{ description: "Action to perform" },
	),
	weekId: Type.Optional(Type.String({ description: "Week ID like 2026-W07 (for read_week)" })),
	entry: Type.Optional(Type.String({ description: "Text to append (for append)" })),
});

function createMemoryTool(memory: Memory): ToolDefinition {
	return {
		name: "memory",
		label: "Memory",
		description:
			"Manage persistent weekly memory files. Actions: read_current (load this week), read_week (load a specific week by weekId), append (add an entry to current week), list (list available weeks).",
		parameters: MemoryParams,
		execute: async (_toolCallId, _params, _signal) => {
			const params = _params as { action: string; weekId?: string; entry?: string };
			try {
				switch (params.action) {
					case "read_current": {
						const content = memory.loadWeek();
						const weekId = memory.getCurrentWeekId();
						return {
							content: [{ type: "text", text: content || `No memory for ${weekId} yet.` }],
							details: {},
						};
					}
					case "read_week": {
						if (!params.weekId) {
							return { content: [{ type: "text", text: "Missing weekId parameter." }], details: {} };
						}
						const content = memory.loadWeek(params.weekId);
						return {
							content: [{ type: "text", text: content || `No memory for ${params.weekId}.` }],
							details: {},
						};
					}
					case "append": {
						if (!params.entry) {
							return { content: [{ type: "text", text: "Missing entry parameter." }], details: {} };
						}
						memory.append(params.entry);
						return { content: [{ type: "text", text: "Saved to memory." }], details: {} };
					}
					case "list": {
						const weeks = memory.listWeeks();
						return {
							content: [{ type: "text", text: weeks.length > 0 ? weeks.join("\n") : "No memory files yet." }],
							details: {},
						};
					}
					default:
						return { content: [{ type: "text", text: `Unknown action: ${params.action}` }], details: {} };
				}
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				log.error("memory-tool", msg);
				return { content: [{ type: "text", text: `Error: ${msg}` }], details: {}, isError: true };
			}
		},
	};
}

function createQueueTool(queue: TaskQueue): ToolDefinition {
	return {
		name: "queue_task",
		label: "Queue Task",
		description:
			"Add a task to the background work queue. Use for complex, multi-step tasks. The description should be self-contained with all context needed to complete the task.",
		parameters: Type.Object({
			description: Type.String({ description: "Complete, self-contained task description with all relevant context" }),
		}),
		execute: async (_toolCallId, _params, _signal) => {
			const params = _params as { description: string };
			const task = queue.add(params.description);
			return {
				content: [{ type: "text", text: `Task queued (id: ${task.id}). It will be processed in the background.` }],
				details: {},
			};
		},
	};
}

function loadAgentsFile(): string {
	const candidates = ["AGENTS.md", "CLAUDE.md"];
	for (const name of candidates) {
		const path = join(process.cwd(), name);
		if (existsSync(path)) {
			log.info("agent", `Loaded context file: ${name}`);
			return readFileSync(path, "utf-8");
		}
	}
	return "";
}

function createResourceLoader(systemPrompt: string): ResourceLoader {
	const agentsContent = loadAgentsFile();
	const fullPrompt = agentsContent ? `${systemPrompt}\n\n${agentsContent}` : systemPrompt;
	return {
		getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
		getSkills: () => ({ skills: [], diagnostics: [] }),
		getPrompts: () => ({ prompts: [], diagnostics: [] }),
		getThemes: () => ({ themes: [], diagnostics: [] }),
		getAgentsFiles: () => ({ agentsFiles: [] }),
		getSystemPrompt: () => fullPrompt,
		getAppendSystemPrompt: () => [],
		getPathMetadata: () => new Map(),
		extendResources: () => {},
		reload: async () => {},
	};
}

function patchAuthStorage(authStorage: AuthStorage): void {
	const originalGetApiKey = authStorage.getApiKey.bind(authStorage);
	authStorage.getApiKey = async (providerId: string) => {
		const key = await originalGetApiKey(providerId);
		if (key) return key;
		const envKey = getEnvApiKey(providerId);
		if (envKey) {
			log.warn("agent", `OAuth failed for ${providerId}, falling back to env API key`);
			return envKey;
		}
		return undefined;
	};
}

/** Extract recent conversation text from main session for background context. */
function getRecentHistory(session: AgentSession, maxMessages: number = 20): string {
	const messages = session.messages;
	const recent = messages.slice(-maxMessages);
	const lines: string[] = [];

	for (const msg of recent) {
		if (msg.role === "user") {
			const text = typeof msg.content === "string"
				? msg.content
				: msg.content
					.filter((c): c is { type: "text"; text: string } => c.type === "text")
					.map((c) => c.text)
					.join("\n");
			if (text) lines.push(`User: ${text}`);
		} else if (msg.role === "assistant") {
			const text = msg.content
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map((c) => c.text)
				.join("\n");
			if (text) lines.push(`Assistant: ${text}`);
		}
	}

	return lines.join("\n\n");
}

// =============================================================================
// Exports
// =============================================================================

export interface Agent {
	prompt(text: string): Promise<string>;
	reset(): Promise<void>;
	dispose(): void;
	session: AgentSession;
	queue: TaskQueue;
}

export interface BackgroundWorker {
	start(sendResult: (text: string) => Promise<void>): void;
	stop(): void;
}

export async function createAgent(config: Config): Promise<{ agent: Agent; worker: BackgroundWorker }> {
	const memory = new Memory(config.dataDir);
	const queue = new TaskQueue(config.dataDir);

	const model = getModel("anthropic", config.model as any);
	if (!model) throw new Error(`Model not found: ${config.model}`);

	const authStorage = new AuthStorage();
	patchAuthStorage(authStorage);
	const modelRegistry = new ModelRegistry(authStorage);

	const settingsManager = SettingsManager.inMemory({
		compaction: { enabled: true },
		retry: { enabled: true, maxRetries: 3 },
	});

	const memoryTool = createMemoryTool(memory);
	const queueTool = createQueueTool(queue);

	// =========================================================================
	// Main session (interactive, fast)
	// =========================================================================

	let mainSessionManager = SessionManager.create(config.dataDir);

	let { session: mainSession } = await createAgentSession({
		model,
		thinkingLevel: config.thinking,
		tools: codingTools,
		customTools: [memoryTool, queueTool],
		sessionManager: mainSessionManager,
		resourceLoader: createResourceLoader(MAIN_SYSTEM_PROMPT),
		settingsManager,
		authStorage,
		modelRegistry,
	});

	log.info("agent", `Main session created. Model: ${config.model}, thinking: ${config.thinking}`);

	// =========================================================================
	// Background session (for queued tasks)
	// =========================================================================

	const bgSessionManager = SessionManager.inMemory();

	const { session: bgSession } = await createAgentSession({
		model,
		thinkingLevel: config.thinking,
		tools: codingTools,
		customTools: [memoryTool],
		sessionManager: bgSessionManager,
		resourceLoader: createResourceLoader(BACKGROUND_SYSTEM_PROMPT),
		settingsManager: SettingsManager.inMemory({
			compaction: { enabled: true },
			retry: { enabled: true, maxRetries: 3 },
		}),
		authStorage,
		modelRegistry,
	});

	log.info("agent", "Background session created");

	// =========================================================================
	// Main agent interface
	// =========================================================================

	async function prompt(text: string): Promise<string> {
		let responseText = "";

		const unsubscribe = mainSession.subscribe((event) => {
			if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
				responseText += event.assistantMessageEvent.delta;
			}
			if (event.type === "tool_execution_start") {
				log.debug("agent", `Tool: ${event.toolName}`);
			}
			if (event.type === "tool_execution_end") {
				log.debug("agent", `Tool done: ${event.toolName} (error: ${event.isError})`);
			}
		});

		try {
			await mainSession.prompt(text);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			log.error("agent", `Prompt error: ${msg}`);
			responseText = `Error: ${msg}`;
		} finally {
			unsubscribe();
		}

		return responseText || "(no response)";
	}

	async function reset(): Promise<void> {
		mainSession.dispose();
		mainSessionManager = SessionManager.create(config.dataDir);

		const result = await createAgentSession({
			model,
			thinkingLevel: config.thinking,
			tools: codingTools,
			customTools: [memoryTool, queueTool],
			sessionManager: mainSessionManager,
			resourceLoader: createResourceLoader(MAIN_SYSTEM_PROMPT),
			settingsManager,
			authStorage,
			modelRegistry,
		});
		mainSession = result.session;
		log.info("agent", "Main session reset");
	}

	function dispose(): void {
		mainSession.dispose();
		bgSession.dispose();
		log.info("agent", "Disposed");
	}

	const agent: Agent = {
		prompt,
		reset,
		dispose,
		get session() { return mainSession; },
		queue,
	};

	// =========================================================================
	// Background worker
	// =========================================================================

	const POLL_INTERVAL_MS = 5000;
	let workerRunning = false;
	let workerTimeout: ReturnType<typeof setTimeout> | null = null;

	function createWorker(): BackgroundWorker {
		return {
			start(sendResult: (text: string) => Promise<void>) {
				workerRunning = true;
				log.info("worker", "Started");

				// Prune old tasks on startup
				queue.prune();

				const tick = async () => {
					if (!workerRunning) return;

					const task = queue.next();
					if (!task) {
						workerTimeout = setTimeout(tick, POLL_INTERVAL_MS);
						return;
					}

					queue.markRunning(task.id);
					log.info("worker", `Processing task ${task.id}: ${task.description.slice(0, 80)}`);

					// Build prompt with conversation history + memory context
					const history = getRecentHistory(mainSession);
					const taskPrompt = history
						? `## Recent conversation for context:\n${history}\n\n## Task to complete:\n${task.description}`
						: task.description;

					let responseText = "";
					const unsubscribe = bgSession.subscribe((event) => {
						if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
							responseText += event.assistantMessageEvent.delta;
						}
						if (event.type === "tool_execution_start") {
							log.debug("worker", `Tool: ${event.toolName}`);
						}
						if (event.type === "tool_execution_end") {
							log.debug("worker", `Tool done: ${event.toolName} (error: ${event.isError})`);
						}
					});

					try {
						await bgSession.prompt(taskPrompt);
						const result = responseText || "(no response)";
						queue.complete(task.id, result);

						await sendResult(result).catch((err) => {
							log.error("worker", `Failed to send result: ${err}`);
						});
					} catch (err) {
						const msg = err instanceof Error ? err.message : String(err);
						queue.fail(task.id, msg);
						log.error("worker", `Task ${task.id} failed: ${msg}`);

						await sendResult(`Task failed: ${msg}`).catch(() => {});
					} finally {
						unsubscribe();
					}

					// Continue immediately to check for more tasks
					if (workerRunning) {
						workerTimeout = setTimeout(tick, 100);
					}
				};

				tick();
			},

			stop() {
				workerRunning = false;
				if (workerTimeout) {
					clearTimeout(workerTimeout);
					workerTimeout = null;
				}
				log.info("worker", "Stopped");
			},
		};
	}

	return { agent, worker: createWorker() };
}
