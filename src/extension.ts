import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ProjectTrustEventResult,
	ProjectTrustHandler,
} from "@earendil-works/pi-coding-agent";

/** switchSession/withSession 回调里的新会话上下文；Pi 未从包根导出该类型名，从签名提取。 */
type SwitchCallback = NonNullable<
	Parameters<ExtensionCommandContext["switchSession"]>[1] extends infer O | undefined
		? O extends { withSession?: (ctx: infer C) => unknown }
			? C
			: never
		: never
>;
type WithSessionCallback = (ctx: SwitchCallback) => Promise<void>;
import { Type } from "typebox";
import type { AgentBridge, FeishuStatus, PiModelInfo, PiRuntime, PiRuntimeSnapshot } from "./contracts.js";
import { FeishuController } from "./controller.js";
import { CredentialError, FileCredentialStore } from "./credentials.js";
import { SdkFeishuGateway, validateSdkCredentials } from "./gateway.js";
import { PiAgentBridge } from "./pi-agent-bridge.js";
import { THINKING_LEVELS } from "./remote-commands.js";
import {
	buildEventSubUrl,
	buildPermissionPageUrl,
	buildScopeApplyUrl,
	buildScopeHealthSection,
	hasScope,
	missingScopes,
	REQUIRED_APP_SCOPES,
	SENSITIVE_GROUP_MSG_SCOPE,
} from "./scopes.js";

type FeishuCommandName = "help" | "setup" | "start" | "stop" | "status" | "logout";
type PiModel = NonNullable<ExtensionContext["model"]>;
type PiThinkingLevel = NonNullable<ExtensionContext["thinkingLevel"]>;

interface SessionLink {
	runtime: PiRuntime;
}

interface SharedFeishuState {
	controller: FeishuController;
	current: SessionLink | undefined;
	activeBridge: PiAgentBridge | undefined;
	latestCommandContext: ExtensionCommandContext | undefined;
	sendCurrentMessage: ((text: string, options?: { deliverAs?: "steer" | "followUp" }) => void) | undefined;
	/** Pi 会话文件：p2p 私聊消息归属的主会话（绝不会是群绑定会话）。 */
	mainSessionFile: string | undefined;
	/** Pi 进程当前所在的会话文件，随每个事件刷新。 */
	currentSessionFile: string | undefined;
	/**
	 * 本扩展发起的 switch/newSession 进行中的标记：
	 * - 期间出现的会话文件不得记为主会话；
	 * - Pi 对旧会话发出的 session_shutdown 是我们自己引起的，
	 *   不能据此取消正在等待的飞书轮次（否则群消息必然失败）。
	 */
	switchingSession: boolean;
}

const SHARED_STATE_KEY = "__piFeishuSharedState__";

/**
 * Pi 会在每次会话切换（含远程 /new）后重新执行扩展工厂并重新求值模块，
 * 因此只有挂在 globalThis 上的状态能跨会话存活：长连接、凭据和队列都在
 * 这里，工厂重跑时只替换当前会话的 bridge/runtime。
 */
