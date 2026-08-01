import type {
	AgentBridge,
	CredentialStore,
	CredentialValidator,
	Environment,
	FeishuCredentials,
	FeishuGateway,
	FeishuGatewayFactory,
	FeishuIncomingMessage,
	FeishuReply,
} from "./contracts.js";
import { CredentialError, errorMessage, resolveCredentialInput, resolveRuntimeCredentials } from "./credentials.js";
import { MessageDeduplicator } from "./message-deduplicator.js";
import { SerialMessageQueue } from "./message-queue.js";
import { OwnerBinding } from "./owner-binding.js";

export interface FeishuControllerOptions {
	store: CredentialStore;
	gatewayFactory: FeishuGatewayFactory;
	validateCredentials: CredentialValidator;
	agent: AgentBridge;
	generateBindingCode?: () => string;
}

export interface FeishuStartResult {
	alreadyRunning: boolean;
	bindingCode?: string;
}

export interface FeishuStatus {
	configured: boolean;
	running: boolean;
	ownerOpenId?: string;
	appId?: string;
	source?: "environment" | "file";
	pendingMessages: number;
}

export class FeishuController {
	private readonly store: CredentialStore;
	private readonly gatewayFactory: FeishuGatewayFactory;
	private readonly validateCredentials: CredentialValidator;
	private readonly agent: AgentBridge;
	private readonly generateBindingCode: (() => string) | undefined;
	private readonly queue = new SerialMessageQueue();
	private readonly deduplicator = new MessageDeduplicator();
	private gateway: FeishuGateway | undefined;
	private credentials: FeishuCredentials | undefined;
	private binding: OwnerBinding | undefined;
	private readonly activeReplies = new Set<FeishuReply>();

	constructor(options: FeishuControllerOptions) {
		this.store = options.store;
		this.gatewayFactory = options.gatewayFactory;
		this.validateCredentials = options.validateCredentials;
		this.agent = options.agent;
		this.generateBindingCode = options.generateBindingCode;
	}

	async setup(args: string, environment: Environment): Promise<FeishuCredentials> {
		const input = resolveCredentialInput(args, environment);
		const credentials: FeishuCredentials = { appId: input.appId, appSecret: input.appSecret };
		try {
			await this.validateCredentials(credentials);
		} catch (error) {
			throw new CredentialError(`飞书凭据验证失败：${errorMessage(error, credentials)}`);
		}

		const existing = await this.store.load();
		const next =
			existing?.appId === credentials.appId && existing.ownerOpenId
				? { ...credentials, ownerOpenId: existing.ownerOpenId }
				: credentials;
		await this.store.save(next);
		this.credentials = next;
		this.binding = new OwnerBinding(next.ownerOpenId, this.generateBindingCode);
		return next;
	}

	async start(environment: Environment): Promise<FeishuStartResult> {
		if (this.gateway) return { alreadyRunning: true };

		const stored = await this.store.load();
		const credentials = resolveRuntimeCredentials(environment, stored);
		if (!credentials) {
			throw new CredentialError("尚未配置飞书凭据，请先执行 /feishu setup。");
		}

		const binding = new OwnerBinding(credentials.ownerOpenId, this.generateBindingCode);
		const gateway = this.gatewayFactory(credentials);
		this.credentials = credentials;
		this.binding = binding;
		this.gateway = gateway;
		this.deduplicator.clear();

		try {
			await gateway.connect((message) => this.handleIncoming(message));
		} catch (error) {
			this.gateway = undefined;
			this.binding = undefined;
			await gateway.disconnect().catch(() => undefined);
			throw new CredentialError(`启动飞书长连接失败：${errorMessage(error, credentials)}`);
		}

		const bindingCode = binding.getOrCreateCode();
		return bindingCode ? { alreadyRunning: false, bindingCode } : { alreadyRunning: false };
	}

