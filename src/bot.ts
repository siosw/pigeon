import { Telegraf } from "telegraf";
import type { Config } from "./config.js";
import type { Agent, BackgroundWorker } from "./agent.js";
import { log } from "./logger.js";

const TELEGRAM_MAX_LENGTH = 4096;
const TYPING_INTERVAL_MS = 4000;
const startTime = Date.now();

/** Split text at paragraph boundaries to fit Telegram's message limit. */
function splitMessage(text: string): string[] {
	if (text.length <= TELEGRAM_MAX_LENGTH) return [text];

	const chunks: string[] = [];
	let remaining = text;

	while (remaining.length > 0) {
		if (remaining.length <= TELEGRAM_MAX_LENGTH) {
			chunks.push(remaining);
			break;
		}

		let splitAt = remaining.lastIndexOf("\n\n", TELEGRAM_MAX_LENGTH);
		if (splitAt < TELEGRAM_MAX_LENGTH / 2) {
			splitAt = remaining.lastIndexOf("\n", TELEGRAM_MAX_LENGTH);
		}
		if (splitAt < TELEGRAM_MAX_LENGTH / 2) {
			splitAt = remaining.lastIndexOf(" ", TELEGRAM_MAX_LENGTH);
		}
		if (splitAt < TELEGRAM_MAX_LENGTH / 2) {
			splitAt = TELEGRAM_MAX_LENGTH;
		}

		chunks.push(remaining.slice(0, splitAt));
		remaining = remaining.slice(splitAt).trimStart();
	}

	return chunks;
}

/** Send a message, splitting if needed. */
async function sendMessage(bot: Telegraf, chatId: number, text: string): Promise<void> {
	const chunks = splitMessage(text);
	for (const chunk of chunks) {
		await bot.telegram.sendMessage(chatId, chunk);
	}
}

export function createBot(config: Config, agent: Agent, worker: BackgroundWorker) {
	const bot = new Telegraf(config.botToken);
	const messageQueue: Array<{ chatId: number; text: string }> = [];
	let processing = false;

	// Auth guard
	bot.use((ctx, next) => {
		const chatId = ctx.chat?.id;
		if (chatId !== config.chatId) {
			if (chatId) log.warn("bot", `Rejected message from chat ${chatId}`);
			return;
		}
		return next();
	});

	async function processMessage(chatId: number, text: string): Promise<void> {
		const startMs = Date.now();
		log.info("bot", `Message: ${text.slice(0, 100)}${text.length > 100 ? "..." : ""}`);

		const typingInterval = setInterval(() => {
			bot.telegram.sendChatAction(chatId, "typing").catch(() => {});
		}, TYPING_INTERVAL_MS);
		bot.telegram.sendChatAction(chatId, "typing").catch(() => {});

		try {
			const response = await agent.prompt(text);
			clearInterval(typingInterval);

			await sendMessage(bot, chatId, response);

			const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);
			log.info("bot", `Replied (${elapsed}s, ${response.length} chars)`);
		} catch (err) {
			clearInterval(typingInterval);
			const msg = err instanceof Error ? err.message : String(err);
			log.error("bot", `Send error: ${msg}`);
			await bot.telegram.sendMessage(chatId, `Error: ${msg}`).catch(() => {});
		}
	}

	async function drainQueue(): Promise<void> {
		if (processing) return;
		processing = true;
		while (messageQueue.length > 0) {
			const item = messageQueue.shift()!;
			await processMessage(item.chatId, item.text);
		}
		processing = false;
	}

	function enqueue(chatId: number, text: string): void {
		messageQueue.push({ chatId, text });
		if (messageQueue.length > 1) {
			log.info("bot", `Queued (${messageQueue.length} pending)`);
		}
		drainQueue();
	}

	// Commands
	bot.command("start", (ctx) => {
		ctx.reply("Pigeon ready. Send me a message.");
	});

	bot.command("reset", async (ctx) => {
		await agent.reset();
		ctx.reply("Session reset. Fresh context.");
	});

	bot.command("todo", (ctx) => {
		const pending = agent.queue.list("pending");
		const running = agent.queue.list("running");
		const recent = agent.queue.list("done").slice(-3);

		const lines: string[] = [];

		if (running.length > 0) {
			lines.push("Running:");
			for (const t of running) {
				lines.push(`  ${t.id}: ${t.description.slice(0, 80)}`);
			}
		}

		if (pending.length > 0) {
			lines.push("Pending:");
			for (const t of pending) {
				lines.push(`  ${t.id}: ${t.description.slice(0, 80)}`);
			}
		}

		if (recent.length > 0) {
			lines.push("Recent:");
			for (const t of recent) {
				lines.push(`  ${t.id}: ${t.description.slice(0, 80)}`);
			}
		}

		if (lines.length === 0) {
			ctx.reply("No tasks.");
		} else {
			ctx.reply(lines.join("\n"));
		}
	});

	bot.command("memory", async (ctx) => {
		const { Memory } = await import("./memory.js");
		const memory = new Memory(config.dataDir);
		const content = memory.loadWeek();
		const weekId = memory.getCurrentWeekId();
		ctx.reply(content || `No memory for ${weekId} yet.`);
	});

	bot.command("weeks", async (ctx) => {
		const { Memory } = await import("./memory.js");
		const memory = new Memory(config.dataDir);
		const weeks = memory.listWeeks();
		ctx.reply(weeks.length > 0 ? `Available weeks:\n${weeks.join("\n")}` : "No memory files yet.");
	});

	bot.command("status", (ctx) => {
		const uptime = Math.floor((Date.now() - startTime) / 1000);
		const hours = Math.floor(uptime / 3600);
		const mins = Math.floor((uptime % 3600) / 60);
		const msgs = agent.session.messages.length;
		const pending = agent.queue.list("pending").length;
		const running = agent.queue.list("running").length;
		ctx.reply(
			`Uptime: ${hours}h ${mins}m\nSession messages: ${msgs}\nTasks: ${running} running, ${pending} pending`,
		);
	});

	// Text messages
	bot.on("text", (ctx) => {
		const text = ctx.message.text;
		if (!text || text.startsWith("/")) return;
		enqueue(ctx.chat.id, text);
	});

	// Start background worker — sends results to the authorized chat
	worker.start(async (text: string) => {
		await sendMessage(bot, config.chatId, text);
	});

	return bot;
}
