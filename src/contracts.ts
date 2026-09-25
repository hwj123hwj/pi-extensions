export interface FeishuCredentials {
	appId: string;
	appSecret: string;
	ownerOpenId?: string;
	managedGroupIds?: string[];
	/** Per managed group Pi session file. Missing value is backfilled on the group's first message. */
	groupSessions?: Record<string, string>;
	/** Open IDs allowed to drive the bot besides the Owner, e.g. teammates in a managed group. */
	allowlist?: string[];
	/** Display names for allowlisted open IDs, captured from @mentions when authorizing. */
	allowlistNames?: Record<string, string>;
	/** Per managed group working directory (easycodeclient-style project binding). */
	groupDirs?: Record<string, string>;
}

export interface CredentialStore {
	load(): Promise<FeishuCredentials | null>;
	save(credentials: FeishuCredentials): Promise<void>;
	clear(): Promise<void>;
}

export interface FeishuMentionInfo {
	key: string;
	openId?: string;
	name?: string;
	isBot?: boolean;
}

export interface FeishuIncomingMessage {
	messageId: string;
	chatId: string;
	chatType: "p2p" | "group";
	senderOpenId: string;
	contentType: string;
	text: string;
	/** Sender display name when the platform provides one. */
	senderName?: string;
	/** True when the message @-mentions this bot (group messages only). */
	mentionedBot?: boolean;
	/** All @mentions carried by the message, bot included. */
	mentions?: FeishuMentionInfo[];
}

export type FeishuMessageHandler = (message: FeishuIncomingMessage) => Promise<void> | void;

export interface FeishuBotAddedEvent {
	chatId: string;
	operatorOpenId: string;
}

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
	/** Finalizes as failed; the sanitized reason is shown to the user when provided. */
	fail(reason?: string): Promise<void>;
	cancel(): Promise<void>;
}

export interface FeishuGateway {
	connect(handler: FeishuMessageHandler): Promise<void>;
	disconnect(): Promise<void>;
	createGroupChat(name: string, ownerOpenId: string): Promise<string>;
	/** Best-effort application scope audit. Undefined grantedScopes means the app cannot read its scope list yet. */
	probeGrantedScopes?(): Promise<{ grantedScopes?: string[] }>;
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
	/** Subscribes to "bot added to chat" events. Optional: older gateways may not expose it. */
	onBotAdded?(handler: (event: FeishuBotAddedEvent) => void): () => void;
	/** Fetches basic chat metadata (e.g. group name) for guidance messages. Optional. */
	getChatInfo?(chatId: string): Promise<{ name?: string } | undefined>;
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
	/**
	 * Creates a new session for the chat-bound session of the given Feishu chat
	 * and re-points the binding at it. Returns false when unavailable/cancelled.
	 */
	newChatSession?(chatId: string): Promise<boolean>;
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

export interface AgentRunOptions {
	/** Route this turn through the Pi session bound to the Feishu chat. */
	chatId?: string;
}

export interface AgentBridge {
	run(text: string, observer?: AgentProgressObserver, options?: AgentRunOptions): Promise<string>;
	cancel(reason?: string): void;
	/**
	 * 并入当前正在运行的轮次（同聊天追加消息时使用）。
	 * 仅当确有轮次在跑时返回 true；false 表示当前空闲，调用方应回退到正常排队。
	 */
	steer?(text: string): boolean;
}

export type FeishuGatewayFactory = (credentials: FeishuCredentials) => FeishuGateway;
export type CredentialValidator = (credentials: FeishuCredentials) => Promise<void>;
export type Environment = Readonly<Record<string, string | undefined>>;
