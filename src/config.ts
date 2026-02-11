export interface Config {
	botToken: string;
	chatId: number;
	dataDir: string;
	model: string;
	thinking: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
}

function requireEnv(name: string): string {
	const value = process.env[name];
	if (!value) {
		console.error(`Missing required env var: ${name}`);
		process.exit(1);
	}
	return value;
}

export const config: Config = {
	botToken: requireEnv("BOT_TOKEN"),
	chatId: parseInt(requireEnv("CHAT_ID"), 10),
	dataDir: process.env["DATA_DIR"] || "./data",
	model: process.env["MODEL"] || "claude-sonnet-4-20250514",
	thinking: (process.env["THINKING"] as Config["thinking"]) || "off",
};

if (isNaN(config.chatId)) {
	console.error("CHAT_ID must be a number");
	process.exit(1);
}
