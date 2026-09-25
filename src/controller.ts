import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import type {
	AgentBridge,
	CredentialStore,
	CredentialValidator,
	Environment,
	FeishuBotAddedEvent,
	FeishuCredentials,
	FeishuGateway,
	FeishuGatewayFactory,
	FeishuIncomingMessage,
	FeishuMentionInfo,
	FeishuReactionEvent,
	FeishuReply,
	FeishuStatus,
	PiRuntime,
} from "./contracts.js";
import {
	CredentialError,
	defaultProcessedMessagesPath,
	errorMessage,
	resolveCredentialInput,
	resolveRuntimeCredentials,
} from "./credentials.js";
import { MessageDeduplicator } from "./message-deduplicator.js";
import { SerialMessageQueue } from "./message-queue.js";
import { OwnerBinding } from "./owner-binding.js";
import { executeRemoteCommand, type ParsedRemoteCommand, parseRemoteCommand } from "./remote-commands.js";
import {
	buildBotAddedGuidance,
	buildGroupPermissionReminder,
	buildScopeHealthSection,
	buildStartupWelcome,
} from "./scopes.js";

// 与 easycodeclient 的飞书集成一致：THINKING 表情兼作"已读 + 处理中"回执。
const READ_REACTION_EMOJI = "THINKING";

// 绑定码消息形如 /bind 123456；群聊中出现时拒绝绑定（防止群成员目击后劫持 Owner）。
const BIND_CODE_PATTERN = /^\/bind\s+\d{6}$/;

// 群/授权管理命令只允许 Owner 使用；allowlist 成员可用其余远程命令。
const OWNER_ONLY_COMMANDS = new Set(["/bind", "/allow", "/deny", "/allowlist"]);

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

/**
 * 对齐 easycodeclient 的群聊上下文注入：让模型知道这是群内谁在说话，
 * 而不是把群消息当成凭空的提问。SDK 已把 @ 他人改写成「@名字」。
 */
export function buildAgentPrompt(message: FeishuIncomingMessage, text: string): string {
	if (message.chatType !== "group") return text;
	const who = message.senderName?.trim() || message.senderOpenId;
	return `[飞书群聊] ${who}：${text}`;
}

/** 从 /allow、/deny 参数中解析目标成员：优先取消息里 @ 的人，其次接受 ou_ 开头的 open id。 */
export function resolveAllowTarget(
	args: string,
	mentions: readonly FeishuMentionInfo[] | undefined,
): { openId: string; name?: string } | undefined {
	const mentioned = mentions?.find((entry) => !entry.isBot && entry.openId);
	if (mentioned?.openId) {
		return { openId: mentioned.openId, ...(mentioned.name ? { name: mentioned.name } : {}) };
	}
	const trimmed = args.trim();
	if (/^ou_[A-Za-z0-9]+$/.test(trimmed)) return { openId: trimmed };
	return undefined;
}

export interface FeishuControllerOptions {
	store: CredentialStore;
	gatewayFactory: FeishuGatewayFactory;
	validateCredentials: CredentialValidator;
	agent: AgentBridge;
	runtime?: PiRuntime;
	generateBindingCode?: () => string;
	/** 落盘去重记录的路径；默认与凭据同目录，测试注入临时路径。 */
	deduplicationPath?: string;
	/** 本地忙闲轮询间隔（测试可调小）。 */
	idlePollMs?: number;
	/** 本地 Pi 持续繁忙多久后放弃处理（默认 15 分钟）。 */
	localBusyTimeoutMs?: number;
	/** 繁忙持续多久后给聊天发等待提示（默认 3 秒）。 */
	busyNotifyAfterMs?: number;
}