function getSharedState(): SharedFeishuState {
	const host = globalThis as typeof globalThis & { [SHARED_STATE_KEY]?: SharedFeishuState };
	const existing = host[SHARED_STATE_KEY];
	if (existing) return existing;

	const state: SharedFeishuState = {
		current: undefined,
		activeBridge: undefined,
		latestCommandContext: undefined,
		sendCurrentMessage: undefined,
		mainSessionFile: undefined,
		currentSessionFile: undefined,
		switchingSession: false,
		controller: undefined as unknown as FeishuController,
	};
	const proxyAgent: AgentBridge = {
		run: (text, observer, options) => {
			const bridge = new PiAgentBridge(async (prompt) => {
				if (options?.chatId) {
					await sendToChatSession(state, options.chatId, prompt);
					return;
				}
				await sendToMainSession(state, prompt);
			});
			state.activeBridge = bridge;
			return bridge.run(text, observer).finally(() => {
				if (state.activeBridge === bridge) state.activeBridge = undefined;
			});
		},
		cancel: (reason) => state.activeBridge?.cancel(reason),
		steer: (text) => {
			// 仅当确有飞书轮次在跑时并入：发到当前活跃会话（轮次就在那里），绝不触发会话切换。
			if (!state.activeBridge || !state.sendCurrentMessage) return false;
			state.sendCurrentMessage(text, { deliverAs: "steer" });
			return true;
		},
	};
	const proxyRuntime: PiRuntime = {
		isIdle: () => state.current?.runtime.isIdle() ?? true,
		abort: () => state.current?.runtime.abort(),
		compact: () => state.current?.runtime.compact(),
		newSession: () => state.current?.runtime.newSession() ?? Promise.resolve(false),
		newChatSession: async (chatId) => {
			const context = state.latestCommandContext;
			if (!context) return false;
			state.switchingSession = true;
			try {
				const result = await context.newSession({
					withSession: async (nextContext) => {
						state.latestCommandContext = nextContext;
						const sessionFile = nextContext.sessionManager.getSessionFile();
						if (sessionFile) await state.controller.setChatSessionFile(chatId, sessionFile);
					},
				});
				return !result.cancelled;
			} finally {
				state.switchingSession = false;
			}
		},
		setThinkingLevel: (level) => state.current?.runtime.setThinkingLevel(level) ?? Promise.resolve(false),
		listModels: () => state.current?.runtime.listModels() ?? [],
		switchModel: async (query) => {
			const link = state.current;
			if (!link) throw new Error("Pi 会话尚未就绪，请稍后再试。");
			return link.runtime.switchModel(query);
		},
		snapshot: () => state.current?.runtime.snapshot() ?? { streaming: false },
	};
	state.controller = new FeishuController({
		store: new FileCredentialStore(),
		gatewayFactory: (credentials) => new SdkFeishuGateway(credentials),
		validateCredentials: validateSdkCredentials,
		agent: proxyAgent,
		runtime: proxyRuntime,
	});
	host[SHARED_STATE_KEY] = state;
	return state;
}

/** 记录事件带来的会话文件：群绑定会话不记为主会话。 */
function observeSessionFile(state: SharedFeishuState, context: ExtensionContext): void {
	const file = tryGetSessionFile(context);
	if (!file) return;
	state.currentSessionFile = file;
	if (state.switchingSession) return;
	if (state.controller.isGroupSessionFile(file)) return;
	state.mainSessionFile = file;
}

function tryGetSessionFile(context: ExtensionContext): string | undefined {
	try {
		return context.sessionManager.getSessionFile();
	} catch {
		// 会话切换后捕获的 ctx 会失效，等下一个事件刷新即可。
		return undefined;
	}
}

/**
 * p2p 私聊消息永远落在主会话：群消息处理会把 Pi 切进群的会话，
 * 这里负责在下一条私聊到来时切回去，避免把 Owner 的提问发进群会话。
 */
async function sendToMainSession(state: SharedFeishuState, prompt: string): Promise<void> {
	const main = state.mainSessionFile;
	const current = state.currentSessionFile;
	const ready = Boolean(state.current && state.sendCurrentMessage);
	if (!main || !current || current === main || !ready) {
		if (!state.current) throw new Error("Pi 会话尚未就绪，请稍后再试。");
		if (!state.sendCurrentMessage) throw new Error("Pi 会话尚未就绪，请稍后再试。");
		state.sendCurrentMessage(prompt);
		return;
	}
	const context = state.latestCommandContext;
	if (!context) {
		// 主会话与当前会话不一致却没有命令上下文：直发会串进群会话，给出可操作的错误更安全。
		throw new Error("Pi 会话控制尚未就绪，请先在本地执行一次 /feishu status。");
	}
	state.switchingSession = true;
	try {
		const result = await context.switchSession(main, {
			withSession: async (nextContext) => {
				state.latestCommandContext = nextContext;
				await nextContext.sendUserMessage(prompt);
			},
		});
		if (result.cancelled) throw new Error("切回主 Pi 会话已取消。");
	} finally {
		state.switchingSession = false;
	}
}

