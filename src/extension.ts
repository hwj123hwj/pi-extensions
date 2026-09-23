import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentBridge, FeishuStatus, PiModelInfo, PiRuntime, PiRuntimeSnapshot } from "./contracts.js";
import { FeishuController } from "./controller.js";
import { CredentialError, FileCredentialStore } from "./credentials.js";
import { SdkFeishuGateway, validateSdkCredentials } from "./gateway.js";
import { PiAgentBridge } from "./pi-agent-bridge.js";
import { THINKING_LEVELS } from "./remote-commands.js";

type FeishuCommandName = "help" | "setup" | "start" | "stop" | "status" | "logout";
type PiModel = NonNullable<ExtensionContext["model"]>;
type PiThinkingLevel = NonNullable<ExtensionContext["thinkingLevel"]>;

interface SessionLink {
	bridge: PiAgentBridge;
	runtime: PiRuntime;
}

interface SharedFeishuState {
	controller: FeishuController;
	current: SessionLink | undefined;
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

	const state: SharedFeishuState = { current: undefined, controller: undefined as unknown as FeishuController };
	const proxyAgent: AgentBridge = {
		run: (text, observer) => {
			const link = state.current;
			if (!link) return Promise.reject(new Error("Pi 会话尚未就绪，请稍后再试。"));
			return link.bridge.run(text, observer);
		},
		cancel: (reason) => state.current?.bridge.cancel(reason),
	};
	const proxyRuntime: PiRuntime = {
		isIdle: () => state.current?.runtime.isIdle() ?? true,
		abort: () => state.current?.runtime.abort(),
		compact: () => state.current?.runtime.compact(),
		newSession: () => state.current?.runtime.newSession() ?? Promise.resolve(false),
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

export function renderFeishuStatus(status: FeishuStatus): string {
	if (!status.configured) {
		return [
			"飞书状态",
			"  配置：未配置",
			`  连接：${status.running ? "已连接" : "未连接"}`,
			`  队列：${status.pendingMessages}`,
		].join("\n");
	}
	return [
		"飞书状态",
		"  配置：已配置",
		`  App ID：${status.appId ?? "未知"}`,
		`  来源：${status.source === "environment" ? "环境变量" : "凭据文件"}`,
		`  连接：${status.running ? "已连接" : "未连接"}`,
		`  Owner：${status.ownerOpenId ?? "未绑定"}`,
		`  队列：${status.pendingMessages}`,
	].join("\n");
}

export default function feishuExtension(pi: ExtensionAPI): void {
	const state = getSharedState();
	const bridge = new PiAgentBridge((text) => pi.sendUserMessage(text));
	let latestContext: ExtensionContext | undefined;
	let latestCommandContext: ExtensionCommandContext | undefined;

	const runtime: PiRuntime = {
		isIdle: () => withRuntimeContext(() => latestContext?.isIdle()) ?? true,
		abort: () => withRuntimeContext(() => latestContext?.abort()),
		compact: () => withRuntimeContext(() => latestContext?.compact()),
		newSession: async () => {
			const context = latestCommandContext;
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
	state.current = { bridge, runtime };

	// 每个事件都会带来新的 ExtensionContext；持续刷新，保证远程命令拿到的能力不失效。
	const trackContext = (_event: unknown, context: ExtensionContext): void => {
		latestContext = context;
	};
	pi.on("session_start", trackContext);
	pi.on("agent_start", trackContext);
	pi.on("message_end", (event, context) => {
		trackContext(event, context);
		bridge.captureMessage(event.message);
	});
	pi.on("message_update", (event, context) => {
		trackContext(event, context);
		bridge.captureStreamingMessage(event.message);
	});
	pi.on("tool_execution_start", (event, context) => {
		trackContext(event, context);
		bridge.captureToolStart(event.toolName);
	});
	pi.on("tool_execution_end", (event, context) => {
		trackContext(event, context);
		bridge.captureToolEnd();
	});
	pi.on("agent_settled", (event, context) => {
		trackContext(event, context);
		bridge.settle();
	});
	pi.on("session_shutdown", () => {
		// 只解绑本会话的桥：长连接归全局 controller 保管，本地 /new 切换会话后自动延续。
		bridge.cancel("Pi 会话已关闭。");
	});

	pi.registerCommand("feishu", {
		description: "配置和管理飞书私聊连接",
		handler: async (args, context) => {
			latestCommandContext = context;
			try {
				await handleFeishuCommand(parseFeishuCommand(args), state.controller, context);
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
			context.ui.notify(`飞书凭据验证成功并已保存：${credentials.appId}`, "info");
			return;
		}
		case "start": {
			const result = await controller.start(process.env);
			if (result.alreadyRunning) {
				context.ui.notify("飞书长连接已经在运行。", "info");
				return;
			}
			if (result.bindingCode) {
				context.ui.notify(
					`飞书长连接已启动。\n一次性绑定码：${result.bindingCode}\n请在飞书私聊 Bot 发送：/bind ${result.bindingCode}`,
					"warning",
				);
			} else {
				context.ui.notify("飞书长连接已启动，Owner 已绑定。", "info");
			}
			return;
		}
		case "stop":
			context.ui.notify((await controller.stop()) ? "飞书长连接已停止。" : "飞书长连接未运行。", "info");
			return;
		case "status":
			context.ui.notify(renderFeishuStatus(await controller.status(process.env)), "info");
			return;
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
