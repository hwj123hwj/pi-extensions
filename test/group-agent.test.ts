import { EventEmitter } from "node:events";
import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultGroupSessionFile, GroupAgentRunner } from "../src/group-agent.js";
import type { AgentProgressObserver } from "../src/contracts.js";

interface FakeChild extends EventEmitter {
	stdout: EventEmitter;
	stderr: EventEmitter;
	kill: (signal?: string) => boolean;
	exitCode: number | null;
}

/** 可注入的假 spawn：记录调用参数，用预置 stdout 行完成。 */
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

function textEvent(text: string): string {
	return JSON.stringify({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text }] } });
}

describe("GroupAgentRunner", () => {
	it("spawns pi headless in the bound directory with the group session file", async () => {
		const { impl, calls } = fakeSpawn([textEvent("答案")]);
		const runner = new GroupAgentRunner({ spawnImpl: impl, bin: "pi-test" });
		const sessionFile = join(tmpdir(), `group-${Date.now()}.jsonl`);

		const result = await runner.run(sessionFile, "/tmp", "帮我看看");

		expect(result).toEqual({ text: "答案", exitCode: 0 });
		expect(calls[0]?.bin).toBe("pi-test");
		expect(calls[0]?.cwd).toBe("/tmp");
		expect(calls[0]?.args).toEqual(["-p", "--mode", "json", "--session", sessionFile, "帮我看看"]);
	});

	it("streams the latest assistant text and tool activity through the observer", async () => {
		const { impl } = fakeSpawn([
			textEvent("第一段"),
			JSON.stringify({ type: "tool_execution_start", toolName: "read" }),
			textEvent("第一段\n第二段"),
		]);
		const runner = new GroupAgentRunner({ spawnImpl: impl });
		const activities: Array<{ kind: string; toolName?: string }> = [];
		const texts: string[] = [];
		const observer: AgentProgressObserver = {
			onActivity: (activity) => activities.push(activity),
			onText: (text) => texts.push(text),
		};

		const result = await runner.run(join(tmpdir(), "s.jsonl"), undefined, "prompt", observer);

		expect(result.text).toBe("第一段\n第二段");
		expect(activities).toContainEqual({ kind: "tool", toolName: "read" });
		expect(texts.at(-1)).toBe("第一段\n第二段");
	});

	it("rejects with the stderr content when the child exits nonzero", async () => {
		const { impl } = fakeSpawn([], 1, "模型鉴权失败");
		const runner = new GroupAgentRunner({ spawnImpl: impl });

		await expect(runner.run(join(tmpdir(), "s.jsonl"), undefined, "prompt")).rejects.toThrow("模型鉴权失败");
	});

	it("creates the session file's parent directory before spawning", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-feishu-grp-"));
		const sessionFile = join(directory, "deep", "dir", "s.jsonl");
		const { impl } = fakeSpawn([textEvent("ok")]);
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