async function sendToChatSession(state: SharedFeishuState, chatId: string, prompt: string): Promise<void> {
	const context = state.latestCommandContext;
	if (!context) throw new Error("Pi 会话控制尚未就绪，请先在本地执行一次 /feishu status。");

	const directory = state.controller.getChatDirectory(chatId);
	state.switchingSession = true;
	try {
		const sessionFile = state.controller.getChatSessionFile(chatId);
		if (sessionFile) {
			const result = await switchWithDirectory(context, sessionFile, directory, (nextContext) =>
				sendAndTrackGroupSession(state, chatId, sessionFile, nextContext, prompt),
			);
			if (result.cancelled) throw new Error("切换到飞书群绑定的 Pi 会话已取消。");
			return;
		}

		const result = await context.newSession({
			withSession: async (nextContext) => {
				state.latestCommandContext = nextContext;
				const currentFile = nextContext.sessionManager.getSessionFile();
				if (currentFile) await state.controller.setChatSessionFile(chatId, currentFile);
				if (directory) {
					// 新会话默认继承当前 cwd：显式重新锚定到绑定目录，再投递消息。
					const anchored = await switchWithDirectory(nextContext, currentFile ?? "", directory, (finalContext) => {
						state.latestCommandContext = finalContext;
						return finalContext.sendUserMessage(prompt);
					});
					if (anchored.cancelled) throw new Error("锚定群会话工作目录已取消。");
					return;
				}
				await nextContext.sendUserMessage(prompt);
			},
		});
		if (result.cancelled) throw new Error("创建飞书群专属 Pi 会话已取消。");
	} finally {
		state.switchingSession = false;
	}
}

/**
 * 切换会话并在切换完成后（含目录锚定）执行回调。
 * Pi 的命令上下文 d.ts 未声明 cwdOverride，但三种运行模式的 switchSession handler
 * 都会把 options 原样转发给 runtime，而 runtime 完整支持 override（切换后
 * createRuntime 直接使用 override 后的 cwd）。这里做一次窄化并在切换后校验
 * cwd 生效——若未来 Pi 改为丢弃该参数，会得到可操作的错误而不是静默串目录。
 */
async function switchWithDirectory(
	context: ExtensionCommandContext,
	sessionFile: string,
	directory: string | undefined,
	withSession: WithSessionCallback,
): Promise<{ cancelled: boolean }> {
	if (!directory) {
		return context.switchSession(sessionFile, { withSession });
	}
	const options = { cwdOverride: directory, withSession };
	const switcher = context.switchSession as unknown as (
		path: string,
		options: { cwdOverride: string; withSession: WithSessionCallback },
	) => Promise<{ cancelled: boolean }>;
	const result = await switcher.call(context, sessionFile, options);
	if (!result.cancelled) {
		const effectiveCwd = safeCwd(context);
		if (effectiveCwd && effectiveCwd !== directory) {
			throw new Error(
				`群会话未能切换到绑定目录（当前：${effectiveCwd}）。请重启本地 Pi 后重试，或在本地执行 /feishu status 刷新会话控制。`,
			);
		}
	}
	return result;
}

function safeCwd(context: ExtensionContext): string | undefined {
	try {
		return context.cwd;
	} catch {
		return undefined;
	}
}

async function sendAndTrackGroupSession(
	state: SharedFeishuState,
	chatId: string,
	sessionFile: string,
	nextContext: SwitchCallback,
	prompt: string,
): Promise<void> {
	state.latestCommandContext = nextContext;
	const currentFile = nextContext.sessionManager.getSessionFile();
	if (currentFile && currentFile !== sessionFile) await state.controller.setChatSessionFile(chatId, currentFile);
	await nextContext.sendUserMessage(prompt);
}

export interface ParsedFeishuCommand {
	name: FeishuCommandName;
	args: string;
}

