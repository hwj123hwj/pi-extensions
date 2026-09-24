import { createLarkChannel, type LarkChannel, LoggerLevel, type NormalizedMessage } from "@larksuiteoapi/node-sdk";
import type {
	FeishuCredentials,
	FeishuGateway,
	FeishuMessageHandler,
	FeishuReactionHandler,
	FeishuReply,
	FeishuReplySnapshot,
} from "./contracts.js";

export interface NormalizedChannelMessage {
	messageId: string;
	chatId: string;
	chatType: "p2p" | "group";
	senderId: string;
	content: string;
	rawContentType: string;
}

export interface ChannelLike {
	onMessage(handler: (message: NormalizedChannelMessage) => Promise<void> | void): () => void;
	onReaction(handler: FeishuReactionHandler): () => void;
	connect(): Promise<void>;
	disconnect(): Promise<void>;
	/** Sends text and resolves with the sent Feishu message id (for later recall). */
	sendText(to: string, text: string, replyTo?: string): Promise<string | undefined>;
	startCardStream(to: string, card: object, replyTo?: string): Promise<ChannelCardStream>;
	editText(messageId: string, text: string): Promise<void>;
	addReaction(messageId: string, emojiType: string): Promise<string>;
	removeReaction(messageId: string, reactionId: string): Promise<void>;
	recallMessage(messageId: string): Promise<void>;
}

export interface ChannelCardStream {
	update(card: object): Promise<void>;
	finish(): Promise<void>;
}

export type ChannelFactory = (credentials: FeishuCredentials) => ChannelLike;

export class SdkFeishuGateway implements FeishuGateway {
	private readonly credentials: FeishuCredentials;
	private readonly channelFactory: ChannelFactory;
	private readonly reactionHandlers = new Set<FeishuReactionHandler>();
	private channel: ChannelLike | undefined;
	private unsubscribe: (() => void) | undefined;
	private reactionUnsubscribe: (() => void) | undefined;

	constructor(credentials: FeishuCredentials, channelFactory: ChannelFactory = createOfficialChannel) {
		this.credentials = credentials;
		this.channelFactory = channelFactory;
	}

	async connect(handler: FeishuMessageHandler): Promise<void> {
		if (this.channel) return;
		const channel = this.channelFactory(this.credentials);
		const unsubscribe = channel.onMessage((message) =>
			handler({
				messageId: message.messageId,
				chatId: message.chatId,
				chatType: message.chatType,
				senderOpenId: message.senderId,
				contentType: message.rawContentType,
				text: message.content,
			}),
		);
		const reactionUnsubscribe = channel.onReaction((event) => {
			for (const reactionHandler of this.reactionHandlers) reactionHandler(event);
		});
		this.channel = channel;
		this.unsubscribe = unsubscribe;
		this.reactionUnsubscribe = reactionUnsubscribe;
		try {
			await channel.connect();
		} catch (error) {
			this.channel = undefined;
			this.unsubscribe = undefined;
			this.reactionUnsubscribe = undefined;
			unsubscribe();
			reactionUnsubscribe();
			await channel.disconnect().catch(() => undefined);
			throw error;
		}
	}

	async disconnect(): Promise<void> {
		const channel = this.channel;
		this.channel = undefined;
		this.unsubscribe?.();
		this.unsubscribe = undefined;
		this.reactionUnsubscribe?.();
		this.reactionUnsubscribe = undefined;
		if (channel) await channel.disconnect();
	}

	onReaction(handler: FeishuReactionHandler): () => void {
		this.reactionHandlers.add(handler);
		return () => this.reactionHandlers.delete(handler);
	}

