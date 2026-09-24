export interface FeishuCredentials {
	appId: string;
	appSecret: string;
	ownerOpenId?: string;
	managedGroupIds?: string[];
}

export interface CredentialStore {
	load(): Promise<FeishuCredentials | null>;
	save(credentials: FeishuCredentials): Promise<void>;
	clear(): Promise<void>;
}

export interface FeishuIncomingMessage {
	messageId: string;
	chatId: string;
	chatType: "p2p" | "group";
	senderOpenId: string;
	contentType: string;
	text: string;
}

export type FeishuMessageHandler = (message: FeishuIncomingMessage) => Promise<void> | void;

export interface FeishuReactionEvent {
	messageId: string;
	operatorOpenId: string;
	emojiType: string;
	action: "added" | "removed";
}

export type FeishuReactionHandler = (event: FeishuReactionEvent) => void;

export interface FeishuReplySnapshot {
	text: string;
	status: "正在思考" | "正在生成回复" | "正在执行工具" | "已完成" | "处理失败" | "已取消";
}

export interface FeishuReply {
	update(snapshot: FeishuReplySnapshot): void;
	complete(snapshot: FeishuReplySnapshot): Promise<void>;
	fail(): Promise<void>;
	cancel(): Promise<void>;
}

export interface FeishuGateway {
	connect(handler: FeishuMessageHandler): Promise<void>;
	disconnect(): Promise<void>;
	createGroupChat(name: string, ownerOpenId: string): Promise<string>;
	/** Sends text and resolves with the sent Feishu message id (for later recall). */
	sendText(chatId: string, text: string, replyTo?: string): Promise<string | undefined>;
	beginReply(chatId: string, replyTo: string): Promise<FeishuReply>;
	/** Edits an already-sent text message in place. */
	editText(messageId: string, text: string): Promise<void>;
	/** Adds an emoji reaction to a message and returns the Feishu reaction id. */
	addReaction(messageId: string, emojiType: string): Promise<string>;
	removeReaction(messageId: string, reactionId: string): Promise<void>;
	recallMessage(messageId: string): Promise<void>;
	/** Subscribes to emoji reactions on messages visible to the bot. */
	onReaction(handler: FeishuReactionHandler): () => void;
}

export interface FeishuStatus {
	configured: boolean;
	running: boolean;
	ownerOpenId?: string;
	appId?: string;
	source?: "environment" | "file";
	pendingMessages: number;
}

export interface PiRuntimeSnapshot {
	streaming: boolean;
	model?: string;
	thinkingLevel?: string;
	contextPercent?: number;
}

export interface PiModelInfo {
	id: string;
	name: string;
	provider: string;
}

/**
 * Exposes the Pi runtime capabilities needed by remote slash commands.
 * Implementations must be defensive: the captured context goes stale after
 * a session switch, so methods may become no-ops until the next event.
 */
export interface PiRuntime {
	isIdle(): boolean;
	abort(): void;
	compact(): void;
	/** Returns false when the runtime is unavailable or the switch was cancelled. */
	newSession(): Promise<boolean>;
	/** Returns false when the requested thinking level does not exist. */
	setThinkingLevel(level: string): Promise<boolean>;
	/** Models the user can currently switch to. */
	listModels(): PiModelInfo[];
	/** Switches by fuzzy id/name match; throws with a user-facing reason on failure. */
	switchModel(query: string): Promise<PiModelInfo>;
	snapshot(): PiRuntimeSnapshot;
}

export type AgentActivity = { kind: "thinking" } | { kind: "tool"; toolName: string };

export interface AgentProgressObserver {
	onText?: (text: string) => void;
	onActivity?: (activity: AgentActivity) => void;
}

export interface AgentBridge {
	run(text: string, observer?: AgentProgressObserver): Promise<string>;
	cancel(reason?: string): void;
}

export type FeishuGatewayFactory = (credentials: FeishuCredentials) => FeishuGateway;
export type CredentialValidator = (credentials: FeishuCredentials) => Promise<void>;
export type Environment = Readonly<Record<string, string | undefined>>;
