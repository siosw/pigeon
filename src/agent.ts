import { getModel, getEnvApiKey } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import {
	AuthStorage,
	codingTools,
	createAgentSession,
	createExtensionRuntime,
	DefaultResourceLoader,
	ModelRegistry,
	SessionManager,
	SettingsManager,
	type AgentSession,
	type ToolDefinition,
	type ResourceLoader,
} from "@mariozechner/pi-coding-agent";
import type { Config } from "./config.js";
import { Memory } from "./memory.js";
import { log } from "./logger.js";

const SYSTEM_PROMPT = `You are Pigeon, a personal assistant reachable via Telegram.

You have tools to run bash commands, read/write files, search the web, and manage your memory.

## Behavior
- Be concise. Telegram messages should be short and readable.
- For simple questions: answer immediately.
- For complex tasks: work through steps, then reply with results.
- Use your memory (weekly markdown files) to maintain context across conversations.
- At the start of each conversation turn, read your current week's memory.

## Memory
Use the "memory" tool to persist important context, decisions, and outcomes.
Load old weeks when the user references past events.

## Tools
You have bash, read, write, edit for general file/system work.
Use bash with curl for web searches when needed.

## Response Format
- Use plain text or simple markdown (Telegram supports basic markdown).
- Keep replies under ~4000 chars (Telegram message limit).
- For long outputs, summarize and offer to provide details.
`;

const MemoryParams = Type.Object({
	action: Type.Union(
		[
			Type.Literal("read_current"),
			Type.Literal("read_week"),
			Type.Literal("append"),
			Type.Literal("list"),
		],
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

export interface Agent {
	prompt(text: string): Promise<string>;
	reset(): Promise<void>;
	dispose(): void;
	session: AgentSession;
}

export async function createAgent(config: Config): Promise<Agent> {
	const memory = new Memory(config.dataDir);

	const model = getModel("anthropic", config.model as any);
	if (!model) throw new Error(`Model not found: ${config.model}`);

	const authStorage = new AuthStorage();

	// Wrap getApiKey to fall back to env var when OAuth refresh fails.
	// AuthStorage.getApiKey() returns undefined on OAuth refresh errors
	// instead of falling through to the env var check.
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

	const modelRegistry = new ModelRegistry(authStorage);

	const settingsManager = SettingsManager.inMemory({
		compaction: { enabled: true },
		retry: { enabled: true, maxRetries: 3 },
	});

	const resourceLoader: ResourceLoader = {
		getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
		getSkills: () => ({ skills: [], diagnostics: [] }),
		getPrompts: () => ({ prompts: [], diagnostics: [] }),
		getThemes: () => ({ themes: [], diagnostics: [] }),
		getAgentsFiles: () => ({ agentsFiles: [] }),
		getSystemPrompt: () => SYSTEM_PROMPT,
		getAppendSystemPrompt: () => [],
		getPathMetadata: () => new Map(),
		extendResources: () => {},
		reload: async () => {},
	};

	const memoryTool = createMemoryTool(memory);

	let sessionManager = SessionManager.create(config.dataDir);

	let { session } = await createAgentSession({
		model,
		thinkingLevel: config.thinking,
		tools: codingTools,
		customTools: [memoryTool],
		sessionManager,
		resourceLoader,
		settingsManager,
		authStorage,
		modelRegistry,
	});

	log.info("agent", `Session created. Model: ${config.model}, thinking: ${config.thinking}`);

	async function prompt(text: string): Promise<string> {
		let responseText = "";

		const unsubscribe = session.subscribe((event) => {
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
			await session.prompt(text);
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
		session.dispose();
		sessionManager = SessionManager.create(config.dataDir);

		const result = await createAgentSession({
			model,
			thinkingLevel: config.thinking,
			tools: codingTools,
			customTools: [memoryTool],
			sessionManager,
			resourceLoader,
			settingsManager,
			authStorage,
			modelRegistry,
		});
		session = result.session;
		log.info("agent", "Session reset");
	}

	function dispose(): void {
		session.dispose();
		log.info("agent", "Disposed");
	}

	return {
		prompt,
		reset,
		dispose,
		get session() {
			return session;
		},
	};
}
