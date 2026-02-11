import { config } from "./src/config.js";
import { log } from "./src/logger.js";
import { createAgent } from "./src/agent.js";
import { createBot } from "./src/bot.js";

log.info("main", "Starting pigeon...");

const agent = await createAgent(config);
const bot = createBot(config, agent);

bot.launch();
log.info("main", `Bot running. Authorized chat: ${config.chatId}`);

// Graceful shutdown
const shutdown = (signal: string) => {
	log.info("main", `Received ${signal}, shutting down...`);
	bot.stop(signal);
	agent.dispose();
	process.exit(0);
};

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