export function parseFeishuCommand(input: string): ParsedFeishuCommand {
	const trimmed = input.trim();
	if (!trimmed || trimmed === "help") return { name: "help", args: "" };

	const separator = trimmed.search(/\s/);
	const rawName = separator === -1 ? trimmed : trimmed.slice(0, separator);
	let args = separator === -1 ? "" : trimmed.slice(separator).trim();
	if (!isCommandName(rawName)) {
		throw new CredentialError(`未知子命令：${rawName}。请执行 /feishu 查看帮助。`);
	}
	if (rawName !== "setup" && args) {
		throw new CredentialError(`/feishu ${rawName} 不接受参数。`);
	}
	if (rawName === "setup" && args.startsWith("--manual")) {
		args = args.slice("--manual".length).trim();
	}
	return { name: rawName, args };
}

export function renderFeishuHelp(): string {
	return [
		"Pi Feishu：通过飞书私聊使用当前 Pi 会话",
		"",
		"命令：",
		"  /feishu",
		"  /feishu setup [<appId> <appSecret>]",
		"  /feishu start",
		"  /feishu stop",
		"  /feishu status",
		"  /feishu logout",
		"",
		"推荐通过 FEISHU_APP_ID、FEISHU_APP_SECRET 提供凭据，然后执行 /feishu setup。",
	].join("\n");
}

/** 对齐 easycodeclient：start 成功后的仪表盘式提示。 */
export function renderStartSuccess(status: FeishuStatus, bindingCode?: string): string {
	const lines: string[] = ["🚀 飞书 Bot 已就绪！"];
	if (status.appId) lines.push(`  App ID：${status.appId}`);
	lines.push("  连接：WebSocket 长连接已建立");
	if (bindingCode) {
		lines.push(`  Owner：未绑定，一次性绑定码 ${bindingCode}`);
		lines.push(`  请在飞书私聊 Bot 发送：/bind ${bindingCode}`);
	} else if (status.ownerOpenId) {
		lines.push(`  Owner：${status.ownerOpenId}`);
	}
	lines.push("", "  现在去飞书给 Bot 发消息试试 👋", "  输入 /feishu stop 停止");
	return lines.join("\n");
}

/** 对齐 easycodeclient：缺少凭据时给出可操作的配置指引。 */
export function renderMissingCredentials(): string {
	return [
		"⚠️ 未找到飞书凭证，请先配置：",
		"  /feishu setup <appId> <appSecret>    # 验证并保存凭据",
		"  或设置环境变量 FEISHU_APP_ID / FEISHU_APP_SECRET 后执行 /feishu setup",
	].join("\n");
}

/**
 * 对齐 easycodeclient 的 appendPostSetupGuidance：setup 成功后的分步配置引导。
 * grantedScopes 为 undefined 表示无法读取已开通列表（首次配置很常见），按全部缺失处理。
 */
export function renderPostSetupGuidance(appId: string, grantedScopes?: string[]): string {
	const missing = grantedScopes ? missingScopes(grantedScopes, REQUIRED_APP_SCOPES) : [...REQUIRED_APP_SCOPES];
	const lines: string[] = [
		"",
		"━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
		"🔧 一键完成下一步配置（强烈建议）",
		"━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
	];

	if (grantedScopes && missing.length === 0) {
		lines.push("  ✅ 应用已开通全部必需 scope，无需额外申请。");
	} else {
		lines.push(
			grantedScopes
				? `  📋 第 1 步：一键申请缺失的 ${missing.length} 项权限（自动预选 scope）`
				: "  📋 第 1 步：一键申请应用所需权限（自动预选 scope）",
			`     👉 ${buildScopeApplyUrl({ appId, scopes: missing })}`,
		);
		if (missing.length > 0 && missing.length <= 12) {
			lines.push("     需申请的 scope：");
			for (const scope of missing) lines.push(`       - ${scope}`);
		}
	}

	lines.push(
		"",
		"  📡 第 2 步：在事件订阅页勾选必要事件",
		`     👉 ${buildEventSubUrl(appId)}`,
		"     需订阅事件：",
		"       - im.message.receive_v1（接收私聊和群聊消息）",
		"       - im.chat.member.bot.added_v1（被拉入群通知 → 私聊你发送绑定引导）",
		"       - （可选）im.message.reactions 相关事件用于取消排队消息",
		"",
		"  🔄 第 3 步：申请发布版本",
		"     在权限管理页申请版本发布，让 scope 生效：",
		`     👉 ${buildPermissionPageUrl(appId)}`,
		"",
	);

	// 🔔 免 @ 敏感权限提示
	if (!grantedScopes || !hasScope(grantedScopes, SENSITIVE_GROUP_MSG_SCOPE)) {
		lines.push(
			"━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
			"💬 想让 Bot 在群里「免 @ 直接响应所有消息」？",
			"━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
			"  默认：群里只有 @bot 时才会收到事件（飞书平台层硬规则）。",
			"  要免 @ 直接响应，必须额外申请「敏感权限」：",
			`     👉 ${buildScopeApplyUrl({ appId, scopes: [SENSITIVE_GROUP_MSG_SCOPE] })}`,
			`     权限：\`${SENSITIVE_GROUP_MSG_SCOPE}\` —— 「读取关联群聊内所有消息」`,
			"  ⚠️ 这是飞书的敏感权限，需要人工审核（一般 1-3 天）。",
			"  申请页「使用场景说明」可参考：用于 AI 编程助手在专属项目协作群中",
			"  无需 @ 即可响应团队成员的编程请求和问题，提升协作效率。",
			"",
		);
	}
	lines.push("  💡 步骤 1-3 完成后，回到 Pi 执行 /feishu start 即可使用！");
	return lines.join("\n");
}

