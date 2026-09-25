import { describe, expect, it } from "vitest";
import type { FeishuIncomingMessage, FeishuReactionEvent, FeishuReactionHandler } from "../src/contracts.js";
import {
	buildReplyCard,
	type ChannelCardStream,
	type ChannelFactory,
	type ChannelLike,
	type NormalizedChannelMessage,
	SdkFeishuGateway,
	validateSdkCredentials,
} from "../src/gateway.js";

class FakeChannel implements ChannelLike {
	connectCalls = 0;
	disconnectCalls = 0;
	sent: Array<{ to: string; text: string; replyTo?: string }> = [];
	streamedCards: object[] = [];
	streamFinished = false;
	reactions: Array<{ messageId: string; emojiType: string }> = [];
	removedReactions: Array<{ messageId: string; reactionId: string }> = [];
	recalled: string[] = [];
	edits: Array<{ messageId: string; text: string }> = [];
	reactionEvents: FeishuReactionEvent[] = [];
	chatInfo: Record<string, { name?: string }> = {};
	nextId = 1;
	nextReactionId = "reaction_1";
	failReactions = false;
	private messageHandler: ((message: NormalizedChannelMessage) => Promise<void> | void) | undefined;
	private reactionHandler: FeishuReactionHandler | undefined;
	private botAddedHandler: ((event: { chatId: string; operatorOpenId: string }) => void) | undefined;

	onMessage(handler: (message: NormalizedChannelMessage) => Promise<void> | void): () => void {
		this.messageHandler = handler;
		return () => {
			this.messageHandler = undefined;
		};
	}

	onReaction(handler: FeishuReactionHandler): () => void {
		this.reactionHandler = handler;
		return () => {
			this.reactionHandler = undefined;
		};
	}

	emitReaction(event: FeishuReactionEvent): void {
		this.reactionHandler?.(event);
	}

	async connect(): Promise<void> {
		this.connectCalls += 1;
	}

	async disconnect(): Promise<void> {
		this.disconnectCalls += 1;
	}

	async sendText(to: string, text: string, replyTo?: string): Promise<string | undefined> {
		this.sent.push(replyTo ? { to, text, replyTo } : { to, text });
		return `om_sent_${this.nextId++}`;
	}

	async editText(messageId: string, text: string): Promise<void> {
		this.edits.push({ messageId, text });
	}

