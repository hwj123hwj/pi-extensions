import type { FeishuStatus, PiRuntime, PiRuntimeSnapshot } from "./contracts.js";

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export const REMOTE_SLASH_COMMANDS: Record<string, string> = {
	"/help": "显示远程命令帮助",
	"/new": "新建 Pi 会话（丢弃当前对话上下文；群聊中重置该群绑定的会话）",
	"/stop": "中止当前任务，并跳过排队中的消息",
	"/status": "查看飞书连接与 Pi 运行状态",
	"/compact": "压缩当前会话上下文",
	"/thinking": "查看或设置思考档位：/thinking [off|minimal|low|medium|high|xhigh|max]",
	"/model": "查看当前模型，或切换：/model <模型ID或名称>",
	"/bind": "（仅群聊）把当前群绑定到 Pi 并创建独立会话",
	"/allow": "（仅 Owner）授权成员：/allow @成员；无参数时列出授权列表",
	"/deny": "（仅 Owner）移除授权：/deny @成员",
	"/allowlist": "（仅 Owner）查看当前授权成员",
};

export interface ParsedRemoteCommand {
	name: string;
	args: string;
}

export interface RemoteCommandContext {
	runtime: PiRuntime | undefined;
	status: () => Promise<FeishuStatus>;
	/** Aborts queued messages after the current one; returns how many were skipped. */
	stopQueue?: () => number;
	/** Chat the command was sent from; group-scoped commands use it. */
	chatId?: string;
	/** Creates a fresh session for the chat-bound session of a group. */
	newChatSession?: (chatId: string) => Promise<boolean>;
}

export function parseRemoteCommand(input: string): ParsedRemoteCommand | undefined {
	const trimmed = input.trim();
	if (!trimmed.startsWith("/")) return undefined;
	const separator = trimmed.search(/\s/);
	const name = separator === -1 ? trimmed : trimmed.slice(0, separator);
	const args = separator === -1 ? "" : trimmed.slice(separator + 1).trim();
	return { name: name.toLowerCase(), args };
}

export function renderRemoteHelp(): string {
	const lines = Object.entries(REMOTE_SLASH_COMMANDS).map(([name, description]) => `  ${name} — ${description}`);
	return ["飞书远程命令：", ...lines, "", "其余消息会直接发送给当前 Pi 会话处理。"].join("\n");
}

export function renderRemoteStatus(status: FeishuStatus, snapshot: PiRuntimeSnapshot | undefined): string {
	const lines = ["飞书状态", `  连接：${status.running ? "已连接" : "未连接"}`, `  队列：${status.pendingMessages}`];
	if (status.configured) {
		lines.push(`  Owner：${status.ownerOpenId ? "已绑定" : "未绑定"}`);
		lines.push("Pi 状态");
		lines.push(`  模型：${snapshot?.model ?? "未知"}`);
		lines.push(`  思考：${snapshot?.thinkingLevel ?? "未知"}`);
		lines.push(`  上下文：${formatContextPercent(snapshot?.contextPercent)}`);
		lines.push(`  运行：${snapshot?.streaming ? "运行中" : "空闲"}`);
	}
	return lines.join("\n");
}

export async function executeRemoteCommand(input: string, context: RemoteCommandContext): Promise<string> {
	const command = parseRemoteCommand(input);
	if (!command) return unknownCommandReply(input);
	switch (command.name) {
		case "/help":
			return renderRemoteHelp();
		case "/status": {
			const status = await context.status();
			return renderRemoteStatus(status, context.runtime?.snapshot());
		}
		case "/stop":
			return executeStop(context);
		case "/compact":
			return executeCompact(context.runtime);
		case "/new":
			return executeNewSession(context);
		case "/thinking":
			return executeThinking(command.args, context.runtime);
		case "/model":
			return executeModel(command.args, context.runtime);
		default:
			return unknownCommandReply(command.name);
	}
}

function executeStop(context: RemoteCommandContext): string {
	const runtime = context.runtime;
	const running = Boolean(runtime && !runtime.isIdle());
	if (running) runtime?.abort();
	const skipped = context.stopQueue?.() ?? 0;
	if (!running && skipped === 0) return "当前没有正在运行的 Pi 任务。";
	const suffix = skipped > 0 ? `，并跳过队列中的 ${skipped} 条消息` : "";
	return `已发送中止信号${suffix}。`;
}

function executeCompact(runtime: PiRuntime | undefined): string {
	if (!runtime) return "Pi 运行时尚未就绪，请稍后再试。";
	runtime.compact();
	return "已开始压缩上下文，完成后继续对话即可。";
}

async function executeNewSession(context: RemoteCommandContext): Promise<string> {
	const { runtime } = context;
	if (context.chatId && context.newChatSession) {
		const created = await context.newChatSession(context.chatId);
		return created
			? "已为该群新建独立的 Pi 会话，接下来是一个全新的对话。"
			: "新建会话未完成（本地已取消或暂不可用）。请先在本地 Pi 执行 /feishu 命令后重试。";
	}
	if (!runtime) return "远程新建会话暂不可用：请先在本地 Pi 执行任意 /feishu 命令，再通过飞书发送 /new。";
	const created = await runtime.newSession();
	return created
		? "已新建 Pi 会话，接下来是一个全新的对话。"
		: "新建会话未完成（本地已取消或暂不可用）。请在本地 Pi 执行 /feishu 命令后重试。";
}

async function executeThinking(args: string, runtime: PiRuntime | undefined): Promise<string> {
	const levels = THINKING_LEVELS.join(" / ");
	if (!args) {
		const current = runtime?.snapshot().thinkingLevel;
		const line = current ? `当前思考档位：${current}` : "当前思考档位未知。";
		return `${line}\n可用档位：${levels}\n示例：/thinking high`;
	}
	if (!runtime) return "Pi 运行时尚未就绪，请稍后再试。";
	const level = args.toLowerCase();
	const applied = await runtime.setThinkingLevel(level);
	return applied ? `已切换思考档位：${level}。` : `无法设置思考档位“${args}”。\n可用档位：${levels}`;
}

async function executeModel(args: string, runtime: PiRuntime | undefined): Promise<string> {
	if (!runtime) return "Pi 运行时尚未就绪，请稍后再试。";
	if (!args) {
		const current = runtime.snapshot().model;
		const models = runtime.listModels();
		const hint =
			models.length > 0
				? `共 ${models.length} 个可用模型，使用 /model <模型ID或名称> 切换。`
				: "使用 /model <模型ID或名称> 切换。";
		return current ? `当前模型：${current}\n${hint}` : `当前模型未知。\n${hint}`;
	}
	try {
		const model = await runtime.switchModel(args);
		return `已切换模型：${model.name}（${model.id}）。`;
	} catch (error) {
		return `切换模型失败：${error instanceof Error ? error.message : String(error)}`;
	}
}

function unknownCommandReply(input: string): string {
	return `❓ 未知命令：${input.trim().split(/\s+/)[0]}\n\n输入 /help 查看可用命令。`;
}

function formatContextPercent(percent: number | undefined): string {
	if (percent === undefined || percent === null || Number.isNaN(percent)) return "未知";
	return `${Math.round(percent)}%`;
}
