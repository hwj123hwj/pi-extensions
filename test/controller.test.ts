import { describe, expect, it } from "vitest";
import type {
	AgentBridge,
	CredentialStore,
	FeishuCredentials,
	FeishuGateway,
	FeishuIncomingMessage,
	FeishuReplySnapshot,
} from "../src/contracts.js";
import { FeishuController } from "../src/controller.js";

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
	sent: Array<{ chatId: string; text: string; replyTo?: string }> = [];
	replies: FakeReply[] = [];
	private handler: ((message: FeishuIncomingMessage) => Promise<void> | void) | undefined;

	async connect(handler: (message: FeishuIncomingMessage) => Promise<void> | void): Promise<void> {
		this.connectCalls += 1;
		this.handler = handler;
	}

	async disconnect(): Promise<void> {
		this.disconnectCalls += 1;
		this.handler = undefined;
	}

	async sendText(chatId: string, text: string, replyTo?: string): Promise<void> {
		this.sent.push(replyTo ? { chatId, text, replyTo } : { chatId, text });
	}

	async beginReply(chatId: string, replyTo: string): Promise<FakeReply> {
		const reply = new FakeReply(chatId, replyTo);
		this.replies.push(reply);
		return reply;
	}

	async emit(message: FeishuIncomingMessage): Promise<void> {
		await this.handler?.(message);
	}
}

class FakeReply {
	snapshots: FeishuReplySnapshot[] = [];
	completed = false;
	failed = false;
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

	async fail(): Promise<void> {
		this.failed = true;
	}

	async cancel(): Promise<void> {
		this.cancelled = true;
	}
}

class FakeAgent implements AgentBridge {
	calls: string[] = [];
	cancelCalls = 0;
	runImpl: (text: string) => Promise<string> = async (text) => `Pi: ${text}`;

	run(
		text: string,
		observer?: {
			onText?: (value: string) => void;
			onActivity?: (activity: { kind: string; toolName?: string }) => void;
		},
	): Promise<string> {
		this.calls.push(text);
		observer?.onActivity?.({ kind: "thinking" });
		observer?.onText?.(`Pi: ${text}`);
		return this.runImpl(text);
	}

	cancel(): void {
		this.cancelCalls += 1;
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

function createFixture(initialCredentials: FeishuCredentials | null = null) {
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
});
