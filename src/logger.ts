type Level = "INFO" | "WARN" | "ERROR" | "DEBUG";

function format(level: Level, ctx: string, msg: string): string {
	return `${new Date().toISOString()} [${level}] [${ctx}] ${msg}`;
}

export const log = {
	info(ctx: string, msg: string) {
		console.log(format("INFO", ctx, msg));
	},
	warn(ctx: string, msg: string) {
		console.warn(format("WARN", ctx, msg));
	},
	error(ctx: string, msg: string) {
		console.error(format("ERROR", ctx, msg));
	},
	debug(ctx: string, msg: string) {
		if (process.env["DEBUG"]) {
			console.log(format("DEBUG", ctx, msg));
		}
	},
};
