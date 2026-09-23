import { describe, expect, it } from "vitest";
import type { FeishuStatus, PiRuntime, PiRuntimeSnapshot } from "../src/contracts.js";
import {
	executeRemoteCommand,
	parseRemoteCommand,
	REMOTE_SLASH_COMMANDS,
	renderRemoteHelp,
} from "../src/remote-commands.js";

class FakeRuntime implements PiRuntime {
	idle = true;
	abortCalls = 0;
	compactCalls = 0;
	newSessionResult = true;
	newSessionCalls = 0;
	setThinkingLevelResult = true;
	setThinkingLevelCalls: string[] = [];
	models = [
		{ id: "model-a", name: "Model A", provider: "test" },
		{ id: "model-b", name: "Model B", provider: "test" },
	];
	switchModelImpl = async (query: string) => {
		const model = this.models.find((entry) => entry.id === query);
		if (!model) throw new Error(`未找到匹配“${query}”的模型。`);
		return model;
	};
	snapshotValue: PiRuntimeSnapshot = {
		streaming: false,
		model: "Test Model",
		thinkingLevel: "medium",
		contextPercent: 42.4,
	};

	isIdle(): boolean {
		return this.idle;
	}

	abort(): void {
		this.abortCalls += 1;
	}

	compact(): void {
		this.compactCalls += 1;
	}

	async newSession(): Promise<boolean> {
		this.newSessionCalls += 1;
		return this.newSessionResult;
	}

	async setThinkingLevel(level: string): Promise<boolean> {
		this.setThinkingLevelCalls.push(level);
		return this.setThinkingLevelResult;
	}

	listModels() {
		return this.models;
	}

	async switchModel(query: string): Promise<{ id: string; name: string; provider: string }> {
		return this.switchModelImpl(query);
	}

	snapshot(): PiRuntimeSnapshot {
		return this.snapshotValue;
	}
}

const configuredStatus: FeishuStatus = {
	configured: true,
	running: true,
	ownerOpenId: "ou_owner",
	appId: "cli_test",
	source: "file",
	pendingMessages: 2,
};

function createContext(runtime?: PiRuntime, stopQueue?: () => number) {
	return {
		runtime,
		status: async () => configuredStatus,
		...(stopQueue ? { stopQueue } : {}),
	};
}

describe("parseRemoteCommand", () => {
	it("parses slash commands and ignores normal text", () => {
		expect(parseRemoteCommand("/help")).toEqual({ name: "/help", args: "" });
		expect(parseRemoteCommand("  /NEW  ")).toEqual({ name: "/new", args: "" });
		expect(parseRemoteCommand("/model sonnet")).toEqual({ name: "/model", args: "sonnet" });
		expect(parseRemoteCommand("帮我看看这段代码")).toBeUndefined();
		expect(parseRemoteCommand("")).toBeUndefined();
	});
});

