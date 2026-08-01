import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { FeishuController, type FeishuStatus } from "./controller.js";
import { CredentialError, FileCredentialStore } from "./credentials.js";
import { SdkFeishuGateway, validateSdkCredentials } from "./gateway.js";
import { PiAgentBridge } from "./pi-agent-bridge.js";

type FeishuCommandName = "help" | "setup" | "start" | "stop" | "status" | "logout";

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
	const agent = new PiAgentBridge((text) => pi.sendUserMessage(text));
	const controller = new FeishuController({
		store: new FileCredentialStore(),
		gatewayFactory: (credentials) => new SdkFeishuGateway(credentials),
		validateCredentials: validateSdkCredentials,
		agent,
	});

	pi.on("message_end", (event) => {
		agent.captureMessage(event.message);
	});
	pi.on("message_update", (event) => {
		agent.captureStreamingMessage(event.message);
	});
	pi.on("tool_execution_start", (event) => {
		agent.captureToolStart(event.toolName);
	});
	pi.on("tool_execution_end", () => {
		agent.captureToolEnd();
	});
	pi.on("agent_settled", () => {
		agent.settle();
	});
	pi.on("session_shutdown", async () => {
		await controller.stop();
		agent.cancel("Pi 会话已关闭。");
	});

	pi.registerCommand("feishu", {
		description: "配置和管理飞书私聊连接",
		handler: async (args, context) => {
			try {
				await handleFeishuCommand(parseFeishuCommand(args), controller, context);
			} catch (error) {
				context.ui.notify(`飞书操作失败：${controller.sanitizeError(error)}`, "error");
			}
		},
	});
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