/**
 * 对齐 easycodeclient 的 start 后权限健康检查：probe 权限并追加修复指引。
 * probe 失败不阻塞主流程，返回原文案。
 */
export async function appendScopeHealthHint(
	appId: string,
	dashboard: string,
	grantedScopes?: string[],
): Promise<string> {
	const section = buildScopeHealthSection(appId, grantedScopes);
	if (!section) return dashboard;
	return `${dashboard}\n\n${section}`;
}

export function renderFeishuStatus(status: FeishuStatus, scopeHealth?: string[]): string {
	if (!status.configured) {
		return [
			"📊 飞书状态:",
			"  配置：未配置，请运行 /feishu setup",
			`  连接：${status.running ? "🟢 运行中" : "🔴 已停止"}`,
			`  队列：${status.pendingMessages}`,
		].join("\n");
	}
	const lines = [
		"📊 飞书状态:",
		"  配置：✅ 已配置",
		`  App ID：${status.appId ?? "未知"}`,
		`  来源：${status.source === "environment" ? "环境变量" : "凭据文件"}`,
		`  连接：${status.running ? "🟢 运行中" : "🔴 已停止"}`,
		`  Owner：${status.ownerOpenId ?? "未绑定"}`,
		`  队列：${status.pendingMessages}`,
	];
	// ✨ Mini-doctor：scope 健康度自检（对齐 easycodeclient 的 /feishu status）。
	if (scopeHealth) {
		lines.push("");
		if (scopeHealth.length === 0) {
			lines.push("  ✅ 应用权限：已开通全部必需 scope");
		} else {
			lines.push(`  ⚠️ 应用权限：缺失 ${scopeHealth.length} 项必需 scope`);
			for (const scope of scopeHealth) lines.push(`       - ${scope}`);
		}
	}
	if (!status.running) lines.push("  运行 /feishu start 启动 Bot");
	return lines.join("\n");
}