describe("executeRemoteCommand", () => {
	it("renders help with every registered command", async () => {
		const help = await executeRemoteCommand("/help", createContext());
		for (const command of Object.keys(REMOTE_SLASH_COMMANDS)) {
			expect(help).toContain(command);
		}
		expect(renderRemoteHelp()).toBe(help);
	});

	it("aborts a running Pi task and refuses to abort when idle", async () => {
		const busy = new FakeRuntime();
		busy.idle = false;
		const idle = new FakeRuntime();

		const stopping = await executeRemoteCommand("/stop", createContext(busy));
		expect(busy.abortCalls).toBe(1);
		expect(stopping).toContain("已发送中止信号");

		const idleReply = await executeRemoteCommand("/stop", createContext(idle));
		expect(idle.abortCalls).toBe(0);
		expect(idleReply).toContain("当前没有正在运行的 Pi 任务");

		const withoutRuntime = await executeRemoteCommand("/stop", createContext());
		expect(withoutRuntime).toContain("当前没有正在运行的 Pi 任务");
	});

	it("reports skipped queued messages when the stop clears the queue", async () => {
		const busy = new FakeRuntime();
		busy.idle = false;
		let stopped = 0;
		const reply = await executeRemoteCommand(
			"/stop",
			createContext(busy, () => ++stopped),
		);
		expect(stopped).toBe(1);
		expect(reply).toBe("已发送中止信号，并跳过队列中的 1 条消息。");

		const idleReply = await executeRemoteCommand(
			"/stop",
			createContext(new FakeRuntime(), () => 0),
		);
		expect(idleReply).toContain("当前没有正在运行的 Pi 任务");
	});

	it("shows and switches the thinking level", async () => {
		const runtime = new FakeRuntime();

		const showing = await executeRemoteCommand("/thinking", createContext(runtime));
		expect(showing).toContain("当前思考档位：medium");
		expect(showing).toContain("示例：/thinking high");

		const switching = await executeRemoteCommand("/thinking HIGH", createContext(runtime));
		expect(runtime.setThinkingLevelCalls).toEqual(["high"]);
		expect(switching).toContain("已切换思考档位：high");

		runtime.setThinkingLevelResult = false;
		const invalid = await executeRemoteCommand("/thinking ultra", createContext(runtime));
		expect(invalid).toContain("无法设置思考档位“ultra”");

		const bare = await executeRemoteCommand("/thinking", createContext());
		expect(bare).toContain("当前思考档位未知");
	});

	it("shows the current model and switches by fuzzy match", async () => {
		const runtime = new FakeRuntime();

		const showing = await executeRemoteCommand("/model", createContext(runtime));
		expect(showing).toContain("当前模型：Test Model");
		expect(showing).toContain("共 2 个可用模型");

		const switching = await executeRemoteCommand("/model model-b", createContext(runtime));
		expect(switching).toContain("已切换模型：Model B（model-b）");

		const missing = await executeRemoteCommand("/model nope", createContext(runtime));
		expect(missing).toContain("切换模型失败：未找到匹配“nope”的模型。");

		const withoutRuntime = await executeRemoteCommand("/model", createContext());
		expect(withoutRuntime).toContain("Pi 运行时尚未就绪");
	});

	it("reports status from both the gateway and the runtime snapshot", async () => {
		const runtime = new FakeRuntime();
		const status = await executeRemoteCommand("/status", createContext(runtime));

		expect(status).toContain("连接：已连接");
		expect(status).toContain("队列：2");
		expect(status).toContain("模型：Test Model");
		expect(status).toContain("思考：medium");
		expect(status).toContain("上下文：42%");
		expect(status).toContain("运行：空闲");

		runtime.snapshotValue = { streaming: true };
		const bare = await executeRemoteCommand("/status", createContext(runtime));
		expect(bare).toContain("运行：运行中");
		expect(bare).toContain("模型：未知");
		expect(bare).toContain("上下文：未知");
	});

	it("triggers compaction and session creation through the runtime", async () => {
		const runtime = new FakeRuntime();

		const compacting = await executeRemoteCommand("/compact", createContext(runtime));
		expect(runtime.compactCalls).toBe(1);
		expect(compacting).toContain("已开始压缩上下文");

		const created = await executeRemoteCommand("/new", createContext(runtime));
		expect(runtime.newSessionCalls).toBe(1);
		expect(created).toContain("已新建 Pi 会话");

		runtime.newSessionResult = false;
		const cancelled = await executeRemoteCommand("/new", createContext(runtime));
		expect(cancelled).toContain("新建会话未完成");

		const unavailable = await executeRemoteCommand("/new", createContext());
		expect(unavailable).toContain("远程新建会话暂不可用");
	});

	it("rejects unknown commands with a help hint", async () => {
		const reply = await executeRemoteCommand("/wat is this", createContext());
		expect(reply).toBe("❓ 未知命令：/wat\n\n输入 /help 查看可用命令。");
	});
});