const DEFAULT_IDLE_POLL_MS = 2000;
const DEFAULT_LOCAL_BUSY_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_BUSY_NOTIFY_AFTER_MS = 3000;

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
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
	private readonly deduplicator: MessageDeduplicator;
	private readonly idlePollMs: number;
	private readonly localBusyTimeoutMs: number;
	private readonly busyNotifyAfterMs: number;
	/** stop() 置位：让本地忙闲等待循环立即退出。 */
	private stopped = false;
	private gateway: FeishuGateway | undefined;
	private credentials: FeishuCredentials | undefined;
	private binding: OwnerBinding | undefined;
	private environment: Environment = {};
	private readonly pendingTasks = new Map<string, PendingTask>();
	private readonly activeReplies = new Set<FeishuReply>();
	private readonly managedGroupIds = new Set<string>();
	private botAddedUnsubscribe: (() => void) | undefined;

	constructor(options: FeishuControllerOptions) {
		this.store = options.store;
		this.gatewayFactory = options.gatewayFactory;
		this.validateCredentials = options.validateCredentials;
		this.agent = options.agent;
		this.runtime = options.runtime;
		this.generateBindingCode = options.generateBindingCode;
		this.idlePollMs = options.idlePollMs ?? DEFAULT_IDLE_POLL_MS;
		this.localBusyTimeoutMs = options.localBusyTimeoutMs ?? DEFAULT_LOCAL_BUSY_TIMEOUT_MS;
		this.busyNotifyAfterMs = options.busyNotifyAfterMs ?? DEFAULT_BUSY_NOTIFY_AFTER_MS;
		// 对齐 easycodeclient：受理即落盘的去重记录，进程重启后飞书重推也不会重复执行。
		this.deduplicator = new MessageDeduplicator(5000, options.deduplicationPath ?? defaultProcessedMessagesPath());
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
						...(existing.allowlist ? { allowlist: existing.allowlist } : {}),
						...(existing.allowlistNames ? { allowlistNames: existing.allowlistNames } : {}),
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
		this.stopped = false;
		// 恢复落盘的受理记录：重启后飞书重推的事件仍会被去重，而不是重复驱动 Pi。
		await this.deduplicator.hydrate();

		try {
			await gateway.connect((message) => this.handleIncoming(message));
		} catch (error) {
			this.gateway = undefined;
			this.binding = undefined;
			await gateway.disconnect().catch(() => undefined);
			throw new CredentialError(`启动飞书长连接失败：${errorMessage(error, credentials)}`);
		}
		gateway.onReaction((event) => this.handleReaction(event));
		this.botAddedUnsubscribe = gateway.onBotAdded?.((event) => void this.handleBotAdded(event));

		// 对齐 easycodeclient：网关启动后私聊 Owner 发欢迎语 + 权限体检。
		// 主动 await 保证欢迎语先于任何消息回复送达；probe/发送失败都不阻塞启动。
		if (credentials.ownerOpenId) await this.sendStartupWelcome(gateway, credentials);

		const bindingCode = binding.getOrCreateCode();
		return bindingCode ? { alreadyRunning: false, bindingCode } : { alreadyRunning: false };
	}

	/** Bot 上线后私聊 Owner 的欢迎语；probe 失败时只发正文，不猜权限状态。 */
	private async sendStartupWelcome(gateway: FeishuGateway, credentials: FeishuCredentials): Promise<void> {
		const ownerOpenId = credentials.ownerOpenId;
		if (!ownerOpenId) return;
		const probe = await this.probeScopes();
		const welcome = buildStartupWelcome({
			cwd: process.cwd(),
			healthSection: buildScopeHealthSection(credentials.appId, probe.grantedScopes),
		});
		await gateway.sendText(ownerOpenId, welcome).catch(() => undefined);
	}

	async createGroupChat(name: string, directory?: string): Promise<string> {
		const gateway = this.gateway;
		const ownerOpenId = this.credentials?.ownerOpenId;
		if (!gateway) throw new CredentialError("飞书尚未连接，请先执行 /feishu start。");
		if (!ownerOpenId) throw new CredentialError("飞书尚未绑定 Owner，无法创建群聊。");
		const chatId = await gateway.createGroupChat(name, ownerOpenId);
		this.managedGroupIds.add(chatId);
		let anchoredLine = "";
		if (directory) {
			const resolved = resolve(directory);
			let isDirectory = false;
			try {
				isDirectory = (await stat(resolved)).isDirectory();
			} catch {
				isDirectory = false;
			}
			if (isDirectory) {
				await this.saveCredentials({
					managedGroupIds: [...this.managedGroupIds],
					groupDirs: { ...(this.credentials?.groupDirs ?? {}), [chatId]: resolved },
				});
				anchoredLine = `\n📂 本群已锚定到目录：${resolved}`;
			}
		}
		if (!this.credentials?.groupDirs?.[chatId]) {
			await this.saveCredentials({ managedGroupIds: [...this.managedGroupIds] });
		}
		await gateway.sendText(
			chatId,
			`👋 群聊「${name}」已创建，当前绑定的 Pi 飞书机器人已就绪。直接在群内 @机器人即可开始协作。若群内普通消息没有响应，请先 @ 机器人；开通免 @ 权限后可直接发消息。${anchoredLine}`,
		);
		await this.sendGroupPermissionReminder(gateway, ownerOpenId, name);
		return chatId;
	}

	getChatSessionFile(chatId: string): string | undefined {
		return this.credentials?.groupSessions?.[chatId];
	}

	/** 判断会话文件是否属于某个群绑定会话；用于主会话追踪时排除群会话。 */
	isGroupSessionFile(sessionFile: string): boolean {
		const sessions = this.credentials?.groupSessions;
		if (!sessions) return false;
		return Object.values(sessions).includes(sessionFile);
	}

	/** 向指定聊天发一条提示文字（fire-and-forget，失败静默）。 */
	async notifyChat(chatId: string, text: string): Promise<void> {
		const gateway = this.gateway;
		if (!gateway) return;
		await gateway.sendText(chatId, text).catch(() => undefined);
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
		this.stopped = true;
		this.botAddedUnsubscribe?.();
		this.botAddedUnsubscribe = undefined;
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
		if (!message.messageId || !this.deduplicator.accept(message.messageId)) return;

		// 未托管的群（Owner 没创建、也没 /bind 过）：只在被 @ 时给出引导，其余完全静默。
		if (message.chatType === "group" && !this.managedGroupIds.has(message.chatId)) {
			await this.handleUnmanagedGroupMessage(gateway, message);
			return;
		}

		const reactionId = await this.ackRead(gateway, message.messageId);
		const authorization = binding.authorize(message.senderOpenId, message.text);
		let authorizedText: string | undefined;
		switch (authorization.kind) {
			case "binding-required":
				await this.acknowledge(gateway, message, reactionId, "Bot 尚未绑定，请在本地 Pi 查看一次性绑定码。");
				return;
			case "invalid-binding-code":
				await this.acknowledge(gateway, message, reactionId, "绑定码无效，请检查本地 Pi 显示的一次性绑定码。");
				return;
			case "bound":
				await this.persistOwner(authorization.ownerOpenId);
				await this.acknowledge(gateway, message, reactionId, "绑定成功，现在可以直接发送问题。");
				return;
			case "unauthorized":
				if (this.isAllowlisted(message.senderOpenId)) {
					authorizedText = message.text;
					break;
				}
				// 对齐 easycodeclient 的分寸感：私聊或被 @ 时明确拒绝；群内普通消息保持隐形。
				if (message.chatType === "p2p" || message.mentionedBot) {
					await this.acknowledge(
						gateway,
						message,
						reactionId,
						"未授权：此 Bot 仅响应 Owner 与授权成员。Owner 可在私聊中发送 /allow @成员 添加授权。",
					);
				} else {
					await this.clearRead(gateway, message.messageId, reactionId);
				}
				return;
			case "authorized":
				authorizedText = authorization.text;
		}

		// 对齐 easycodeclient 的安全模型：绑定码只能在私聊使用，防止群成员目击后劫持 Owner。
		if (message.chatType === "group" && BIND_CODE_PATTERN.test(authorizedText.trim())) {
			await this.acknowledge(gateway, message, reactionId, "出于安全考虑，一次性绑定码只能在私聊中使用。");
			return;
		}

		const command = parseRemoteCommand(authorizedText);
		if (command) {
			if (OWNER_ONLY_COMMANDS.has(command.name) && message.senderOpenId !== binding.ownerOpenId) {
				await this.acknowledge(gateway, message, reactionId, "该命令仅 Owner 可用。");
				return;
			}
			if (await this.runManagedChatCommand(gateway, message, reactionId, command)) return;
			await this.runRemoteCommand(gateway, message, reactionId, authorizedText);
			return;
		}
		// 对齐 easycodeclient 的 mid-turn 注入：同聊天的追加消息直接并入正在运行的轮次，
		// 不排队（跨聊天仍全局串行——Pi 是单会话进程）。
		if (this.trySteerIntoRunningTurn(gateway, message, reactionId, authorizedText)) return;
		void this.enqueueAgentTask(gateway, message, authorizedText, reactionId);
	}

	/** 同聊天已有任务在跑时，把新消息并入该轮次；返回是否成功并入。 */
	private trySteerIntoRunningTurn(
		gateway: FeishuGateway,
		message: FeishuIncomingMessage,
		reactionId: string,
		text: string,
	): boolean {
		const runningTask = [...this.pendingTasks.values()].find(
			(entry) => entry.started && !entry.cancelled && entry.chatId === message.chatId,
		);
		if (!runningTask) return false;
		const steered = this.agent.steer?.(buildAgentPrompt(message, text)) ?? false;
		if (!steered) return false;
		// 并入后由运行中的任务统一回复；清掉本条消息的已读表情，改用文字确认。
		void this.clearRead(gateway, message.messageId, reactionId);
		void gateway
			.sendText(
				message.chatId,
				"✅ 已收到，已并入当前正在处理的对话；回复会更新在上面的回复卡片里。",
				message.messageId,
			)
			.catch(() => undefined);
		return true;
	}

	private isAllowlisted(senderOpenId: string): boolean {
		return this.credentials?.allowlist?.includes(senderOpenId) ?? false;
	}

	/** 未托管群：只有显式命令和 @bot 消息会得到回复，其余完全静默。 */
	private async handleUnmanagedGroupMessage(gateway: FeishuGateway, message: FeishuIncomingMessage): Promise<void> {
		// 群内出现绑定码：无论谁发、是否 @，都明确拒绝并提示去私聊，防劫持。
		if (BIND_CODE_PATTERN.test(message.text.trim())) {
			await gateway
				.sendText(message.chatId, "出于安全考虑，一次性绑定码只能在私聊中使用。", message.messageId)
				.catch(() => undefined);
			return;
		}
		const ownerOpenId = this.binding?.ownerOpenId;
		if (!ownerOpenId) return;
		const command = parseRemoteCommand(message.text);
		const isBindCommand = command?.name === "/bind" && !BIND_CODE_PATTERN.test(message.text.trim());
		const isOwner = message.senderOpenId === ownerOpenId;
		const isAllowed = isOwner || this.isAllowlisted(message.senderOpenId);
		// 未被 @ 的普通闲聊保持隐形（免 @ 权限开通后尤其重要）。
		if (!message.mentionedBot && !isBindCommand) return;

		if (!isAllowed) {
			await gateway
				.sendText(
					message.chatId,
					isBindCommand
						? "该命令仅 Owner 可用：请由 Owner 在群里发送 /bind 绑定本群。"
						: "未授权：此 Bot 仅响应 Owner 与授权成员。请联系 Owner 在私聊中发送 /allow @你 添加授权。",
					message.messageId,
				)
				.catch(() => undefined);
			return;
		}
		if (isBindCommand) {
			await this.bindManagedGroup(gateway, message);
			return;
		}
		await gateway
			.sendText(
				message.chatId,
				"本群还没有绑定到 Pi。Owner 在群里发送 /bind 即可绑定本群；也可带目录把群锚定到项目：/bind /path/to/project。",
				message.messageId,
			)
			.catch(() => undefined);
	}

	/** 把当前群登记为受管群并持久化；可同时绑定工作目录（对齐 easycodeclient 的 /bind <路径>）。 */
	private async bindManagedGroup(gateway: FeishuGateway, message: FeishuIncomingMessage): Promise<void> {
		const command = parseRemoteCommand(message.text);
		const dirArg = command?.args.trim();
		if (dirArg) {
			await this.bindGroupDirectory(gateway, message, dirArg);
			return;
		}
		if (this.managedGroupIds.has(message.chatId)) {
			const dir = this.getChatDirectory(message.chatId);
			await gateway
				.sendText(
					message.chatId,
					dir
						? `本群已绑定到 Pi（工作目录：${dir}）。直接 @机器人 即可提问（开通免 @ 权限后无需 @）。`
						: "本群已绑定到 Pi，直接 @机器人 即可提问（开通免 @ 权限后无需 @）。\n如需把本群锚定到项目目录，发送：/bind /path/to/project",
					message.messageId,
				)
				.catch(() => undefined);
			return;
		}
		this.managedGroupIds.add(message.chatId);
		await this.saveCredentials({ managedGroupIds: [...this.managedGroupIds] });
		await gateway
			.sendText(
				message.chatId,
				"✅ 本群已绑定到 Pi。下一条群消息会自动创建该群专属的独立 Pi 会话；默认需要 @机器人 触发。\n💡 如需让本群在指定项目目录下工作，发送：/bind /path/to/project",
				message.messageId,
			)
			.catch(() => undefined);
	}

	/** /bind <目录>：校验目录存在后，把群锚定到该目录（工作目录在会话切换时生效）。 */
	private async bindGroupDirectory(
		gateway: FeishuGateway,
		message: FeishuIncomingMessage,
		dirArg: string,
	): Promise<void> {
		const resolved = resolve(dirArg);
		let isDirectory = false;
		try {
			isDirectory = (await stat(resolved)).isDirectory();
		} catch {
			isDirectory = false;
		}
		if (!isDirectory) {
			await gateway
				.sendText(message.chatId, `❌ 目录不存在或不是文件夹：${resolved}\n用法：/bind /path/to/project`, message.messageId)
				.catch(() => undefined);
			return;
		}
		this.managedGroupIds.add(message.chatId);
		await this.saveCredentials({
			managedGroupIds: [...this.managedGroupIds],
			groupDirs: { ...(this.credentials?.groupDirs ?? {}), [message.chatId]: resolved },
		});
		await gateway
			.sendText(
				message.chatId,
				`✅ 本群已锚定到目录：${resolved}\n下一条群消息会在该目录下的独立 Pi 会话中处理（已有会话也会切换工作目录）。`,
				message.messageId,
			)
			.catch(() => undefined);
	}

	/** 群绑定的项目目录；未绑定的群返回 undefined（沿用当前 cwd）。 */
	getChatDirectory(chatId: string): string | undefined {
		return this.credentials?.groupDirs?.[chatId];
	}

	/** 所有已绑定的群目录（用于 project trust 自动放行）。 */
	getBoundDirectories(): string[] {
		return Object.values(this.credentials?.groupDirs ?? {});
	}

	/** Controller 自己处理的命令；返回 false 时回落到通用远程命令通道。 */
	private async runManagedChatCommand(
		gateway: FeishuGateway,
		message: FeishuIncomingMessage,
		reactionId: string,
		command: ParsedRemoteCommand,
	): Promise<boolean> {
		switch (command.name) {
			case "/bind":
				await this.handleGroupBind(gateway, message, reactionId);
				return true;
			case "/allow":
				await this.handleAllowChange(gateway, message, reactionId, command.args, true);
				return true;
			case "/deny":
				await this.handleAllowChange(gateway, message, reactionId, command.args, false);
				return true;
			case "/allowlist":
				await this.handleAllowlistShow(gateway, message, reactionId);
				return true;
			default:
				return false;
		}
	}

	private async handleGroupBind(
		gateway: FeishuGateway,
		message: FeishuIncomingMessage,
		reactionId: string,
	): Promise<void> {
		if (message.chatType !== "group") {
			await this.acknowledge(
				gateway,
				message,
				reactionId,
				"/bind 用于绑定群聊：请在需要使用的群里直接发送 /bind。私聊始终可用，无需绑定。",
			);
			return;
		}
		// 受管群走到这里说明已经绑定过；未托管群的 /bind 在未托管分支处理。
		await this.acknowledge(
			gateway,
			message,
			reactionId,
			"本群已绑定到 Pi，直接 @机器人 即可提问（开通免 @ 权限后无需 @）。",
		);
	}

	private async handleAllowChange(
		gateway: FeishuGateway,
		message: FeishuIncomingMessage,
		reactionId: string,
		args: string,
		grant: boolean,
	): Promise<void> {
		const credentials = this.credentials;
		const ownerOpenId = this.binding?.ownerOpenId;
		if (!credentials || !ownerOpenId) return;
		const target = resolveAllowTarget(args, message.mentions);
		if (!target) {
			await this.acknowledge(
				gateway,
				message,
				reactionId,
				grant ? "请 @ 要授权的成员，例如：/allow @张三。" : "请 @ 要移除授权的成员，例如：/deny @张三。",
			);
			return;
		}
		if (target.openId === ownerOpenId) {
			await this.acknowledge(gateway, message, reactionId, "该成员已是 Owner，无需加入授权列表。");
			return;
		}
		const allowlist = new Set(credentials.allowlist ?? []);
		const names = { ...(credentials.allowlistNames ?? {}) };
		const label = target.name ?? target.openId;
		if (grant) {
			if (allowlist.has(target.openId)) {
				if (target.name) names[target.openId] = target.name;
				await this.saveCredentials({ allowlistNames: names });
				await this.acknowledge(gateway, message, reactionId, `${label} 已在授权列表中。`);
				return;
			}
			allowlist.add(target.openId);
			if (target.name) names[target.openId] = target.name;
			await this.saveCredentials({ allowlist: [...allowlist], allowlistNames: names });
			await this.acknowledge(
				gateway,
				message,
				reactionId,
				`✅ 已授权 ${label}，TA 现在可以在私聊和已绑定群中使用机器人。`,
			);
			return;
		}
		if (!allowlist.delete(target.openId)) {
			await this.acknowledge(gateway, message, reactionId, `${label} 不在授权列表中。`);
			return;
		}
		delete names[target.openId];
		await this.saveCredentials({ allowlist: [...allowlist], allowlistNames: names });
		await this.acknowledge(gateway, message, reactionId, `已移除授权：${label}。`);
	}

	private async handleAllowlistShow(
		gateway: FeishuGateway,
		message: FeishuIncomingMessage,
		reactionId: string,
	): Promise<void> {
		const credentials = this.credentials;
		if (!credentials) return;
		const names = credentials.allowlistNames ?? {};
		const entries = (credentials.allowlist ?? []).map((openId) =>
			names[openId] ? `${names[openId]}（${openId}）` : openId,
		);
		const text =
			entries.length > 0
				? `当前授权成员：\n${entries.map((entry) => `- ${entry}`).join("\n")}`
				: "当前没有授权成员，仅 Owner 可使用。可用 /allow @成员 添加。";
		await this.acknowledge(gateway, message, reactionId, text);
	}

	/** 汇总受管群、授权列表等内存态并落盘。 */
	private async saveCredentials(patch: Partial<FeishuCredentials>): Promise<void> {
		const credentials = this.credentials;
		if (!credentials) return;
		const updated: FeishuCredentials = { ...credentials, ...patch };
		await this.store.save(updated);
		this.credentials = updated;
	}

	/** Bot 被拉进未托管的新群：私聊 Owner 发绑定引导 + 群聊权限体检。 */
	private async handleBotAdded(event: FeishuBotAddedEvent): Promise<void> {
		const gateway = this.gateway;
		const credentials = this.credentials;
		const ownerOpenId = this.binding?.ownerOpenId;
		if (!gateway || !credentials || !ownerOpenId) return;
		if (this.managedGroupIds.has(event.chatId)) return;

		let groupName = "";
		try {
			groupName = (await gateway.getChatInfo?.(event.chatId))?.name ?? "";
		} catch {
			groupName = "";
		}
		let grantedScopes: string[] | undefined;
		try {
			grantedScopes = (await gateway.probeGrantedScopes?.())?.grantedScopes;
		} catch {
			grantedScopes = undefined;
		}
		const guidance = buildBotAddedGuidance({
			groupName: groupName || "未命名群聊",
			appId: credentials.appId,
			...(grantedScopes ? { grantedScopes } : {}),
		});
		await gateway.sendText(ownerOpenId, guidance).catch(() => undefined);
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

	/**
	 * 等待本地 Pi 空闲。超过 localBusyTimeoutMs 仍繁忙则放弃（返回 false），
	 * 等待超过 3 秒时先给聊天发一条提示，让用户知道消息没有丢。
	 */
	private async waitForLocalIdle(gateway: FeishuGateway, message: FeishuIncomingMessage): Promise<boolean> {
		const runtime = this.runtime;
		if (!runtime) return true;
		const start = Date.now();
		let notified = false;
		for (;;) {
			if (this.stopped || this.gateway !== gateway) return false;
			let idle: boolean;
			try {
				idle = runtime.isIdle();
			} catch {
				idle = true; // 忙闲未知（ctx 失效等）时不得阻塞消息处理。
			}
			if (idle) return true;
			const waitedMs = Date.now() - start;
			if (waitedMs > this.localBusyTimeoutMs) return false;
			if (!notified && waitedMs > this.busyNotifyAfterMs) {
				notified = true;
				await gateway
					.sendText(
						message.chatId,
						"⏳ 本地 Pi 正在执行任务，本条消息将在其完成后处理（不会打断本地任务）。",
						message.messageId,
					)
					.catch(() => undefined);
			}
			await sleep(this.idlePollMs);
		}
	}

	private async processWithAgent(gateway: FeishuGateway, message: FeishuIncomingMessage, text: string): Promise<void> {
		if (this.gateway !== gateway) return;
		// Pi 是单会话进程：本地 TUI 正在跑的任务会被会话切换 abort 掉。
		// 因此驱动 Pi 之前先等本地空闲，绝不打断用户手头的工作。
		if (!(await this.waitForLocalIdle(gateway, message))) {
			await gateway
				.sendText(message.chatId, "⏳ 本地 Pi 长时间繁忙，本条消息已取消处理，请稍后重发。", message.messageId)
				.catch(() => undefined);
			return;
		}
		const reply = await gateway.beginReply(message.chatId, message.messageId).catch(() => undefined);
		if (reply) this.activeReplies.add(reply);
		let latestText = "";
		try {
			const response = await this.agent.run(
				buildAgentPrompt(message, text),
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
		} catch (error) {
			if (this.gateway === gateway) {
				// 把真实失败原因带回去（已脱敏），而不是笼统的"处理失败"。
				const reason = this.sanitizeError(error);
				if (reply) {
					await reply.fail(reason);
				} else {
					await this.safeSend(gateway, message, `处理消息失败：${reason}`);
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
		const runtime = this.runtime;
		const replyText = await executeRemoteCommand(text, {
			runtime,
			status: () => this.status(this.environment),
			stopQueue: () => this.stopQueuedMessages(gateway),
			...(message.chatType === "group" ? { chatId: message.chatId } : {}),
			...(runtime?.newChatSession ? { newChatSession: runtime.newChatSession.bind(runtime) } : {}),
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
