import { describe, expect, it } from "vitest";
import type { FeishuIncomingMessage } from "../src/contracts.js";
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
	private messageHandler: ((message: NormalizedChannelMessage) => Promise<void> | void) | undefined;

	onMessage(handler: (message: NormalizedChannelMessage) => Promise<void> | void): () => void {
		this.messageHandler = handler;
		return () => {
			this.messageHandler = undefined;
		};
	}

	async connect(): Promise<void> {
		this.connectCalls += 1;
	}

	async disconnect(): Promise<void> {
		this.disconnectCalls += 1;
	}

	async sendText(to: string, text: string, replyTo?: string): Promise<void> {
		this.sent.push(replyTo ? { to, text, replyTo } : { to, text });
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

	it("validates credentials by completing and closing a WebSocket handshake", async () => {
		const channel = new FakeChannel();
		await validateSdkCredentials({ appId: "cli_test", appSecret: "secret" }, createFactory(channel));
		expect(channel.connectCalls).toBe(1);
		expect(channel.disconnectCalls).toBe(1);
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
