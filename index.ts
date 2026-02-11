import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { config } from "./src/config.js";
import { log } from "./src/logger.js";
import { createAgent } from "./src/agent.js";
import { createBot } from "./src/bot.js";

log.info("main", "Starting pigeon...");

// Determine restart reason from previous shutdown state
const stateFile = join(config.dataDir, ".shutdown");
let restartReason = "unknown (possible crash or first start)";
if (existsSync(stateFile)) {
	try {
		const state = JSON.parse(readFileSync(stateFile, "utf-8"));
		restartReason = `clean shutdown (${state.signal}), was up ${state.uptime}`;
	} catch {
		restartReason = "unknown (corrupt state file)";
	}
}

const { agent, worker } = await createAgent(config);
const bot = createBot(config, agent, worker);

bot.launch();
log.info("main", `Bot running. Authorized chat: ${config.chatId}`);

// Send startup notification
const pending = agent.queue.list("pending").length;
const running = agent.queue.list("running").length;
const taskInfo = pending + running > 0 ? `\nTasks: ${running} running, ${pending} pending` : "";
bot.telegram
	.sendMessage(config.chatId, `Pigeon restarted.\nReason: ${restartReason}${taskInfo}`)
	.catch((err) => log.error("main", `Failed to send startup message: ${err}`));

// Graceful shutdown — write state file before exiting
function writeShutdownState(signal: string): void {
	const hours = Math.floor((Date.now() - startMs) / 3600000);
	const mins = Math.floor(((Date.now() - startMs) % 3600000) / 60000);
	const dir = config.dataDir;
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	writeFileSync(stateFile, JSON.stringify({ signal, uptime: `${hours}h ${mins}m`, timestamp: new Date().toISOString() }));
}

const startMs = Date.now();

const shutdown = (signal: string) => {
	log.info("main", `Received ${signal}, shutting down...`);
	writeShutdownState(signal);
	worker.stop();
	bot.stop(signal);
	agent.dispose();
	process.exit(0);
};

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
