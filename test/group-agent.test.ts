import { EventEmitter } from "node:events";
import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { defaultGroupSessionFile, GroupAgentRunner } from "../src/group-agent.js";
import type { AgentProgressObserver } from "../src/contracts.js";

interface FakeChild extends EventEmitter {
	stdout: EventEmitter;
	stderr: EventEmitter;
	kill: (signal?: string) => boolean;
	exitCode: number | null;
}

/** 可注入的假 spawn：记录调用参数，按预置 stdout 行完成。 */
function fakeSpawn(lines: string[], exitCode = 0, stderr = "") {
	const calls: Array<{ bin: string; args: string[]; cwd: string | undefined }> = [];
	const impl = ((bin: string, args: string[], options?: { cwd?: string }) => {
		calls.push({ bin, args, cwd: options?.cwd });
		const child = new EventEmitter() as FakeChild;
		child.stdout = new EventEmitter();
		child.stderr = new EventEmitter();
		child.kill = () => true;
		child.exitCode = exitCode;
		queueMicrotask(() => {
			for (const line of lines) child.stdout.emit("data", Buffer.from(`${line}\n`, "utf8"));
			if (stderr) child.stderr.emit("data", Buffer.from(stderr, "utf8"));
			child.emit("close", exitCode);
		});
		return child as unknown as ReturnType<typeof spawn>;
	}) as typeof spawn;
	return { impl, calls };
}

/** 模拟 pi 实测的事件流：message_update 增量 + message_end 权威文本。 */
function delta(text: string): string {
	return JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: text } });
}

function messageEnd(text: string): string {
	return JSON.stringify({
		type: "message_end",
		message: { role: "assistant", content: [{ type: "text", text }], stopReason: "stop" },
	});
}

describe("GroupAgentRunner", () => {
	it("spawns pi headless in the bound directory with the group session file", async () => {
		const { impl, calls } = fakeSpawn([messageEnd("答案")]);
		const runner = new GroupAgentRunner({ spawnImpl: impl, bin: "pi-test" });
		const sessionFile = join(tmpdir(), `group-${Date.now()}.jsonl`);

		const result = await runner.run(sessionFile, "/tmp", "帮我看看");

		expect(result).toEqual({ text: "答案", exitCode: 0 });
		expect(calls[0]?.bin).toBe("pi-test");
		expect(calls[0]?.cwd).toBe("/tmp");
		expect(calls[0]?.args).toEqual(["-p", "--mode", "json", "--session", sessionFile, "帮我看看"]);
	});

	it("streams text deltas and settles on the authoritative message_end text", async () => {
		const { impl } = fakeSpawn([
			JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 0 } }),
			delta("第一"),
			JSON.stringify({ type: "tool_execution_start", toolName: "read" }),
			delta("第一第二"),
			messageEnd("第一第二（最终）"),
		]);
		const runner = new GroupAgentRunner({ spawnImpl: impl });
		const activities: Array<{ kind: string; toolName?: string }> = [];
		const texts: string[] = [];
		const observer: AgentProgressObserver = {
			onActivity: (activity) => activities.push(activity),
			onText: (text) => texts.push(text),
		};

		const result = await runner.run(join(tmpdir(), "s.jsonl"), undefined, "prompt", observer);

		expect(result.text).toBe("第一第二（最终）");
		expect(activities).toContainEqual({ kind: "tool", toolName: "read" });
		expect(texts).toContain("第一");
		// delta 是增量：两次 delta 后流文本为拼接结果
		expect(texts).toContain("第一第一第二");
		expect(texts.at(-1)).toBe("第一第二（最终）");
	});

	it("falls back to streamed deltas when message_end is absent", async () => {
		const { impl } = fakeSpawn([delta("只有增量")]);
		const runner = new GroupAgentRunner({ spawnImpl: impl });

		const result = await runner.run(join(tmpdir(), "s.jsonl"), undefined, "prompt");
		expect(result.text).toBe("只有增量");
	});

	it("rejects with the stderr content when the child exits nonzero", async () => {
		const { impl } = fakeSpawn([], 1, "模型鉴权失败");
		const runner = new GroupAgentRunner({ spawnImpl: impl });

		await expect(runner.run(join(tmpdir(), "s.jsonl"), undefined, "prompt")).rejects.toThrow("模型鉴权失败");
	});

	it("creates the session file's parent directory before spawning", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-feishu-grp-"));
		const sessionFile = join(directory, "deep", "dir", "s.jsonl");
		const { impl } = fakeSpawn([messageEnd("ok")]);
		const runner = new GroupAgentRunner({ spawnImpl: impl });

		await runner.run(sessionFile, undefined, "prompt");
		const stats = await stat(join(directory, "deep", "dir"));
		expect(stats.isDirectory()).toBe(true);
	});

	it("derives one stable, sanitized session file per chat id", () => {
		expect(defaultGroupSessionFile("oc_abc-123")).toContain("oc_abc-123.jsonl");
		expect(defaultGroupSessionFile("oc/x y")).not.toContain("oc/x y.jsonl");
		expect(defaultGroupSessionFile("oc/x y")).toBe(defaultGroupSessionFile("oc/x y"));
	});
});
