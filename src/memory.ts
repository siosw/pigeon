import { existsSync, mkdirSync, readFileSync, readdirSync, appendFileSync, writeFileSync } from "fs";
import { join } from "path";
import { log } from "./logger.js";

export class Memory {
	private dir: string;

	constructor(dataDir: string) {
		this.dir = join(dataDir, "memory");
		if (!existsSync(this.dir)) {
			mkdirSync(this.dir, { recursive: true });
			log.info("memory", `Created memory dir: ${this.dir}`);
		}
	}

	/** Returns ISO week string like "2026-W07" */
	getCurrentWeekId(): string {
		const now = new Date();
		const jan4 = new Date(now.getFullYear(), 0, 4);
		const daysSinceJan4 = Math.floor((now.getTime() - jan4.getTime()) / 86400000);
		const weekNum = Math.ceil((daysSinceJan4 + jan4.getDay() + 1) / 7);
		return `${now.getFullYear()}-W${String(weekNum).padStart(2, "0")}`;
	}

	private weekPath(weekId: string): string {
		return join(this.dir, `${weekId}.md`);
	}

	/** Load a week file. Defaults to current week. Returns empty string if not found. */
	loadWeek(weekId?: string): string {
		const id = weekId || this.getCurrentWeekId();
		const path = this.weekPath(id);
		if (!existsSync(path)) return "";
		return readFileSync(path, "utf-8");
	}

	/** Append a timestamped entry to current week's memory file. Creates if missing. */
	append(entry: string): void {
		const weekId = this.getCurrentWeekId();
		const path = this.weekPath(weekId);

		if (!existsSync(path)) {
			writeFileSync(path, `# Week ${weekId}\n\n`, "utf-8");
			log.info("memory", `Created new week file: ${weekId}`);
		}

		const timestamp = new Date().toISOString().slice(0, 16).replace("T", " ");
		appendFileSync(path, `- [${timestamp}] ${entry}\n`, "utf-8");
		log.debug("memory", `Appended to ${weekId}: ${entry.slice(0, 80)}`);
	}

	/** List all available week IDs, sorted descending. */
	listWeeks(): string[] {
		if (!existsSync(this.dir)) return [];
		return readdirSync(this.dir)
			.filter((f) => f.endsWith(".md"))
			.map((f) => f.replace(".md", ""))
			.sort()
			.reverse();
	}
}
