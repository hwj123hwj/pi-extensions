export interface FeishuCredentials {
	appId: string;
	appSecret: string;
	ownerOpenId?: string;
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
	sendText(chatId: string, text: string, replyTo?: string): Promise<void>;
	beginReply(chatId: string, replyTo: string): Promise<FeishuReply>;
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
