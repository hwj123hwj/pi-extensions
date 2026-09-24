import type {
	AgentBridge,
	CredentialStore,
	CredentialValidator,
	Environment,
	FeishuCredentials,
	FeishuGateway,
	FeishuGatewayFactory,
	FeishuIncomingMessage,
	FeishuReactionEvent,
	FeishuReply,
	FeishuStatus,
	PiRuntime,
} from "./contracts.js";
import { CredentialError, errorMessage, resolveCredentialInput, resolveRuntimeCredentials } from "./credentials.js";
import { MessageDeduplicator } from "./message-deduplicator.js";
import { SerialMessageQueue } from "./message-queue.js";
import { OwnerBinding } from "./owner-binding.js";
import { executeRemoteCommand, parseRemoteCommand } from "./remote-commands.js";
import { buildGroupPermissionReminder } from "./scopes.js";

// 与 easycodeclient 的飞书集成一致：THINKING 表情兼作"已读 + 处理中"回执。
const READ_REACTION_EMOJI = "THINKING";

interface PendingTask {
	messageId: string;
	chatId: string;
	reactionId: string;
	tipText: string;
	tipMessageId: string | undefined;
	started: boolean;
	cancelled: boolean;
}

function queueTipText(position: number): string {
	return `⏳ 已收到，排队中（第 ${position} 位），将在当前任务完成后处理。`;
}

export interface FeishuControllerOptions {
	store: CredentialStore;
	gatewayFactory: FeishuGatewayFactory;
	validateCredentials: CredentialValidator;
	agent: AgentBridge;
	runtime?: PiRuntime;
	generateBindingCode?: () => string;
}

export interface FeishuStartResult {
	alreadyRunning: boolean;
	bindingCode?: string;
}

export class FeishuController {
	private readonly store: CredentialStore;
	private readonly gatewayFactory: FeishuGatewayFactory;
	private readonly validateCredentials: CredentialValidator;
	private readonly agent: AgentBridge;
	private readonly runtime: PiRuntime | undefined;
	private readonly generateBindingCode: (() => string) | undefined;
	private readonly queue = new SerialMessageQueue();
	private readonly deduplicator = new MessageDeduplicator();
	private gateway: FeishuGateway | undefined;
	private credentials: FeishuCredentials | undefined;
	private binding: OwnerBinding | undefined;
	private environment: Environment = {};
	private readonly pendingTasks = new Map<string, PendingTask>();
	private readonly activeReplies = new Set<FeishuReply>();
	private readonly managedGroupIds = new Set<string>();

	constructor(options: FeishuControllerOptions) {
		this.store = options.store;
		this.gatewayFactory = options.gatewayFactory;
		this.validateCredentials = options.validateCredentials;
		this.agent = options.agent;
		this.runtime = options.runtime;
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
		const next: FeishuCredentials =
			existing?.appId === credentials.appId
				? {
						...credentials,
						...(existing.ownerOpenId ? { ownerOpenId: existing.ownerOpenId } : {}),
						...(existing.managedGroupIds ? { managedGroupIds: existing.managedGroupIds } : {}),
						...(existing.groupSessions ? { groupSessions: existing.groupSessions } : {}),
					}
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
		this.managedGroupIds.clear();
		for (const chatId of credentials.managedGroupIds ?? []) this.managedGroupIds.add(chatId);
		this.binding = binding;
		this.gateway = gateway;
		this.environment = environment;
		this.deduplicator.clear();

		try {
			await gateway.connect((message) => this.handleIncoming(message));
		} catch (error) {
			this.gateway = undefined;
			this.binding = undefined;
			await gateway.disconnect().catch(() => undefined);
			throw new CredentialError(`启动飞书长连接失败：${errorMessage(error, credentials)}`);
		}
		gateway.onReaction((event) => this.handleReaction(event));

		const bindingCode = binding.getOrCreateCode();
		return bindingCode ? { alreadyRunning: false, bindingCode } : { alreadyRunning: false };
	}

	async createGroupChat(name: string): Promise<string> {
		const gateway = this.gateway;
		const ownerOpenId = this.credentials?.ownerOpenId;
		if (!gateway) throw new CredentialError("飞书尚未连接，请先执行 /feishu start。");
		if (!ownerOpenId) throw new CredentialError("飞书尚未绑定 Owner，无法创建群聊。");
		const chatId = await gateway.createGroupChat(name, ownerOpenId);
		this.managedGroupIds.add(chatId);
		const credentials = this.credentials;
		if (credentials) {
			const updated = { ...credentials, managedGroupIds: [...this.managedGroupIds] };
			await this.store.save(updated);
			this.credentials = updated;
		}
		await gateway.sendText(
			chatId,
			`👋 群聊「${name}」已创建，当前绑定的 Pi 飞书机器人已就绪。直接在群内 @机器人即可开始协作。若群内普通消息没有响应，请先 @ 机器人；开通免 @ 权限后可直接发消息。`,
		);
		await this.sendGroupPermissionReminder(gateway, ownerOpenId, name);
		return chatId;
	}

