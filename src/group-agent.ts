import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { AgentProgressObserver } from "./contracts.js";

export interface GroupAgentRunResult {
	text: string;
	exitCode: number | null;
}

export interface GroupAgentRunOptions {
	/** 硬超时：超时后 SIGTERM 子进程。 */
	timeoutMs?: number;
	/** pi 可执行文件；默认从 PATH 找 pi，可用 PI_BIN 覆盖。 */
	bin?: string;
	/** 测试注入：替换 spawn。 */
	spawnImpl?: typeof spawn;
}

const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;

interface PrintEvent {
	type?: string;
	message?: { role?: string; content?: unknown };
	toolName?: string;
}

/**
 * 群聊代理运行器：为每条群消息 spawn 一个独立的 `pi -p --mode json` 子进程。
 *
 * 与 easycodeclient「每群独立引擎」对齐的架构：
 * - cwd 直接设为群的绑定目录 → 目录锚定天然成立；
 * - 每个群固定一个 session 文件 → 历史隔离且跨重启续接；
 * - 完全不触碰用户本地 TUI 的会话（不会被 abort、没有 stale ctx）；
 * - 不同群的子进程彼此独立 → 群间真实并行。
 */
export class GroupAgentRunner {
	private readonly timeoutMs: number;
	private readonly bin: string;
	private readonly spawnImpl: typeof spawn;
	private readonly children = new Set<ReturnType<typeof spawn>>();

	constructor(options: GroupAgentRunOptions = {}) {
		this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		this.bin = options.bin ?? process.env.PI_BIN ?? "pi";
		this.spawnImpl = options.spawnImpl ?? spawn;
	}

	/** 当前在跑的子进程数（用于测试与状态展示）。 */
	get runningCount(): number {
		return this.children.size;
	}

	/** 中止所有在跑的群子进程（远程 /stop）；返回数量。 */
	stop(): number {
		let killed = 0;
		for (const child of this.children) {
			child.kill("SIGTERM");
			killed += 1;
		}
		return killed;
	}

	async run(
		sessionFile: string,
		directory: string | undefined,
		prompt: string,
		observer?: AgentProgressObserver,
	): Promise<GroupAgentRunResult> {
		await mkdir(dirname(sessionFile), { recursive: true, mode: 0o700 });
		const child = this.spawnImpl(this.bin, ["-p", "--mode", "json", "--session", sessionFile, prompt], {
			cwd: directory ?? process.cwd(),
			env: process.env,
			stdio: ["ignore", "pipe", "pipe"],
		});
		this.children.add(child);

		return new Promise<GroupAgentRunResult>((resolve, reject) => {
			let stdoutBuffer = "";
			let stderrBuffer = "";
			let latestAssistantText = "";
			let settled = false;
			const timer = setTimeout(() => {
				child.kill("SIGTERM");
			}, this.timeoutMs);

			const finish = (error?: Error) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				this.children.delete(child);
				if (error) {
					reject(error);
					return;
				}
				resolve({ text: latestAssistantText, exitCode: child.exitCode });
			};

			child.stdout?.on("data", (chunk: Buffer) => {
				stdoutBuffer += chunk.toString("utf8");
				let newlineIndex = stdoutBuffer.indexOf("\n");
				while (newlineIndex !== -1) {
					const line = stdoutBuffer.slice(0, newlineIndex).trim();
					stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
					this.handleJsonLine(line, observer, (text) => {
						latestAssistantText = text;
					});
					newlineIndex = stdoutBuffer.indexOf("\n");
				}
			});
			child.stderr?.on("data", (chunk: Buffer) => {
				stderrBuffer += chunk.toString("utf8");
			});
			child.on("error", (error) => {
				finish(new Error(`启动 pi 子进程失败（cwd: ${directory ?? process.cwd()}）：${error.message}`));
			});
			child.on("close", (code) => {
				if (code === 0) {
					observer?.onText?.(latestAssistantText);
					finish();
					return;
				}
				const stderr = stderrBuffer.trim();
				finish(new Error(stderr ? `pi 子进程退出码 ${code}：${stderr}` : `pi 子进程退出码 ${code}`));
			});
		});
	}

	private handleJsonLine(
		line: string,
		observer: AgentProgressObserver | undefined,
		setLatest: (text: string) => void,
	): void {
		if (!line) return;
		let event: PrintEvent;
		try {
			event = JSON.parse(line) as PrintEvent;
		} catch {
			return;
		}
		if (event.type === "tool_execution_start") {
			const toolName = event.toolName ?? "tool";
			observer?.onActivity?.({ kind: "tool", toolName });
			return;
		}
		if (event.type !== "message_update" || event.message?.role !== "assistant") return;
		const text = extractText(event.message.content);
		if (text) {
			setLatest(text);
			observer?.onText?.(text);
		}
	}
}

function extractText(content: unknown): string {
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const item of content) {
		if (item && typeof item === "object" && (item as { type?: string }).type === "text") {
			const text = (item as { text?: unknown }).text;
			if (typeof text === "string") parts.push(text);
		}
	}
	return parts.join("").trimEnd();
}

/** 群专属 session 文件：~/.pi/agent/feishu/group-sessions/<chatId>.jsonl，由 pi CLI 自管。 */
export function defaultGroupSessionFile(chatId: string): string {
	const safe = chatId.replace(/[^A-Za-z0-9_-]/g, "_");
	return join(homedir(), ".pi", "agent", "feishu", "group-sessions", `${safe}.jsonl`);
}