export default function feishuExtension(pi: ExtensionAPI): void {
	const state = getSharedState();
	state.sendCurrentMessage = (text, options) => pi.sendUserMessage(text, options);
	let latestContext: ExtensionContext | undefined;
	let latestCommandContext: ExtensionCommandContext | undefined;

	const runtime: PiRuntime = {
		isIdle: () => withRuntimeContext(() => latestContext?.isIdle()) ?? true,
		abort: () => withRuntimeContext(() => latestContext?.abort()),
		compact: () => withRuntimeContext(() => latestContext?.compact()),
		newSession: async () => {
			const context = latestCommandContext ?? state.latestCommandContext;
			if (!context) return false;
			try {
				const result = await context.newSession();
				return !result.cancelled;
			} catch {
				return false;
			}
		},
		setThinkingLevel: async (level) => {
			if (!isThinkingLevel(level)) return false;
			try {
				pi.setThinkingLevel(level);
				return true;
			} catch {
				return false;
			}
		},
		listModels: () => {
			return availableModels(latestContext).map(toModelInfo);
		},
		switchModel: async (query) => {
			const model = resolveModel(query, latestContext);
			try {
				const applied = await pi.setModel(model);
				if (!applied) throw new Error(`模型 ${model.name} 缺少可用的 API Key。`);
			} catch (error) {
				throw error instanceof Error ? error : new Error(String(error));
			}
			return toModelInfo(model);
		},
		snapshot: () => {
			const model = latestContext?.model;
			const usage = withRuntimeContext(() => latestContext?.getContextUsage());
			const snapshot: PiRuntimeSnapshot = {
				streaming: !(withRuntimeContext(() => latestContext?.isIdle()) ?? true),
			};
			if (model) snapshot.model = model.name || model.id;
			if (latestContext?.thinkingLevel) snapshot.thinkingLevel = latestContext.thinkingLevel;
			if (typeof usage?.percent === "number") snapshot.contextPercent = usage.percent;
			return snapshot;
		},
	};
	state.current = { runtime };

	let startupNoticeShown = false;
	const maybeNotifyFeishuStartup = async (context: ExtensionContext): Promise<void> => {
		if (startupNoticeShown) return;
		startupNoticeShown = true;
		const status = await state.controller.status(process.env);
		if (!status.configured || status.running) return;
		if (shouldAutoStartFeishu(process.env)) {
			const result = await state.controller.start(process.env);
			// 凭据就绪后复核主会话记录：启动时若恰好恢复在群绑定会话上，不能把它当成主会话。
			if (state.mainSessionFile && state.controller.isGroupSessionFile(state.mainSessionFile)) {
				state.mainSessionFile = undefined;
			}
			const dashboard = renderStartSuccess(await state.controller.status(process.env), result.bindingCode);
			context.ui.notify(
				dashboard.replace("🚀 飞书 Bot 已就绪！", "🚀 飞书插件已自动启动，Bot 已就绪！"),
				result.bindingCode ? "warning" : "info",
			);
			return;
		}
		context.ui.notify(
			"飞书插件已加载，但长连接未启动。请执行 /feishu start；如需 Pi 启动后自动连接，可设置 PI_FEISHU_AUTO_START=1。",
			"warning",
		);
	};

	// 每个事件都会带来新的 ExtensionContext；持续刷新，保证远程命令拿到的能力不失效。
	const trackContext = (_event: unknown, context: ExtensionContext): void => {
		latestContext = context;
		observeSessionFile(state, context);
	};
	pi.on("session_start", (event, context) => {
		trackContext(event, context);
		void maybeNotifyFeishuStartup(context).catch((error) => {
			context.ui.notify(`飞书启动检查失败：${state.controller.sanitizeError(error)}`, "error");
		});
	});
	pi.on("agent_start", trackContext);
	pi.on("message_end", (event, context) => {
		trackContext(event, context);
		state.activeBridge?.captureMessage(event.message);
	});
	pi.on("message_update", (event, context) => {
		trackContext(event, context);
		state.activeBridge?.captureStreamingMessage(event.message);
	});
	pi.on("tool_execution_start", (event, context) => {
		trackContext(event, context);
		state.activeBridge?.captureToolStart(event.toolName);
	});
	pi.on("tool_execution_end", (event, context) => {
		trackContext(event, context);
		state.activeBridge?.captureToolEnd();
	});
	pi.on("agent_settled", (event, context) => {
		trackContext(event, context);
		state.activeBridge?.settle();
	});
	pi.on("session_shutdown", () => {
		// 长连接归全局 controller 保管，本地 /new 切换会话后自动延续。
		// 本扩展为群/私聊路由发起的 switch/newSession 会让 Pi 对旧会话发 shutdown；
		// 那不是真正的会话关闭，此刻轮次刚要开始，绝不能取消，否则回复永远传不回飞书。
		if (state.switchingSession) return;
		state.activeBridge?.cancel("Pi 会话已关闭。");
	});

	// 对齐 easycodeclient：Owner 通过 /bind 或建群显式绑定的目录视为受信项目，
	// 免去切换群会话时的本地信任弹窗。undecided = 不表态，Pi 落回默认流程
	//（runner 对 undecided 的 handler 会跳过）；handler 用带注解的变量传入，
	// 内联箭头会让 on() 的重载推断失败。
	const onProjectTrust: ProjectTrustHandler = (event) => {
		if (state.controller.getBoundDirectories().includes(event.cwd)) {
			return { trusted: "yes", remember: true };
		}
		return { trusted: "undecided" };
	};
	pi.on("project_trust", onProjectTrust);

	pi.registerTool({
		name: "feishu_create_group",
		label: "Create Feishu Group",
		description:
			"Create a Feishu group chat and invite the currently bound owner. Use when asked to 拉群、建群、创建飞书群 or create a group. Pass `path` when the user mentions a directory (e.g. 拉个群 /path/to/project) to anchor the group's sessions to that working directory; the directory must already exist.",
		parameters: Type.Object({
			name: Type.String({ description: "Name for the new Feishu group chat" }),
			path: Type.Optional(
				Type.String({ description: "Absolute path of an existing local directory to anchor the group to" }),
			),
		}),
		async execute(_toolCallId, params) {
			const name = params.name.trim();
			try {
				const chatId = await state.controller.createGroupChat(name, params.path?.trim() || undefined);
				const anchored = params.path?.trim() ? `，并锚定到目录 ${params.path.trim()}` : "";
				return {
					content: [
						{
							type: "text",
							text: `群聊「${name}」已创建，群聊 ID：${chatId}${anchored}。已邀请当前绑定的飞书用户，并发送群欢迎消息。`,
						},
					],
					details: { chatId, name },
				};
			} catch (error) {
				return {
					content: [{ type: "text", text: `创建飞书群失败：${state.controller.sanitizeError(error)}` }],
					details: undefined,
				};
			}
		},
	});

	pi.registerCommand("feishu", {
		description: "配置和管理飞书私聊连接",
		handler: async (args, context) => {
			latestCommandContext = context;
			state.latestCommandContext = context;
			try {
				await handleFeishuCommand(parseFeishuCommand(args), state.controller, context);
				// 凭据就绪后复核主会话记录：启动时若记录发生在凭据加载之前，可能误记了群会话。
				if (state.mainSessionFile && state.controller.isGroupSessionFile(state.mainSessionFile)) {
					state.mainSessionFile = undefined;
				}
			} catch (error) {
				context.ui.notify(`飞书操作失败：${state.controller.sanitizeError(error)}`, "error");
			}
		},
	});
}

