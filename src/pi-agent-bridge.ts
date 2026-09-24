import type { AgentBridge, AgentProgressObserver } from "./contracts.js";

interface PendingTurn {
	resolve: (text: string) => void;
	reject: (error: Error) => void;
	lastAssistantText: string;
	observer: AgentProgressObserver | undefined;
}

export class PiAgentBridge implements AgentBridge {
	private readonly sendUserMessage: (text: string) => void | Promise<void>;
	private pending: PendingTurn | undefined;

	constructor(sendUserMessage: (text: string) => void | Promise<void>) {
		this.sendUserMessage = sendUserMessage;
	}

	run(text: string, observer?: AgentProgressObserver): Promise<string> {
		if (this.pending) {
			return Promise.reject(new Error("已有飞书消息正在等待 Pi 回复。"));
		}

		return new Promise<string>((resolve, reject) => {
			this.pending = { resolve, reject, lastAssistantText: "", observer };
			observer?.onActivity?.({ kind: "thinking" });
			Promise.resolve(this.sendUserMessage(text)).catch((error: unknown) => {
				this.pending = undefined;
				reject(error instanceof Error ? error : new Error(String(error)));
			});
		});
	}

	captureMessage(message: unknown): void {
		this.captureAssistantText(message);
	}

	captureStreamingMessage(message: unknown): void {
		this.captureAssistantText(message);
	}

	captureToolStart(toolName: string): void {
		this.pending?.observer?.onActivity?.({ kind: "tool", toolName });
	}

	captureToolEnd(): void {
		this.pending?.observer?.onActivity?.({ kind: "thinking" });
	}

	private captureAssistantText(message: unknown): void {
		const pending = this.pending;
		if (!pending || !isAssistantMessage(message)) return;
		const text = message.content
			.filter(isTextContent)
			.map((item) => item.text)
			.join("");
		const normalized = text.trim();
		if (!normalized || normalized === pending.lastAssistantText) return;
		pending.lastAssistantText = normalized;
		pending.observer?.onText?.(normalized);
	}

	settle(): void {
		const pending = this.pending;
		if (!pending) return;
		this.pending = undefined;
		pending.resolve(pending.lastAssistantText || "Pi 已完成处理，但没有返回文本内容。");
	}

	cancel(reason = "Pi 会话已关闭。"): void {
		const pending = this.pending;
		if (!pending) return;
		this.pending = undefined;
		pending.reject(new Error(reason));
	}
}

interface AssistantMessageLike {
	role: "assistant";
	content: unknown[];
}

interface TextContentLike {
	type: "text";
	text: string;
}

function isAssistantMessage(value: unknown): value is AssistantMessageLike {
	if (!value || typeof value !== "object") return false;
	const record = value as Record<string, unknown>;
	return record.role === "assistant" && Array.isArray(record.content);
}

function isTextContent(value: unknown): value is TextContentLike {
	if (!value || typeof value !== "object") return false;
	const record = value as Record<string, unknown>;
	return record.type === "text" && typeof record.text === "string";
}