	async recallMessage(messageId: string): Promise<void> {
		this.recalled.push(messageId);
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

	async startCardStream(_to: string, card: object, _replyTo?: string): Promise<ChannelCardStream> {
		this.streamedCards.push(card);
		return {
			update: async (next) => {
				this.streamedCards.push(next);
			},
			finish: async () => {
				this.streamFinished = true;
			},
		};
	}

	onBotAdded(handler: (event: { chatId: string; operatorOpenId: string }) => void): () => void {
		this.botAddedHandler = handler;
		return () => {
			this.botAddedHandler = undefined;
		};
	}

	emitBotAdded(event: { chatId: string; operatorOpenId: string }): void {
		this.botAddedHandler?.(event);
	}

	async getChatInfo(chatId: string): Promise<{ name?: string } | undefined> {
		return this.chatInfo[chatId];
	}

	async emit(message: NormalizedChannelMessage): Promise<void> {
		await this.messageHandler?.(message);
	}
}

function createFactory(channel: FakeChannel): ChannelFactory {
	return () => channel;
}

describe("SdkFeishuGateway", () => {
	it("normalizes official Channel messages and sends text replies", async () => {
		const channel = new FakeChannel();
		const gateway = new SdkFeishuGateway({ appId: "cli_test", appSecret: "secret" }, createFactory(channel));
		const received: FeishuIncomingMessage[] = [];

		await gateway.connect((message) => {
			received.push(message);
		});
		await channel.emit({
			messageId: "om_1",
			chatId: "oc_1",
			chatType: "p2p",
			senderId: "ou_owner",
			content: "hello",
			rawContentType: "text",
		});
		await gateway.sendText("oc_1", "Pi response", "om_1");

		expect(received).toEqual([
			{
				messageId: "om_1",
				chatId: "oc_1",
				chatType: "p2p",
				senderOpenId: "ou_owner",
				contentType: "text",
				text: "hello",
			},
		]);
		expect(channel.sent).toEqual([{ to: "oc_1", text: "Pi response", replyTo: "om_1" }]);
		await gateway.disconnect();
		expect(channel.disconnectCalls).toBe(1);
	});

	it("passes group mention metadata through to the controller", async () => {
		const channel = new FakeChannel();
		const gateway = new SdkFeishuGateway({ appId: "cli_test", appSecret: "secret" }, createFactory(channel));
		const received: FeishuIncomingMessage[] = [];

		await gateway.connect((message) => {
			received.push(message);
		});
		await channel.emit({
			messageId: "om_2",
			chatId: "oc_group",
			chatType: "group",
			senderId: "ou_alice",
			content: "帮我看下这个报错",
			rawContentType: "text",
			senderName: "Alice",
			mentionedBot: true,
			mentions: [
				{ key: "@_user_1", openId: "ou_bot", name: "Pi", isBot: true },
				{ key: "@_user_2", openId: "ou_bob", name: "Bob" },
			],
		});

		expect(received).toEqual([
			{
				messageId: "om_2",
				chatId: "oc_group",
				chatType: "group",
				senderOpenId: "ou_alice",
				contentType: "text",
				text: "帮我看下这个报错",
				senderName: "Alice",
				mentionedBot: true,
				mentions: [
					{ key: "@_user_1", openId: "ou_bot", name: "Pi", isBot: true },
					{ key: "@_user_2", openId: "ou_bob", name: "Bob" },
				],
			},
		]);
		await gateway.disconnect();
	});

	it("notifies bot-added subscribers and fetches chat info", async () => {
		const channel = new FakeChannel();
		const gateway = new SdkFeishuGateway({ appId: "cli_test", appSecret: "secret" }, createFactory(channel));
		const added: Array<{ chatId: string; operatorOpenId: string }> = [];
		gateway.onBotAdded((event) => added.push(event));

		await gateway.connect(() => undefined);
		channel.emitBotAdded({ chatId: "oc_new", operatorOpenId: "ou_inviter" });
		channel.chatInfo.oc_new = { name: "项目群" };
		await expect(gateway.getChatInfo("oc_new")).resolves.toEqual({ name: "项目群" });
		await gateway.disconnect();
		channel.emitBotAdded({ chatId: "oc_after", operatorOpenId: "ou_inviter" });

		expect(added).toEqual([{ chatId: "oc_new", operatorOpenId: "ou_inviter" }]);
	});

	it("validates credentials by completing and closing a WebSocket handshake", async () => {
		const channel = new FakeChannel();
		await validateSdkCredentials({ appId: "cli_test", appSecret: "secret" }, createFactory(channel));
		expect(channel.connectCalls).toBe(1);
		expect(channel.disconnectCalls).toBe(1);
	});

	it("delegates emoji reactions and recall to the underlying channel", async () => {
		const channel = new FakeChannel();
		const gateway = new SdkFeishuGateway({ appId: "cli_test", appSecret: "secret" }, createFactory(channel));
		await gateway.connect(() => undefined);

		const sentId = await gateway.sendText("oc_1", "hi");
		const reactionId = await gateway.addReaction("om_1", "THINKING");
		await gateway.removeReaction("om_1", reactionId);
		await gateway.recallMessage("om_sent_1");
		await gateway.editText("om_sent_1", "updated");

		expect(sentId).toBe("om_sent_1");
		expect(reactionId).toBe("reaction_1");
		expect(channel.reactions).toEqual([{ messageId: "om_1", emojiType: "THINKING" }]);
		expect(channel.removedReactions).toEqual([{ messageId: "om_1", reactionId: "reaction_1" }]);
		expect(channel.recalled).toEqual(["om_sent_1"]);
		expect(channel.edits).toEqual([{ messageId: "om_sent_1", text: "updated" }]);
	});

	it("forwards channel reactions to subscribers registered before connect", async () => {
		const channel = new FakeChannel();
		const gateway = new SdkFeishuGateway({ appId: "cli_test", appSecret: "secret" }, createFactory(channel));
		const received: FeishuReactionEvent[] = [];
		gateway.onReaction((event) => received.push(event));

		await gateway.connect(() => undefined);
		channel.emitReaction({
			messageId: "om_1",
			operatorOpenId: "ou_owner",
			emojiType: "CrossMark",
			action: "added",
		});
		await gateway.disconnect();
		channel.emitReaction({ messageId: "om_2", operatorOpenId: "ou_owner", emojiType: "NO", action: "added" });

		expect(received).toEqual([
			{ messageId: "om_1", operatorOpenId: "ou_owner", emojiType: "CrossMark", action: "added" },
		]);
	});

	it("keeps one interactive reply card updated through progress and finalization", async () => {
		const channel = new FakeChannel();
		const gateway = new SdkFeishuGateway({ appId: "cli_test", appSecret: "secret" }, createFactory(channel));
		await gateway.connect(() => undefined);
		const reply = await gateway.beginReply("oc_1", "om_1");
		reply.update({ text: "draft", status: "正在生成回复" });
		await reply.complete({ text: "final", status: "已完成" });

		expect(channel.streamedCards).toEqual([
			buildReplyCard({ text: "", status: "正在思考" }),
			buildReplyCard({ text: "draft", status: "正在生成回复" }),
			buildReplyCard({ text: "final", status: "已完成" }),
		]);
		expect(channel.streamFinished).toBe(true);
	});
});