function availableModels(context: ExtensionContext | undefined): PiModel[] {
	const scoped = context?.scopedModels ?? [];
	if (scoped.length > 0) return scoped.map((entry) => entry.model);
	return withRuntimeContext(() => context?.modelRegistry.getAvailable()) ?? [];
}

function resolveModel(query: string, context: ExtensionContext | undefined): PiModel {
	const candidates = availableModels(context);
	const needle = query.trim().toLowerCase();
	if (!needle) throw new Error("请提供模型 ID 或名称，例如 /model sonnet。");
	if (candidates.length === 0) throw new Error("当前没有可用模型，请先在本地 Pi 配置模型或 API Key。");

	const exact = candidates.filter((model) => model.id.toLowerCase() === needle);
	if (exact.length === 1 && exact[0]) return exact[0];
	if (exact.length > 1) throw new Error(`“${query}”匹配到多个模型，请输入更完整的模型 ID。`);

	const fuzzy = candidates.filter(
		(model) => model.id.toLowerCase().includes(needle) || model.name.toLowerCase().includes(needle),
	);
	if (fuzzy.length === 1 && fuzzy[0]) return fuzzy[0];
	if (fuzzy.length === 0) throw new Error(`未找到匹配“${query}”的模型。`);
	throw new Error(
		`“${query}”匹配到多个模型：${fuzzy
			.slice(0, 3)
			.map((model) => model.id)
			.join("、")}…请输入更完整的模型 ID。`,
	);
}