	async createGroupChat(name: string, ownerOpenId: string): Promise<string> {
		const response = await fetch("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ app_id: this.credentials.appId, app_secret: this.credentials.appSecret }),
		});
		const tokenResult = (await response.json()) as { code?: number; msg?: string; tenant_access_token?: string };
		if (!response.ok || tokenResult.code !== 0 || !tokenResult.tenant_access_token) {
			throw new Error(`获取飞书 tenant token 失败：${tokenResult.msg ?? response.statusText}`);
		}
		const createResponse = await fetch(`https://open.feishu.cn/open-apis/im/v1/chats?uuid=${crypto.randomUUID()}`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${tokenResult.tenant_access_token}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ name, description: "Pi Feishu 创建的协作群", user_id_list: [ownerOpenId] }),
		});
		const result = (await createResponse.json()) as { code?: number; msg?: string; data?: { chat_id?: string } };
		if (!createResponse.ok || result.code !== 0 || !result.data?.chat_id) {
			throw new Error(`飞书创建群聊失败：${result.msg ?? createResponse.statusText}`);
		}
		return result.data.chat_id;
	}

	async sendText(chatId: string, text: string, replyTo?: string): Promise<string | undefined> {
		const channel = this.channel;
		if (!channel) throw new Error("飞书长连接尚未启动。");
		return channel.sendText(chatId, text, replyTo);
	}

	async addReaction(messageId: string, emojiType: string): Promise<string> {
		const channel = this.channel;
		if (!channel) throw new Error("飞书长连接尚未启动。");
		return channel.addReaction(messageId, emojiType);
	}

	async removeReaction(messageId: string, reactionId: string): Promise<void> {
		const channel = this.channel;
		if (!channel) throw new Error("飞书长连接尚未启动。");
		await channel.removeReaction(messageId, reactionId);
	}

	async recallMessage(messageId: string): Promise<void> {
		const channel = this.channel;
		if (!channel) throw new Error("飞书长连接尚未启动。");
		await channel.recallMessage(messageId);
	}

	async editText(messageId: string, text: string): Promise<void> {
		const channel = this.channel;
		if (!channel) throw new Error("飞书长连接尚未启动。");
		await channel.editText(messageId, text);
	}

	async beginReply(chatId: string, replyTo: string): Promise<FeishuReply> {
		const channel = this.channel;
		if (!channel) throw new Error("飞书长连接尚未启动。");
		const initial = { text: "", status: "正在思考" } satisfies FeishuReplySnapshot;
		const stream = await channel.startCardStream(chatId, buildReplyCard(initial), replyTo);
		return new SdkFeishuReply(stream, channel, chatId, replyTo, initial);
	}
}

export async function validateSdkCredentials(
	credentials: FeishuCredentials,
	channelFactory: ChannelFactory = createOfficialChannel,
): Promise<void> {
	const channel = channelFactory(credentials);
	try {
		await channel.connect();
	} finally {
		await channel.disconnect().catch(() => undefined);
	}
}

function createOfficialChannel(credentials: FeishuCredentials): ChannelLike {
	return new OfficialChannelAdapter(
		createLarkChannel({
			appId: credentials.appId,
			appSecret: credentials.appSecret,
			transport: "websocket",
			handshakeTimeoutMs: 10_000,
			loggerLevel: LoggerLevel.error,
			source: "pi-feishu",
			outbound: {
				streamThrottleMs: 500,
				streamThrottleChars: 120,
			},
			policy: {
				dmMode: "open",
				// Controller enforces owner identity and only accepts groups it created.
				groupAllowlist: [],
				requireMention: true,
			},
			safety: {
				chatQueue: { enabled: false },
			},
		}),
	);
}

class OfficialChannelAdapter implements ChannelLike {
	private readonly channel: LarkChannel;

	constructor(channel: LarkChannel) {
		this.channel = channel;
	}

	onMessage(handler: (message: NormalizedChannelMessage) => Promise<void> | void): () => void {
		return this.channel.on("message", (message) => handler(toChannelMessage(message)));
	}

	onReaction(handler: FeishuReactionHandler): () => void {
		return this.channel.on("reaction", (event) =>
			handler({
				messageId: event.messageId,
				operatorOpenId: event.operator.openId,
				emojiType: event.emojiType,
				action: event.action,
			}),
		);
	}

	async connect(): Promise<void> {
		await this.channel.connect();
	}

	async disconnect(): Promise<void> {
		await this.channel.disconnect();
	}

	async sendText(to: string, text: string, replyTo?: string): Promise<string | undefined> {
		const result = await this.channel.send(to, { text }, replyTo ? { replyTo } : undefined);
		return result.messageId;
	}

	async editText(messageId: string, text: string): Promise<void> {
		await this.channel.editMessage(messageId, text);
	}

	async addReaction(messageId: string, emojiType: string): Promise<string> {
		return this.channel.addReaction(messageId, emojiType);
	}

	async removeReaction(messageId: string, reactionId: string): Promise<void> {
		await this.channel.removeReaction(messageId, reactionId);
	}

	async recallMessage(messageId: string): Promise<void> {
		await this.channel.recallMessage(messageId);
	}

	async startCardStream(to: string, card: object, replyTo?: string): Promise<ChannelCardStream> {
		const stream = new OfficialChannelCardStream(this.channel, to, card, replyTo);
		await stream.start();
		return stream;
	}
}

