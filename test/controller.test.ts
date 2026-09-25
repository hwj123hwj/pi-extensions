import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type {
	AgentBridge,
	CredentialStore,
	FeishuBotAddedEvent,
	FeishuCredentials,
	FeishuGateway,
	FeishuIncomingMessage,
	FeishuReactionEvent,
	FeishuReactionHandler,
	FeishuReplySnapshot,
	PiRuntime,
} from "../src/contracts.js";
import { buildAgentPrompt, FeishuController, resolveAllowTarget } from "../src/controller.js";
import { REQUIRED_APP_SCOPES, SENSITIVE_GROUP_MSG_SCOPE } from "../src/scopes.js";

class MemoryCredentialStore implements CredentialStore {
	state: FeishuCredentials | null = null;

	async load(): Promise<FeishuCredentials | null> {
		return this.state ? { ...this.state } : null;
	}

	async save(credentials: FeishuCredentials): Promise<void> {
		this.state = { ...credentials };
	}

	async clear(): Promise<void> {
		this.state = null;
	}
}

class FakeGateway implements FeishuGateway {
	connectCalls = 0;
	disconnectCalls = 0;
	sent: Array<{ chatId: string; text: string; messageId: string; replyTo?: string }> = [];
	replies: FakeReply[] = [];
	reactions: Array<{ messageId: string; emojiType: string }> = [];
	removedReactions: Array<{ messageId: string; reactionId: string }> = [];
	recalled: string[] = [];
	edits: Array<{ messageId: string; text: string }> = [];
	nextId = 1;
	nextReactionId = "reaction_1";
	failReactions = false;
	grantedScopes: string[] | undefined = [];
	probeCalls = 0;
	chatInfo: Record<string, { name?: string }> = {};
	private handler: ((message: FeishuIncomingMessage) => Promise<void> | void) | undefined;
	private reactionHandler: FeishuReactionHandler | undefined;
	private botAddedHandler: ((event: FeishuBotAddedEvent) => void) | undefined;

	async connect(handler: (message: FeishuIncomingMessage) => Promise<void> | void): Promise<void> {
		this.connectCalls += 1;
		this.handler = handler;
	}

	async createGroupChat(name: string, ownerOpenId: string): Promise<string> {
		return `oc_${name}_${ownerOpenId}`;
	}

	async probeGrantedScopes(): Promise<{ grantedScopes?: string[] }> {
		this.probeCalls += 1;
		return this.grantedScopes ? { grantedScopes: this.grantedScopes } : {};
	}

	async disconnect(): Promise<void> {
		this.disconnectCalls += 1;
		this.handler = undefined;
	}

	onReaction(handler: FeishuReactionHandler): () => void {
		this.reactionHandler = handler;
		return () => {
			this.reactionHandler = undefined;
		};
	}

	onBotAdded(handler: (event: FeishuBotAddedEvent) => void): () => void {
		this.botAddedHandler = handler;
		return () => {
			this.botAddedHandler = undefined;
		};
	}

	emitBotAdded(event: FeishuBotAddedEvent): void {
		this.botAddedHandler?.(event);
	}

	async getChatInfo(chatId: string): Promise<{ name?: string } | undefined> {
		return this.chatInfo[chatId];
	}

	emitReaction(event: FeishuReactionEvent): void {
		this.reactionHandler?.(event);
	}

	async sendText(chatId: string, text: string, replyTo?: string): Promise<string | undefined> {
		const messageId = `om_sent_${this.nextId++}`;
		this.sent.push({ chatId, text, messageId, ...(replyTo ? { replyTo } : {}) });
		return messageId;
	}

	async beginReply(chatId: string, replyTo: string): Promise<FakeReply> {
		const reply = new FakeReply(chatId, replyTo);
		this.replies.push(reply);
		return reply;
	}

	async addReaction(messageId: string, emojiType: string): Promise<string> {
		if (this.failReactions) throw new Error("reaction permission missing");
		this.reactions.push({ messageId, emojiType });
		const reactionId = this.nextReactionId;
		const sequence = Number(reactionId.slice("reaction_".length)) || 1;
		this.nextReactionId = `reaction_${sequence + 1}`;
		return reactionId;
	}

	async removeReaction(messageId: string, reactionId: string): Promise<void> {
		this.removedReactions.push({ messageId, reactionId });
	}

	async recallMessage(messageId: string): Promise<void> {
		this.recalled.push(messageId);
	}

	async editText(messageId: string, text: string): Promise<void> {
		this.edits.push({ messageId, text });
	}

	async emit(message: FeishuIncomingMessage): Promise<void> {
		await this.handler?.(message);
	}
}

class FakeReply {
	snapshots: FeishuReplySnapshot[] = [];
	completed = false;
	failed = false;
	failReason: string | undefined;
	cancelled = false;

	constructor(
		readonly chatId: string,
		readonly replyTo: string,
	) {}