	getChatSessionFile(chatId: string): string | undefined {
		return this.credentials?.groupSessions?.[chatId];
	}

	async setChatSessionFile(chatId: string, sessionFile: string): Promise<void> {
		const credentials = this.credentials;
		if (!credentials) return;
		const updated = {
			...credentials,
			groupSessions: { ...(credentials.groupSessions ?? {}), [chatId]: sessionFile },
		};
		await this.store.save(updated);
		this.credentials = updated;
	}

	private async sendGroupPermissionReminder(
		gateway: FeishuGateway,
		ownerOpenId: string,
		groupName: string,
	): Promise<void> {
		const credentials = this.credentials;
		if (!credentials) return;
		let grantedScopes: string[] | undefined;
		try {
			grantedScopes = (await gateway.probeGrantedScopes?.())?.grantedScopes;
		} catch {
			grantedScopes = undefined;
		}
		const reminder = buildGroupPermissionReminder({
			appId: credentials.appId,
			groupName,
			...(grantedScopes ? { grantedScopes } : {}),
		});
		if (!reminder) return;
		await gateway.sendText(ownerOpenId, reminder).catch(() => undefined);
	}

	async stop(): Promise<boolean> {
		const gateway = this.gateway;
		if (!gateway) return false;
		for (const entry of this.pendingTasks.values()) entry.cancelled = true;
		this.pendingTasks.clear();
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

	/** 读取应用已开通 scope 列表（用于权限健康度检查）。未连接或 probe 失败时返回空对象。 */
	async probeScopes(): Promise<{ grantedScopes?: string[] }> {
		try {
			return (await this.gateway?.probeGrantedScopes?.()) ?? {};
		} catch {
			return {};
		}
	}

	get appId(): string | undefined {
		return this.credentials?.appId;
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
		if (!gateway || !binding || message.contentType !== "text") return;
		if (message.chatType === "group" && !this.managedGroupIds.has(message.chatId)) return;
		if (!message.messageId || !this.deduplicator.accept(message.messageId)) return;

		const reactionId = await this.ackRead(gateway, message.messageId);
		const authorization = binding.authorize(message.senderOpenId, message.text);
		switch (authorization.kind) {
			case "binding-required":
				await this.acknowledge(gateway, message, reactionId, "Bot 尚未绑定，请在本地 Pi 查看一次性绑定码。");
				return;
			case "invalid-binding-code":
				await this.acknowledge(gateway, message, reactionId, "绑定码无效，请检查本地 Pi 显示的一次性绑定码。");
				return;
			case "unauthorized":
				await this.acknowledge(gateway, message, reactionId, "未授权：此 Bot 仅响应已绑定的 Owner。");
				return;
			case "bound":
				await this.persistOwner(authorization.ownerOpenId);
				await this.acknowledge(gateway, message, reactionId, "绑定成功，现在可以直接发送问题。");
				return;
			case "authorized":
				if (parseRemoteCommand(authorization.text)) {
					// 斜杠命令快速通道：不进入消息队列，也不进入 LLM 上下文。
					await this.runRemoteCommand(gateway, message, reactionId, authorization.text);
					return;
				}
				void this.enqueueAgentTask(gateway, message, authorization.text, reactionId);
		}
	}

	private enqueueAgentTask(
		gateway: FeishuGateway,
		message: FeishuIncomingMessage,
		text: string,
		reactionId: string,
	): void {
		const entry: PendingTask = {
			messageId: message.messageId,
			chatId: message.chatId,
			reactionId,
			tipText: "",
			tipMessageId: undefined,
			started: false,
			cancelled: false,
		};
		// Map 保持插入顺序：首位是正在处理的任务，其余按排队先后排列。
		const position = this.pendingTasks.size + 1;
		this.pendingTasks.set(message.messageId, entry);

		if (position > 1) {
			entry.tipText = queueTipText(position);
			void gateway
				.sendText(message.chatId, entry.tipText, message.messageId)
				.then((tipId) => {
					if (!tipId) return;
					// 提示送达时任务已开工或已取消：提示已无意义，直接撤回。
					if (entry.cancelled || entry.started) {
						void gateway.recallMessage(tipId).catch(() => undefined);
						return;
					}
					entry.tipMessageId = tipId;
					this.refreshQueueTips(gateway);
				})
				.catch(() => undefined);
		}

		void this.queue.enqueue(async () => {
			entry.started = true;
			try {
				this.recallTip(gateway, entry);
				if (this.gateway !== gateway) return;
				// 被取消的任务静默跳过：回执与提示已由取消方清理。
				if (entry.cancelled) return;
				await this.processWithAgent(gateway, message, text);
			} finally {
				this.pendingTasks.delete(message.messageId);
				this.refreshQueueTips(gateway);
				await this.clearRead(gateway, message.messageId, reactionId);
			}
		});
	}

	private recallTip(gateway: FeishuGateway, entry: PendingTask): void {
		const tipId = entry.tipMessageId;
		if (!tipId) return;
		entry.tipMessageId = undefined;
		void gateway.recallMessage(tipId).catch(() => undefined);
	}

	/** 排队提示动态改位：前方的任务完成或被移除后，剩余提示更新为新位数。 */
	private refreshQueueTips(gateway: FeishuGateway): void {
		let position = 0;
		for (const entry of this.pendingTasks.values()) {
			position += 1;
			// 首位要么正在处理、要么即将开工（提示随即撤回），无需改写。
			if (position === 1 || entry.started || !entry.tipMessageId) continue;
			const text = queueTipText(position);
			if (text === entry.tipText) continue;
			entry.tipText = text;
			void gateway.editText(entry.tipMessageId, text).catch(() => undefined);
		}
	}

	/** 中止当前任务之后的所有排队消息，返回跳过数量。 */
	private stopQueuedMessages(gateway: FeishuGateway): number {
		let skipped = 0;
		for (const entry of [...this.pendingTasks.values()]) {
			if (entry.started) continue;
			entry.cancelled = true;
			skipped += 1;
			this.recallTip(gateway, entry);
			void this.clearRead(gateway, entry.messageId, entry.reactionId);
			entry.reactionId = "";
			// 立即移出登记表：后续提示改位不再把它算作在队。
			this.pendingTasks.delete(entry.messageId);
		}
		return skipped;
	}

	/** Owner 在排队中的消息上点 ❌（或 NO）表情：取消该消息并清理提示与回执。 */
	handleReaction(event: FeishuReactionEvent): void {
		const gateway = this.gateway;
		const binding = this.binding;
		if (!gateway || !binding) return;
		if (event.action !== "added") return;
		const normalized = event.emojiType.toLowerCase();
		if (normalized !== "crossmark" && normalized !== "no") return;
		if (event.operatorOpenId !== binding.ownerOpenId) return;
		const entry = this.pendingTasks.get(event.messageId);
		if (!entry || entry.started || entry.cancelled) return;

		entry.cancelled = true;
		this.recallTip(gateway, entry);
		void this.clearRead(gateway, entry.messageId, entry.reactionId);
		entry.reactionId = "";
		this.pendingTasks.delete(entry.messageId);
		this.refreshQueueTips(gateway);
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

	private async processWithAgent(gateway: FeishuGateway, message: FeishuIncomingMessage, text: string): Promise<void> {
		if (this.gateway !== gateway) return;
		const reply = await gateway.beginReply(message.chatId, message.messageId).catch(() => undefined);
		if (reply) this.activeReplies.add(reply);
		let latestText = "";
		try {
			const response = await this.agent.run(
				text,
				{
					onText: (latest) => {
						latestText = latest;
						reply?.update({ text: latest, status: "正在生成回复" });
					},
					onActivity: (activity) => {
						reply?.update({
							text: latestText,
							status: activity.kind === "tool" ? "正在执行工具" : "正在思考",
						});
					},
				},
				message.chatType === "group" ? { chatId: message.chatId } : undefined,
			);
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
	}

	private async runRemoteCommand(
		gateway: FeishuGateway,
		message: FeishuIncomingMessage,
		reactionId: string,
		text: string,
	): Promise<void> {
		const replyText = await executeRemoteCommand(text, {
			runtime: this.runtime,
			status: () => this.status(this.environment),
			stopQueue: () => this.stopQueuedMessages(gateway),
		}).catch((error: unknown) => `执行命令出错：${this.sanitizeError(error)}`);
		await this.acknowledge(gateway, message, reactionId, replyText);
	}

	private async ackRead(gateway: FeishuGateway, messageId: string): Promise<string> {
		try {
			return await gateway.addReaction(messageId, READ_REACTION_EMOJI);
		} catch {
			// 表情权限缺失时静默降级：不影响正常的收发消息流程。
			return "";
		}
	}

	private async clearRead(gateway: FeishuGateway, messageId: string, reactionId: string): Promise<void> {
		if (!reactionId) return;
		await gateway.removeReaction(messageId, reactionId).catch(() => undefined);
	}

	private async acknowledge(
		gateway: FeishuGateway,
		message: FeishuIncomingMessage,
		reactionId: string,
		text: string,
	): Promise<void> {
		await this.safeSend(gateway, message, text);
		await this.clearRead(gateway, message.messageId, reactionId);
	}

	private async safeSend(gateway: FeishuGateway, message: FeishuIncomingMessage, text: string): Promise<void> {
		try {
			await gateway.sendText(message.chatId, text, message.messageId);
		} catch {
			// The inbound event has already been acknowledged; outbound failures are non-fatal.
		}
	}
}