interface CardStreamControllerLike {
	update(card: object): Promise<void>;
}

class OfficialChannelCardStream implements ChannelCardStream {
	private controller: CardStreamControllerLike | undefined;
	private resolveOpened: (() => void) | undefined;
	private resolveProducer: (() => void) | undefined;
	private readonly opened: Promise<void>;
	private readonly producerCompleted: Promise<void>;
	private readonly stream: Promise<void>;

	constructor(channel: LarkChannel, to: string, card: object, replyTo?: string) {
		this.opened = new Promise<void>((resolve) => {
			this.resolveOpened = resolve;
		});
		this.producerCompleted = new Promise<void>((resolve) => {
			this.resolveProducer = resolve;
		});
		this.stream = channel
			.stream(
				to,
				{
					card: {
						initial: card,
						producer: async (controller) => {
							this.controller = controller;
							this.resolveOpened?.();
							await this.producerCompleted;
						},
					},
				},
				replyTo ? { replyTo } : undefined,
			)
			.then(() => undefined);
	}

	async start(): Promise<void> {
		await Promise.race([this.opened, this.stream]);
	}

	async update(card: object): Promise<void> {
		const controller = this.controller;
		if (!controller) throw new Error("飞书流式回复尚未准备完成。");
		await controller.update(card);
	}

	async finish(): Promise<void> {
		this.resolveProducer?.();
		await this.stream;
	}
}

class SdkFeishuReply implements FeishuReply {
	private snapshot: FeishuReplySnapshot;
	private terminal = false;
	private updateFailed = false;

	constructor(
		private readonly stream: ChannelCardStream,
		private readonly channel: ChannelLike,
		private readonly chatId: string,
		private readonly replyTo: string,
		initial: FeishuReplySnapshot,
	) {
		this.snapshot = initial;
	}

	update(snapshot: FeishuReplySnapshot): void {
		if (this.terminal) return;
		this.snapshot = snapshot;
		void this.stream.update(buildReplyCard(snapshot)).catch(() => {
			this.updateFailed = true;
		});
	}

	async complete(snapshot: FeishuReplySnapshot): Promise<void> {
		await this.finish(snapshot, snapshot.text || "Pi 已完成处理，但没有返回文本内容。");
	}

	async fail(): Promise<void> {
		await this.finish(
			{ text: this.snapshot.text || "处理消息失败，请稍后再试。", status: "处理失败" },
			"处理消息失败，请稍后再试。",
		);
	}

	async cancel(): Promise<void> {
		await this.finish({ text: this.snapshot.text || "任务已取消。", status: "已取消" }, "任务已取消。");
	}

	private async finish(snapshot: FeishuReplySnapshot, fallbackText: string): Promise<void> {
		if (this.terminal) return;
		this.terminal = true;
		this.snapshot = snapshot;
		try {
			if (!this.updateFailed) await this.stream.update(buildReplyCard(snapshot));
			await this.stream.finish();
		} catch {
			await this.channel.sendText(this.chatId, fallbackText, this.replyTo).catch(() => undefined);
		}
	}
}

export function buildReplyCard(snapshot: FeishuReplySnapshot): object {
	const content = snapshot.text.trim() || statusPlaceholder(snapshot.status);
	return {
		config: { wide_screen_mode: true },
		header: {
			title: { tag: "plain_text", content: "Pi" },
			template: headerTemplate(snapshot.status),
		},
		elements: [
			{ tag: "markdown", content },
			{
				tag: "note",
				elements: [{ tag: "plain_text", content: snapshot.status }],
			},
		],
	};
}

function statusPlaceholder(status: FeishuReplySnapshot["status"]): string {
	if (status === "正在执行工具") return "正在执行工具…";
	if (status === "正在生成回复") return "正在生成回复…";
	if (status === "已取消") return "任务已取消。";
	if (status === "处理失败") return "处理消息失败，请稍后再试。";
	if (status === "已完成") return "Pi 已完成处理，但没有返回文本内容。";
	return "正在思考…";
}

function headerTemplate(status: FeishuReplySnapshot["status"]): "blue" | "green" | "red" | "grey" {
	if (status === "已完成") return "green";
	if (status === "处理失败") return "red";
	if (status === "已取消") return "grey";
	return "blue";
}

function toChannelMessage(message: NormalizedMessage): NormalizedChannelMessage {
	return {
		messageId: message.messageId,
		chatId: message.chatId,
		chatType: message.chatType,
		senderId: message.senderId,
		content: message.content,
		rawContentType: message.rawContentType,
	};
}
