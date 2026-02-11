import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { log } from "./logger.js";

export interface Task {
	id: string;
	description: string;
	status: "pending" | "running" | "done" | "failed";
	createdAt: string;
	completedAt?: string;
	result?: string;
	error?: string;
}

export class TaskQueue {
	private tasks: Task[] = [];
	private path: string;

	constructor(dataDir: string) {
		this.path = join(dataDir, "queue.json");
		this.load();
	}

	private load(): void {
		if (!existsSync(this.path)) return;
		try {
			this.tasks = JSON.parse(readFileSync(this.path, "utf-8"));
		} catch {
			log.warn("queue", `Failed to parse ${this.path}, starting fresh`);
			this.tasks = [];
		}
	}

	private save(): void {
		const dir = dirname(this.path);
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
		writeFileSync(this.path, JSON.stringify(this.tasks, null, 2), "utf-8");
	}

	add(description: string): Task {
		const task: Task = {
			id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
			description,
			status: "pending",
			createdAt: new Date().toISOString(),
		};
		this.tasks.push(task);
		this.save();
		log.info("queue", `Added task ${task.id}: ${description.slice(0, 80)}`);
		return task;
	}

	/** Get next pending task. */
	next(): Task | undefined {
		return this.tasks.find((t) => t.status === "pending");
	}

	markRunning(id: string): void {
		const task = this.tasks.find((t) => t.id === id);
		if (task) {
			task.status = "running";
			this.save();
		}
	}

	complete(id: string, result: string): void {
		const task = this.tasks.find((t) => t.id === id);
		if (task) {
			task.status = "done";
			task.result = result;
			task.completedAt = new Date().toISOString();
			this.save();
			log.info("queue", `Completed task ${id}`);
		}
	}

	fail(id: string, error: string): void {
		const task = this.tasks.find((t) => t.id === id);
		if (task) {
			task.status = "failed";
			task.error = error;
			task.completedAt = new Date().toISOString();
			this.save();
			log.warn("queue", `Failed task ${id}: ${error.slice(0, 80)}`);
		}
	}

	/** List tasks, optionally filtered by status. */
	list(status?: Task["status"]): Task[] {
		if (status) return this.tasks.filter((t) => t.status === status);
		return [...this.tasks];
	}

	/** Remove completed/failed tasks older than maxAge ms. */
	prune(maxAgeMs: number = 7 * 24 * 60 * 60 * 1000): number {
		const cutoff = Date.now() - maxAgeMs;
		const before = this.tasks.length;
		this.tasks = this.tasks.filter(
			(t) =>
				t.status === "pending" ||
				t.status === "running" ||
				!t.completedAt ||
				new Date(t.completedAt).getTime() > cutoff,
		);
		const pruned = before - this.tasks.length;
		if (pruned > 0) {
			this.save();
			log.info("queue", `Pruned ${pruned} old tasks`);
		}
		return pruned;
	}
}