	update(snapshot: FeishuReplySnapshot): void {
		this.snapshots.push(snapshot);
	}

	async complete(snapshot: FeishuReplySnapshot): Promise<void> {
		this.snapshots.push(snapshot);
		this.completed = true;
	}

	async fail(reason?: string): Promise<void> {
		this.failed = true;
		this.failReason = reason;
	}

	async cancel(): Promise<void> {
		this.cancelled = true;
	}
}

class FakeAgent implements AgentBridge {
	calls: string[] = [];
	runOptions: Array<{ chatId?: string } | undefined> = [];
	cancelCalls = 0;
	runImpl: (text: string) => Promise<string> = async (text) => `Pi: ${text}`;

	run(
		text: string,
		observer?: {
			onText?: (value: string) => void;
			onActivity?: (activity: { kind: string; toolName?: string }) => void;
		},
		options?: { chatId?: string },
	): Promise<string> {
		this.calls.push(text);
		this.runOptions.push(options);
		observer?.onActivity?.({ kind: "thinking" });
		observer?.onText?.(`Pi: ${text}`);
		return this.runImpl(text);
	}

	cancel(): void {
		this.cancelCalls += 1;
	}
}

class FakeRuntime implements PiRuntime {
	idle = true;
	abortCalls = 0;
	compactCalls = 0;
	newSessionResult = true;
	newSessionCalls = 0;
	setThinkingLevelResult = true;
	setThinkingLevelCalls: string[] = [];
	models = [{ id: "model-a", name: "Model A", provider: "test" }];
	switchModelImpl = async (query: string) => {
		const model = this.models.find((entry) => entry.id === query);
		if (!model) throw new Error(`未找到匹配“${query}”的模型。`);
		return model;
	};
	snapshotValue = { streaming: false, model: "Test Model", thinkingLevel: "medium", contextPercent: 42.4 };

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

	snapshot() {
		return this.snapshotValue;
	}
}

function privateText(overrides: Partial<FeishuIncomingMessage> = {}): FeishuIncomingMessage {
	return {
		messageId: "om_1",
		chatId: "oc_private",
		chatType: "p2p",
		senderOpenId: "ou_owner",
		contentType: "text",
		text: "hello",
		...overrides,
	};
}

function sentIdFor(gateway: FakeGateway, replyTo: string): string {
	const entry = gateway.sent.find((item) => item.replyTo === replyTo);
	if (!entry) throw new Error(`no sent message replies to ${replyTo}`);
	return entry.messageId;
}

function sentTo(gateway: FakeGateway, chatId: string): Array<{ text: string }> {
	return gateway.sent.filter((entry) => entry.chatId === chatId);
}

function createFixture(
	initialCredentials: FeishuCredentials | null = null,
	runtime?: PiRuntime,
	deduplicationPath: string = join(tmpdir(), `pi-feishu-test-${randomUUID()}.json`),
) {
	const store = new MemoryCredentialStore();
	store.state = initialCredentials;
	const gateway = new FakeGateway();
	const agent = new FakeAgent();
	const controller = new FeishuController({
		store,
		gatewayFactory: () => gateway,
		validateCredentials: async () => undefined,
		agent,
		generateBindingCode: () => "123456",
		// 每个用例独立的去重落盘文件，既隔离用例，也让持久化行为可测。
		deduplicationPath,
		...(runtime ? { runtime } : {}),
	});
	return { store, gateway, agent, controller };
}