	async stop(): Promise<boolean> {
		const gateway = this.gateway;
		if (!gateway) return false;
		await Promise.all([...this.activeReplies].map((reply) => reply.cancel().catch(() => undefined)));
		this.activeReplies.clear();
		this.gateway = undefined;
		this.binding = undefined;
		this.agent.cancel("飞书连接已停止。");
		await gateway.disconnect();
		return true;
	}

	async logout(): Promise<void> {
		const stopped = await this.stop();
		if (!stopped) this.agent.cancel("飞书已退出。");
		this.credentials = undefined;
		await this.store.clear();
	}

	async status(environment: Environment): Promise<FeishuStatus> {
		const stored = await this.store.load();
		const resolved = resolveRuntimeCredentials(environment, stored);
		if (!resolved) {
			return { configured: false, running: Boolean(this.gateway), pendingMessages: this.queue.pendingCount };
		}
		const source = environment.FEISHU_APP_ID?.trim() && environment.FEISHU_APP_SECRET?.trim() ? "environment" : "file";
		const result: FeishuStatus = {
			configured: true,
			running: Boolean(this.gateway),
			appId: resolved.appId,
			source,
			pendingMessages: this.queue.pendingCount,
		};
		if (resolved.ownerOpenId) result.ownerOpenId = resolved.ownerOpenId;
		return result;
	}

	async handleIncoming(message: FeishuIncomingMessage): Promise<void> {
		const gateway = this.gateway;
		const binding = this.binding;
		if (!gateway || !binding || message.chatType !== "p2p" || message.contentType !== "text") return;
		if (!message.messageId || !this.deduplicator.accept(message.messageId)) return;

		const authorization = binding.authorize(message.senderOpenId, message.text);
		switch (authorization.kind) {
			case "binding-required":
				await this.safeSend(gateway, message, "Bot 尚未绑定，请在本地 Pi 查看一次性绑定码。");
				return;
			case "invalid-binding-code":
				await this.safeSend(gateway, message, "绑定码无效，请检查本地 Pi 显示的一次性绑定码。");
				return;
			case "unauthorized":
				await this.safeSend(gateway, message, "未授权：此 Bot 仅响应已绑定的 Owner。");
				return;
			case "bound":
				await this.persistOwner(authorization.ownerOpenId);
				await this.safeSend(gateway, message, "绑定成功，现在可以直接发送问题。");
				return;
			case "authorized":
				void this.queue.enqueue(async () => {
					if (this.gateway !== gateway) return;
					const reply = await gateway.beginReply(message.chatId, message.messageId).catch(() => undefined);
					if (reply) this.activeReplies.add(reply);
					let latestText = "";
					try {
						const response = await this.agent.run(authorization.text, {
							onText: (text) => {
								latestText = text;
								reply?.update({ text, status: "正在生成回复" });
							},
							onActivity: (activity) => {
								reply?.update({
									text: latestText,
									status: activity.kind === "tool" ? "正在执行工具" : "正在思考",
								});
							},
						});
						if (this.gateway === gateway) {
							if (reply) {
								await reply.complete({ text: response, status: "已完成" });
							} else {
								await gateway.sendText(message.chatId, response, message.messageId);
							}
						}
					} catch {
						if (this.gateway === gateway) {
							if (reply) {
								await reply.fail();
							} else {
								await this.safeSend(gateway, message, "处理消息失败，请稍后再试。");
							}
						}
					} finally {
						if (reply) this.activeReplies.delete(reply);
					}
				});
		}
	}

	async waitForIdle(): Promise<void> {
		await this.queue.waitForIdle();
	}

	sanitizeError(error: unknown): string {
		return errorMessage(error, this.credentials);
	}

	private async persistOwner(ownerOpenId: string): Promise<void> {
		const credentials = this.credentials;
		if (!credentials) return;
		const next = { ...credentials, ownerOpenId };
		await this.store.save(next);
		this.credentials = next;
	}

	private async safeSend(gateway: FeishuGateway, message: FeishuIncomingMessage, text: string): Promise<void> {
		try {
			await gateway.sendText(message.chatId, text, message.messageId);
		} catch {
			// The inbound event has already been acknowledged; outbound failures are non-fatal.
		}
	}
}