function toModelInfo(model: PiModel): PiModelInfo {
	return { id: model.id, name: model.name || model.id, provider: String(model.provider) };
}

function shouldAutoStartFeishu(environment: NodeJS.ProcessEnv): boolean {
	const value = environment.PI_FEISHU_AUTO_START ?? environment.FEISHU_AUTO_START;
	return value === "1" || value?.toLowerCase() === "true" || value?.toLowerCase() === "yes";
}

function isThinkingLevel(value: string): value is PiThinkingLevel {
	return (THINKING_LEVELS as readonly string[]).includes(value);
}

function withRuntimeContext<T>(action: () => T): T | undefined {
	try {
		return action();
	} catch {
		// 会话切换后捕获的 ctx 会失效，等下一个事件刷新即可。
		return undefined;
	}
}

async function handleFeishuCommand(
	command: ParsedFeishuCommand,
	controller: FeishuController,
	context: ExtensionCommandContext,
): Promise<void> {
	switch (command.name) {
		case "help": {
			const status = await controller.status(process.env);
			context.ui.notify(`${renderFeishuHelp()}\n\n${renderFeishuStatus(status)}`, "info");
			return;
		}
		case "setup": {
			const status = await controller.status(process.env);
			if (status.running) {
				throw new CredentialError("请先执行 /feishu stop，再修改飞书凭据。");
			}
			const credentials = await controller.setup(command.args, process.env);
			context.ui.notify(`✅ 飞书凭据验证成功并已保存：${credentials.appId}`, "info");
			// 对齐 easycodeclient：setup 成功后输出分步配置引导（一键申请权限/事件订阅/发布版本）。
			context.ui.notify(renderPostSetupGuidance(credentials.appId), "info");
			// 并自动拉起长连接，省去手动 /feishu start。
			await handleFeishuCommand({ name: "start", args: "" }, controller, context);
			return;
		}
		case "start": {
			// 对齐 easycodeclient：未配置凭据时给出可操作的配置指引，而非报错。
			const precheck = await controller.status(process.env);
			if (!precheck.configured) {
				context.ui.notify(renderMissingCredentials(), "warning");
				return;
			}
			const result = await controller.start(process.env);
			if (result.alreadyRunning) {
				context.ui.notify("⚠️ 飞书 Bot 已在运行中。输入 /feishu stop 停止后再启动。", "info");
				return;
			}
			const postStart = await controller.status(process.env);
			let dashboard = renderStartSuccess(postStart, result.bindingCode);
			// 对齐 easycodeclient：start 后 probe 权限健康度，缺失时追加一键申请链接。
			const appId = controller.appId;
			if (appId) {
				const probe = await controller.probeScopes();
				dashboard = await appendScopeHealthHint(appId, dashboard, probe.grantedScopes);
			}
			context.ui.notify(dashboard, result.bindingCode ? "warning" : "info");
			return;
		}
		case "stop":
			context.ui.notify((await controller.stop()) ? "✅ 飞书长连接已停止。" : "⚠️ 飞书 Bot 未运行。", "info");
			return;
		case "status": {
			const status = await controller.status(process.env);
			// ✨ Mini-doctor：probe scope 健康度（失败不影响 status 输出）。
			let scopeHealth: string[] | undefined;
			const appId = controller.appId;
			if (status.configured && appId) {
				const probe = await controller.probeScopes();
				if (probe.grantedScopes) {
					scopeHealth = missingScopes(probe.grantedScopes, REQUIRED_APP_SCOPES);
				}
			}
			context.ui.notify(renderFeishuStatus(status, scopeHealth), "info");
			return;
		}
		case "logout": {
			if (context.hasUI) {
				const confirmed = await context.ui.confirm("退出飞书", "停止连接并清除本地飞书凭据？");
				if (!confirmed) return;
			}
			await controller.logout();
			context.ui.notify("飞书连接已停止，本地凭据和 Owner 绑定已清除。", "info");
		}
	}
}

function isCommandName(value: string): value is FeishuCommandName {
	return value === "setup" || value === "start" || value === "stop" || value === "status" || value === "logout";
}