describe("FeishuController", () => {
	it("validates setup parameters and preserves an Owner only for the same app", async () => {
		const { store, controller } = createFixture({
			appId: "cli_old",
			appSecret: "old-secret",
			ownerOpenId: "ou_owner",
		});

		await controller.setup("cli_old new-secret", {});
		expect(store.state).toEqual({
			appId: "cli_old",
			appSecret: "new-secret",
			ownerOpenId: "ou_owner",
		});

		await controller.setup("cli_new another-secret", {});
		expect(store.state).toEqual({
			appId: "cli_new",
			appSecret: "another-secret",
		});
	});

	it("starts idempotently and disconnects on stop", async () => {
		const { gateway, controller } = createFixture({
			appId: "cli_test",
			appSecret: "secret",
		});

		const first = await controller.start({});
		const second = await controller.start({});

		expect(first.bindingCode).toBe("123456");
		expect(second.alreadyRunning).toBe(true);
		expect(gateway.connectCalls).toBe(1);

		await controller.stop();
		expect(gateway.disconnectCalls).toBe(1);
	});

	it("creates a group for the bound Owner and processes only groups it manages", async () => {
		const { store, gateway, agent, controller } = createFixture({
			appId: "cli_test",
			appSecret: "secret",
			ownerOpenId: "ou_owner",
		});
		await controller.start({});

		const chatId = await controller.createGroupChat("Project");
		expect(chatId).toBe("oc_Project_ou_owner");
		expect(store.state?.managedGroupIds).toEqual([chatId]);
		expect(gateway.sent.at(-2)?.chatId).toBe(chatId);
		expect(gateway.sent.at(-2)?.text).toContain("@机器人");
		expect(gateway.sent.at(-1)).toMatchObject({ chatId: "ou_owner" });
		expect(gateway.sent.at(-1)?.text).toContain("免 @ 权限");

		await gateway.emit(privateText({ messageId: "om_group", chatId, chatType: "group", text: "@bot hello" }));
		await controller.waitForIdle();
		expect(agent.calls).toEqual([`[飞书群聊] ou_owner：@bot hello`]);
		expect(agent.runOptions).toEqual([{ chatId }]);

		await gateway.emit(privateText({ messageId: "om_other_group", chatId: "oc_unmanaged", chatType: "group" }));
		await controller.waitForIdle();
		expect(agent.calls).toHaveLength(1);
	});

	it("binds one Owner, rejects other users, and ignores group or non-text messages", async () => {
		const { store, gateway, agent, controller } = createFixture({
			appId: "cli_test",
			appSecret: "secret",
		});
		await controller.start({});

		await gateway.emit(privateText({ text: "/bind 123456" }));
		expect(store.state?.ownerOpenId).toBe("ou_owner");
		expect(gateway.sent.at(-1)?.text).toContain("绑定成功");

		await gateway.emit(privateText({ messageId: "om_2", senderOpenId: "ou_other", text: "hello" }));
		expect(gateway.sent.at(-1)?.text).toContain("未授权");

		await gateway.emit(privateText({ messageId: "om_3", chatType: "group" }));
		await gateway.emit(privateText({ messageId: "om_4", contentType: "image" }));
		await controller.waitForIdle();
		expect(agent.calls).toEqual([]);
	});

	it("deduplicates message IDs and sends the Pi response back to the originating private chat", async () => {
		const { gateway, agent, controller } = createFixture({
			appId: "cli_test",
			appSecret: "secret",
			ownerOpenId: "ou_owner",
		});
		await controller.start({});

		await gateway.emit(privateText());
		await gateway.emit(privateText());
		await controller.waitForIdle();

		expect(agent.calls).toEqual(["hello"]);
		expect(gateway.replies).toHaveLength(1);
		expect(gateway.replies[0]).toMatchObject({ chatId: "oc_private", replyTo: "om_1", completed: true });
		expect(gateway.replies[0]?.snapshots).toContainEqual({ text: "Pi: hello", status: "已完成" });
	});

	it("streams safe Pi progress into one reply card and finalizes the card", async () => {
		const { gateway, agent, controller } = createFixture({
			appId: "cli_test",
			appSecret: "secret",
			ownerOpenId: "ou_owner",
		});
		await controller.start({});
		await gateway.emit(privateText({ text: "show progress" }));
		await controller.waitForIdle();

		const reply = gateway.replies[0];
		expect(reply?.snapshots).toContainEqual({ text: "", status: "正在思考" });
		expect(reply?.snapshots).toContainEqual({ text: "Pi: show progress", status: "正在生成回复" });
		expect(reply?.snapshots).toContainEqual({ text: "Pi: show progress", status: "已完成" });
		expect(reply?.completed).toBe(true);
		expect(agent.calls).toEqual(["show progress"]);
	});

	it("finalizes the active reply as cancelled before closing the Feishu connection", async () => {
		const { gateway, agent, controller } = createFixture({
			appId: "cli_test",
			appSecret: "secret",
			ownerOpenId: "ou_owner",
		});
		let rejectRun: ((reason?: unknown) => void) | undefined;
		agent.runImpl = () =>
			new Promise<string>((_resolve, reject) => {
				rejectRun = reject;
			});
		await controller.start({});
		await gateway.emit(privateText({ text: "long task" }));
		await Promise.resolve();
		await controller.stop();
		rejectRun?.(new Error("cancelled"));
		await controller.waitForIdle();

		expect(gateway.replies[0]?.cancelled).toBe(true);
	});

	it("serializes queued messages and continues after an Agent failure", async () => {
		const { gateway, agent, controller } = createFixture({
			appId: "cli_test",
			appSecret: "secret",
			ownerOpenId: "ou_owner",
		});
		const releases: Array<() => void> = [];
		agent.runImpl = (text) =>
			new Promise<string>((resolve, reject) => {
				releases.push(() => {
					if (text === "first") reject(new Error("secret should not escape"));
					else resolve(`done: ${text}`);
				});
			});
		await controller.start({});

		await gateway.emit(privateText({ messageId: "om_first", text: "first" }));
		await gateway.emit(privateText({ messageId: "om_second", text: "second" }));
		expect(agent.calls).toEqual(["first"]);

		releases[0]?.();
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(agent.calls).toEqual(["first", "second"]);
		releases[1]?.();
		await controller.waitForIdle();

		expect(gateway.replies[0]?.failed).toBe(true);
		expect(gateway.replies[1]?.snapshots).toContainEqual({ text: "done: second", status: "已完成" });
		expect(gateway.sent.some((message) => message.text.includes("secret should not escape"))).toBe(false);
	});

	it("clears credentials and cancels pending Agent work on logout", async () => {
		const { store, gateway, agent, controller } = createFixture({
			appId: "cli_test",
			appSecret: "secret",
			ownerOpenId: "ou_owner",
		});
		await controller.start({});
		await controller.logout();

		expect(store.state).toBeNull();
		expect(gateway.disconnectCalls).toBe(1);
		expect(agent.cancelCalls).toBe(1);
	});

	it("acknowledges each message with a read reaction and clears it after the reply", async () => {
		const { gateway, controller } = createFixture({
			appId: "cli_test",
			appSecret: "secret",
			ownerOpenId: "ou_owner",
		});
		await controller.start({});

		await gateway.emit(privateText({ messageId: "om_1", text: "hello" }));
		await controller.waitForIdle();
		await gateway.emit(privateText({ messageId: "om_2", text: "/status" }));

		expect(gateway.reactions).toEqual([
			{ messageId: "om_1", emojiType: "THINKING" },
			{ messageId: "om_2", emojiType: "THINKING" },
		]);
		expect(gateway.removedReactions).toEqual([
			{ messageId: "om_1", reactionId: "reaction_1" },
			{ messageId: "om_2", reactionId: "reaction_2" },
		]);
	});

	it("keeps processing messages when the reaction API is unavailable", async () => {
		const { gateway, agent, controller } = createFixture({
			appId: "cli_test",
			appSecret: "secret",
			ownerOpenId: "ou_owner",
		});
		gateway.failReactions = true;
		await controller.start({});

		await gateway.emit(privateText({ text: "hello" }));
		await controller.waitForIdle();

		expect(gateway.reactions).toEqual([]);
		expect(gateway.removedReactions).toEqual([]);
		expect(agent.calls).toEqual(["hello"]);
		expect(gateway.replies[0]?.completed).toBe(true);
	});

	it("answers remote slash commands without invoking the agent", async () => {
		const { gateway, agent, controller } = createFixture({
			appId: "cli_test",
			appSecret: "secret",
			ownerOpenId: "ou_owner",
		});
		await controller.start({});

		await gateway.emit(privateText({ messageId: "om_help", text: "/help" }));
		await gateway.emit(privateText({ messageId: "om_status", text: "/status" }));
		await gateway.emit(privateText({ messageId: "om_unknown", text: "/definitely-not-a-command" }));

		expect(agent.calls).toEqual([]);
		// 启动欢迎语也走 sendText，先按聊天过滤再断言命令回复。
		const commandReplies = gateway.sent.filter((entry) => entry.chatId === "oc_private");
		expect(commandReplies.map((entry) => entry.chatId)).toEqual(["oc_private", "oc_private", "oc_private"]);
		expect(commandReplies[0]?.text).toContain("/stop");
		expect(commandReplies[0]?.text).toContain("其余消息会直接发送给当前 Pi 会话处理");
		expect(commandReplies[1]?.text).toContain("队列：0");
		expect(commandReplies[1]?.text).toContain("模型：未知");
		expect(commandReplies[2]?.text).toContain("❓ 未知命令：/definitely-not-a-command");
		expect(gateway.replies).toEqual([]);
	});

	it("runs slash commands through the runtime while a long task keeps the queue busy", async () => {
		const runtime = new FakeRuntime();
		runtime.idle = false;
		runtime.snapshotValue = { streaming: true, model: "Test Model", thinkingLevel: "medium", contextPercent: 42.4 };
		const { gateway, agent, controller } = createFixture(
			{
				appId: "cli_test",
				appSecret: "secret",
				ownerOpenId: "ou_owner",
			},
			runtime,
		);
		const releases: Array<() => void> = [];
		agent.runImpl = () =>
			new Promise<string>((resolve) => {
				releases.push(() => resolve("done"));
			});
		await controller.start({});

		await gateway.emit(privateText({ messageId: "om_first", text: "long task" }));
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(agent.calls).toEqual(["long task"]);

		await gateway.emit(privateText({ messageId: "om_stop", text: "/stop" }));
		await gateway.emit(privateText({ messageId: "om_status", text: "/status" }));

		expect(runtime.abortCalls).toBe(1);
		expect(gateway.sent.at(-2)?.text).toContain("已发送中止信号");
		expect(gateway.sent.at(-1)?.text).toContain("运行：运行中");
		expect(gateway.sent.at(-1)?.text).toContain("上下文：42%");
		expect(agent.calls).toEqual(["long task"]);

		releases[0]?.();
		await controller.waitForIdle();
	});

	it("creates a new Pi session on request and reports graceful failures", async () => {
		const runtime = new FakeRuntime();
		const { gateway, agent, controller } = createFixture(
			{
				appId: "cli_test",
				appSecret: "secret",
				ownerOpenId: "ou_owner",
			},
			runtime,
		);
		await controller.start({});

		await gateway.emit(privateText({ messageId: "om_new", text: "/new" }));
		expect(runtime.newSessionCalls).toBe(1);
		expect(gateway.sent.at(-1)?.text).toContain("已新建 Pi 会话");

		runtime.newSessionResult = false;
		await gateway.emit(privateText({ messageId: "om_new2", text: "/new" }));
		expect(gateway.sent.at(-1)?.text).toContain("新建会话未完成");
		expect(agent.calls).toEqual([]);
	});

	it("sends a queue-position tip for later messages and recalls it when their turn starts", async () => {
		const { gateway, agent, controller } = createFixture({
			appId: "cli_test",
			appSecret: "secret",
			ownerOpenId: "ou_owner",
		});
		const releases: Array<() => void> = [];
		agent.runImpl = (text) =>
			new Promise<string>((resolve) => {
				releases.push(() => resolve(`done: ${text}`));
			});
		await controller.start({});

		await gateway.emit(privateText({ messageId: "om_first", text: "first" }));
		await new Promise((resolve) => setTimeout(resolve, 0));
		await gateway.emit(privateText({ messageId: "om_second", text: "second" }));

		const tip = gateway.sent.at(-1);
		expect(tip?.text).toContain("排队中（第 2 位）");
		expect(tip?.replyTo).toBe("om_second");

		releases[0]?.();
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(gateway.recalled).toContain(sentIdFor(gateway, "om_second"));

		releases[1]?.();
		await controller.waitForIdle();
		expect(gateway.replies[1]?.snapshots).toContainEqual({ text: "done: second", status: "已完成" });
	});

	it("stops the running task and skips queued messages on /stop", async () => {
		const runtime = new FakeRuntime();
		runtime.idle = false;
		const { gateway, agent, controller } = createFixture(
			{
				appId: "cli_test",
				appSecret: "secret",
				ownerOpenId: "ou_owner",
			},
			runtime,
		);
		const releases: Array<() => void> = [];
		agent.runImpl = (text) =>
			new Promise<string>((resolve) => {
				releases.push(() => resolve(`done: ${text}`));
			});
		await controller.start({});

		await gateway.emit(privateText({ messageId: "om_first", text: "first" }));
		await new Promise((resolve) => setTimeout(resolve, 0));
		await gateway.emit(privateText({ messageId: "om_second", text: "second" }));
		await gateway.emit(privateText({ messageId: "om_third", text: "third" }));
		await gateway.emit(privateText({ messageId: "om_stop", text: "/stop" }));

		expect(runtime.abortCalls).toBe(1);
		expect(gateway.sent.at(-1)?.text).toContain("跳过队列中的 2 条消息");

		releases[0]?.();
		await controller.waitForIdle();
		expect(agent.calls).toEqual(["first"]);
		const cleared = gateway.removedReactions.map((entry) => entry.messageId);
		expect(cleared).toContain("om_second");
		expect(cleared).toContain("om_third");
		expect(gateway.recalled).toContain(sentIdFor(gateway, "om_second"));
		expect(gateway.recalled).toContain(sentIdFor(gateway, "om_third"));
	});

	it("renumbers remaining queue tips when an earlier task finishes", async () => {
		const { gateway, agent, controller } = createFixture({
			appId: "cli_test",
			appSecret: "secret",
			ownerOpenId: "ou_owner",
		});
		const releases: Array<() => void> = [];
		agent.runImpl = (text) =>
			new Promise<string>((resolve) => {
				releases.push(() => resolve(`done: ${text}`));
			});
		await controller.start({});

		await gateway.emit(privateText({ messageId: "om_first", text: "first" }));
		await new Promise((resolve) => setTimeout(resolve, 0));
		await gateway.emit(privateText({ messageId: "om_second", text: "second" }));
		await gateway.emit(privateText({ messageId: "om_third", text: "third" }));

		expect(gateway.sent.at(-2)?.text).toContain("第 2 位");
		expect(gateway.sent.at(-1)?.text).toContain("第 3 位");

		releases[0]?.();
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(gateway.recalled).toContain(sentIdFor(gateway, "om_second"));
		expect(gateway.edits).toContainEqual({
			messageId: sentIdFor(gateway, "om_third"),
			text: expect.stringContaining("第 2 位"),
		});

		releases[1]?.();
		await new Promise((resolve) => setTimeout(resolve, 0));
		releases[2]?.();
		await controller.waitForIdle();
		expect(agent.calls).toEqual(["first", "second", "third"]);
	});

	it("cancels a queued message when the owner reacts with a cross mark", async () => {
		const { gateway, agent, controller } = createFixture({
			appId: "cli_test",
			appSecret: "secret",
			ownerOpenId: "ou_owner",
		});
		const releases: Array<() => void> = [];
		agent.runImpl = (text) =>
			new Promise<string>((resolve) => {
				releases.push(() => resolve(`done: ${text}`));
			});
		await controller.start({});

		await gateway.emit(privateText({ messageId: "om_first", text: "first" }));
		await new Promise((resolve) => setTimeout(resolve, 0));
		await gateway.emit(privateText({ messageId: "om_second", text: "second" }));
		await gateway.emit(privateText({ messageId: "om_third", text: "third" }));

		// 非本人、非取消表情都不触发
		gateway.emitReaction({
			messageId: "om_third",
			operatorOpenId: "ou_other",
			emojiType: "CrossMark",
			action: "added",
		});
		gateway.emitReaction({ messageId: "om_third", operatorOpenId: "ou_owner", emojiType: "THINKING", action: "added" });
		expect(gateway.recalled).not.toContain(sentIdFor(gateway, "om_second"));

		gateway.emitReaction({
			messageId: "om_second",
			operatorOpenId: "ou_owner",
			emojiType: "CrossMark",
			action: "added",
		});

		expect(gateway.recalled).toContain(sentIdFor(gateway, "om_second"));
		const cleared = gateway.removedReactions.map((entry) => entry.messageId);
		expect(cleared).toContain("om_second");
		expect(gateway.edits).toContainEqual({
			messageId: sentIdFor(gateway, "om_third"),
			text: expect.stringContaining("第 2 位"),
		});

		releases[0]?.();
		await new Promise((resolve) => setTimeout(resolve, 0));
		releases[1]?.();
		await controller.waitForIdle();
		expect(agent.calls).toEqual(["first", "third"]);
	});

	it("guides in unmanaged groups instead of staying silent, only when mentioned", async () => {
		const { gateway, agent, controller } = createFixture({
			appId: "cli_test",
			appSecret: "secret",
			ownerOpenId: "ou_owner",
		});
		await controller.start({});

		// 未被 @ 的陌生群消息：完全静默（启动欢迎语发给 Owner，不计入群聊断言）
		await gateway.emit(privateText({ messageId: "om_g1", chatId: "oc_free", chatType: "group", text: "普通闲聊" }));
		expect(sentTo(gateway, "oc_free")).toEqual([]);
		expect(agent.calls).toEqual([]);

		// 非 Owner 被 @：明确拒绝
		await gateway.emit(
			privateText({
				messageId: "om_g2",
				chatId: "oc_free",
				chatType: "group",
				senderOpenId: "ou_stranger",
				text: "在吗",
				mentionedBot: true,
			}),
		);
		expect(gateway.sent.at(-1)?.chatId).toBe("oc_free");
		expect(gateway.sent.at(-1)?.text).toContain("未授权");
		expect(gateway.sent.at(-1)?.text).toContain("/allow");

		// Owner 被 @：给出 /bind 绑定引导
		await gateway.emit(
			privateText({ messageId: "om_g3", chatId: "oc_free", chatType: "group", text: "@bot 你好", mentionedBot: true }),
		);
		expect(gateway.sent.at(-1)?.text).toContain("/bind");
		expect(agent.calls).toEqual([]);
	});

	it("stays silent in unmanaged groups when the bot has no Owner yet", async () => {
		const { gateway, agent, controller } = createFixture({
			appId: "cli_test",
			appSecret: "secret",
		});
		await controller.start({});

		await gateway.emit(
			privateText({ messageId: "om_g1", chatId: "oc_free", chatType: "group", text: "@bot hi", mentionedBot: true }),
		);
		expect(gateway.sent).toEqual([]);
		expect(agent.calls).toEqual([]);
	});

	it("binds an existing group via /bind from the Owner", async () => {
		const { store, gateway, agent, controller } = createFixture({
			appId: "cli_test",
			appSecret: "secret",
			ownerOpenId: "ou_owner",
		});
		await controller.start({});

		await gateway.emit(privateText({ messageId: "om_bind", chatId: "oc_free", chatType: "group", text: "/bind" }));
		expect(store.state?.managedGroupIds).toContain("oc_free");
		expect(gateway.sent.at(-1)?.text).toContain("✅ 本群已绑定");

		// 绑定后 Owner 的群消息进入独立群会话
		await gateway.emit(
			privateText({
				messageId: "om_msg",
				chatId: "oc_free",
				chatType: "group",
				text: "@bot 看下这个报错",
				mentionedBot: true,
			}),
		);
		await controller.waitForIdle();
		expect(agent.calls).toEqual(["[飞书群聊] ou_owner：@bot 看下这个报错"]);
		expect(agent.runOptions).toEqual([{ chatId: "oc_free" }]);

		// 重复 /bind 幂等
		await gateway.emit(privateText({ messageId: "om_bind2", chatId: "oc_free", chatType: "group", text: "/bind" }));
		expect(gateway.sent.at(-1)?.text).toContain("已绑定");
		expect(store.state?.managedGroupIds).toEqual(["oc_free"]);
	});

	it("rejects /bind from non-owners and binding codes inside groups", async () => {
		const { gateway, agent, controller } = createFixture({
			appId: "cli_test",
			appSecret: "secret",
			ownerOpenId: "ou_owner",
		});
		await controller.start({});

		await gateway.emit(
			privateText({
				messageId: "om_bind",
				chatId: "oc_free",
				chatType: "group",
				senderOpenId: "ou_stranger",
				text: "/bind",
				mentionedBot: true,
			}),
		);
		expect(gateway.sent.at(-1)?.text).toContain("仅 Owner 可用");

		// 群内出现绑定码：拒绝执行，防止群成员目击后劫持 Owner
		await gateway.emit(
			privateText({
				messageId: "om_code",
				chatId: "oc_free",
				chatType: "group",
				senderOpenId: "ou_owner",
				text: "/bind 123456",
			}),
		);
		expect(gateway.sent.at(-1)?.text).toContain("只能在私聊中使用");

		// 私聊 /bind（无参数）给出用途说明
		await gateway.emit(privateText({ messageId: "om_p2p", text: "/bind" }));
		expect(gateway.sent.at(-1)?.text).toContain("请在需要使用的群里");

		// 群绑定命令没有生效
		expect(agent.calls).toEqual([]);
	});

	it("manages an allowlist and lets allowed members drive the bot", async () => {
		const { store, gateway, agent, controller } = createFixture({
			appId: "cli_test",
			appSecret: "secret",
			ownerOpenId: "ou_owner",
		});
		await controller.start({});

		// Owner 通过 @ 成员授权
		await gateway.emit(
			privateText({
				messageId: "om_allow",
				text: "/allow @Bob",
				mentions: [{ key: "@_user_1", openId: "ou_bob", name: "Bob" }],
			}),
		);
		expect(store.state?.allowlist).toEqual(["ou_bob"]);
		expect(store.state?.allowlistNames).toEqual({ ou_bob: "Bob" });
		expect(gateway.sent.at(-1)?.text).toContain("已授权 Bob");

		// 被授权成员私聊直接使用
		await gateway.emit(privateText({ messageId: "om_bob", senderOpenId: "ou_bob", text: "hello from bob" }));
		await controller.waitForIdle();
		expect(agent.calls).toEqual(["hello from bob"]);

		// 未被 @ 的非授权成员群消息静默
		await gateway.emit(
			privateText({
				messageId: "om_stranger",
				chatId: "oc_free",
				chatType: "group",
				senderOpenId: "ou_stranger",
				text: "闲聊",
			}),
		);
		expect(agent.calls).toEqual(["hello from bob"]);

		// 查看列表
		await gateway.emit(privateText({ messageId: "om_list", text: "/allowlist" }));
		expect(gateway.sent.at(-1)?.text).toContain("Bob（ou_bob）");

		// 移除授权后再发消息被拒
		await gateway.emit(
			privateText({
				messageId: "om_deny",
				text: "/deny @Bob",
				mentions: [{ key: "@_user_1", openId: "ou_bob", name: "Bob" }],
			}),
		);
		expect(gateway.sent.at(-1)?.text).toContain("已移除授权");
		await gateway.emit(privateText({ messageId: "om_bob2", senderOpenId: "ou_bob", text: "hello again" }));
		expect(gateway.sent.at(-1)?.text).toContain("未授权");
		expect(agent.calls).toEqual(["hello from bob"]);
	});

	it("keeps allowlist management Owner-only for authorized members", async () => {
		const { gateway, agent, controller } = createFixture({
			appId: "cli_test",
			appSecret: "secret",
			ownerOpenId: "ou_owner",
		});
		await controller.start({});

		// 先把该成员加入授权列表：TA 能用机器人，但不能管理授权。
		await gateway.emit(
			privateText({
				messageId: "om_owner_allow",
				text: "/allow @Stranger",
				mentions: [{ key: "@_user_1", openId: "ou_stranger", name: "Stranger" }],
			}),
		);
		await gateway.emit(
			privateText({
				messageId: "om_allow",
				senderOpenId: "ou_stranger",
				text: "/allow @Bob",
				mentions: [{ key: "@_user_1", openId: "ou_bob", name: "Bob" }],
			}),
		);
		expect(gateway.sent.at(-1)?.text).toContain("仅 Owner 可用");
		expect(agent.calls).toEqual([]);
	});

	it("propagates the sanitized failure reason into the reply card", async () => {
		const { gateway, agent, controller } = createFixture({
			appId: "cli_test",
			appSecret: "secret",
			ownerOpenId: "ou_owner",
		});
		agent.runImpl = async () => {
			throw new Error("Pi 会话控制尚未就绪，请先在本地执行一次 /feishu status。");
		};
		await controller.start({});

		await gateway.emit(privateText({ messageId: "om_fail", text: "hello" }));
		await controller.waitForIdle();

		expect(gateway.replies[0]?.failed).toBe(true);
		expect(gateway.replies[0]?.failReason).toContain("Pi 会话控制尚未就绪");
	});

	it("greets the Owner privately when the bot is added to an unmanaged group", async () => {
		const { gateway, agent, controller } = createFixture({
			appId: "cli_test",
			appSecret: "secret",
			ownerOpenId: "ou_owner",
		});
		await controller.start({});
		gateway.chatInfo.oc_new = { name: "新项目群" };
		gateway.grantedScopes = ["im:message.p2p_msg:readonly", "im:message:send_as_bot"];

		gateway.emitBotAdded({ chatId: "oc_new", operatorOpenId: "ou_owner" });
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(gateway.sent.at(-1)?.chatId).toBe("ou_owner");
		expect(gateway.sent.at(-1)?.text).toContain("新项目群");
		expect(gateway.sent.at(-1)?.text).toContain("/bind");
		expect(gateway.sent.at(-1)?.text).toContain("im:message.group_at_msg:readonly");
		expect(agent.calls).toEqual([]);
	});

	it("keeps deduplication across controller restarts via the persisted receipt file", async () => {
		const deduplicationPath = join(tmpdir(), `pi-feishu-test-${randomUUID()}.json`);
		const { gateway, agent, controller } = createFixture(
			{
				appId: "cli_test",
				appSecret: "secret",
				ownerOpenId: "ou_owner",
			},
			undefined,
			deduplicationPath,
		);
		await controller.start({});
		await gateway.emit(privateText({ messageId: "om_once", text: "hello" }));
		await controller.waitForIdle();
		expect(agent.calls).toEqual(["hello"]);
		await controller.stop();

		// 新实例（模拟 Pi 重启）恢复落盘的受理记录：同一条消息不再重复执行。
		const restartedAgent = new FakeAgent();
		const restartedGateway = new FakeGateway();
		const restarted = new FeishuController({
			store: {
				load: async () => ({ appId: "cli_test", appSecret: "secret", ownerOpenId: "ou_owner" }),
				save: async () => undefined,
				clear: async () => undefined,
			},
			gatewayFactory: () => restartedGateway,
			validateCredentials: async () => undefined,
			agent: restartedAgent,
			deduplicationPath,
		});
		await restarted.start({});
		await restartedGateway.emit(privateText({ messageId: "om_once", text: "hello" }));
		await restarted.waitForIdle();
		expect(restartedAgent.calls).toEqual([]);
		await restarted.stop();
	});

	it("builds group prompts with the sender context and leaves private prompts untouched", () => {
		expect(
			buildAgentPrompt(
				privateText({ chatType: "group", senderOpenId: "ou_alice", senderName: "Alice", text: "帮我看下" }),
				"帮我看下",
			),
		).toBe("[飞书群聊] Alice：帮我看下");
		expect(
			buildAgentPrompt(privateText({ chatType: "group", senderOpenId: "ou_alice", text: "帮我看下" }), "帮我看下"),
		).toBe("[飞书群聊] ou_alice：帮我看下");
		expect(buildAgentPrompt(privateText({ text: "帮我看下" }), "帮我看下")).toBe("帮我看下");
	});

	it("resolves allow targets from mentions first and raw open ids second", () => {
		expect(resolveAllowTarget("@Bob", [{ key: "@_user_1", openId: "ou_bob", name: "Bob" }])).toEqual({
			openId: "ou_bob",
			name: "Bob",
		});
		expect(resolveAllowTarget("ou_bob", undefined)).toEqual({ openId: "ou_bob" });
		expect(resolveAllowTarget("@Bob", undefined)).toBeUndefined();
		expect(resolveAllowTarget("", undefined)).toBeUndefined();
	});

	it("dms a startup welcome with scope health to the bound Owner on start", async () => {
		const { gateway, controller } = createFixture({
			appId: "cli_test",
			appSecret: "secret",
			ownerOpenId: "ou_owner",
		});
		gateway.grantedScopes = [...REQUIRED_APP_SCOPES, SENSITIVE_GROUP_MSG_SCOPE];
		await controller.start({});
		await new Promise((resolve) => setTimeout(resolve, 0));

		const welcome = gateway.sent.find((entry) => entry.chatId === "ou_owner");
		expect(welcome?.text).toContain("Pi 飞书 Bot 已上线");
		expect(welcome?.text).toContain("主会话工作目录");
		expect(welcome?.text).toContain("✅ 应用权限配置完整");
	});

	it("skips the startup welcome when no Owner is bound yet", async () => {
		const { gateway, controller } = createFixture({
			appId: "cli_test",
			appSecret: "secret",
		});
		await controller.start({});
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(gateway.sent).toEqual([]);
	});
});
