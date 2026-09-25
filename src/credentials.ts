import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { CredentialStore, Environment, FeishuCredentials } from "./contracts.js";

const APP_ID_PATTERN = /^cli_[A-Za-z0-9_-]+$/;

export class CredentialError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CredentialError";
	}
}

export interface CredentialInput extends FeishuCredentials {
	source: "arguments" | "environment";
}

export function parseSetupArguments(args: string): FeishuCredentials | null {
	const trimmed = args.trim();
	if (!trimmed) return null;

	const parts = trimmed.split(/\s+/);
	if (parts.length !== 2) {
		throw new CredentialError("用法：/feishu setup <appId> <appSecret>，或设置 FEISHU_APP_ID/FEISHU_APP_SECRET。");
	}

	const appId = parts[0] ?? "";
	const appSecret = parts[1] ?? "";
	validateCredentialShape({ appId, appSecret });
	return { appId, appSecret };
}

export function resolveCredentialInput(args: string, environment: Environment): CredentialInput {
	const explicit = parseSetupArguments(args);
	if (explicit) return { ...explicit, source: "arguments" };

	const appId = environment.FEISHU_APP_ID?.trim() ?? "";
	const appSecret = environment.FEISHU_APP_SECRET?.trim() ?? "";
	if (!appId && !appSecret) {
		throw new CredentialError(
			"未提供飞书凭据。请设置 FEISHU_APP_ID、FEISHU_APP_SECRET，或使用 /feishu setup <appId> <appSecret>。",
		);
	}
	if (!appId || !appSecret) {
		throw new CredentialError("FEISHU_APP_ID 和 FEISHU_APP_SECRET 必须同时设置。");
	}
	validateCredentialShape({ appId, appSecret });
	return { appId, appSecret, source: "environment" };
}

export function resolveRuntimeCredentials(
	environment: Environment,
	stored: FeishuCredentials | null,
): FeishuCredentials | null {
	const appId = environment.FEISHU_APP_ID?.trim() ?? "";
	const appSecret = environment.FEISHU_APP_SECRET?.trim() ?? "";
	if (appId || appSecret) {
		if (!appId || !appSecret) {
			throw new CredentialError("FEISHU_APP_ID 和 FEISHU_APP_SECRET 必须同时设置。");
		}
		validateCredentialShape({ appId, appSecret });
		const matching = stored?.appId === appId ? stored : undefined;
		return {
			appId,
			appSecret,
			...(matching?.ownerOpenId ? { ownerOpenId: matching.ownerOpenId } : {}),
			...(matching?.managedGroupIds ? { managedGroupIds: matching.managedGroupIds } : {}),
			...(matching?.groupSessions ? { groupSessions: matching.groupSessions } : {}),
			...(matching?.allowlist ? { allowlist: matching.allowlist } : {}),
			...(matching?.allowlistNames ? { allowlistNames: matching.allowlistNames } : {}),
		};
	}
	return stored;
}

export function validateCredentialShape(credentials: FeishuCredentials): void {
	if (!APP_ID_PATTERN.test(credentials.appId)) {
		throw new CredentialError("飞书 App ID 格式无效，通常应以 cli_ 开头。");
	}
	if (!credentials.appSecret.trim()) {
		throw new CredentialError("飞书 App Secret 不能为空。");
	}
}

export function redactSensitiveText(
	text: string,
	credentials?: Pick<FeishuCredentials, "appId" | "appSecret">,
): string {
	let redacted = text.replace(/(Bearer\s+)[A-Za-z0-9._~+/-]+/gi, "$1[REDACTED]");
	if (credentials?.appSecret) {
		redacted = redacted.split(credentials.appSecret).join("[REDACTED]");
	}
	return redacted;
}

export function errorMessage(error: unknown, credentials?: Pick<FeishuCredentials, "appId" | "appSecret">): string {
	const message = error instanceof Error ? error.message : String(error);
	return redactSensitiveText(message, credentials);
}

export function defaultCredentialsPath(): string {
	return join(homedir(), ".pi", "agent", "feishu", "credentials.json");
}

export function defaultProcessedMessagesPath(): string {
	return join(homedir(), ".pi", "agent", "feishu", "processed-messages.json");
}

export class FileCredentialStore implements CredentialStore {
	private readonly path: string;

	constructor(path = defaultCredentialsPath()) {
		this.path = path;
	}

	async load(): Promise<FeishuCredentials | null> {
		let raw: string;
		try {
			raw = await readFile(this.path, "utf8");
		} catch (error) {
			if (isNodeError(error) && error.code === "ENOENT") return null;
			throw new CredentialError(`读取飞书凭据失败：${errorMessage(error)}`);
		}

		let value: unknown;
		try {
			value = JSON.parse(raw);
		} catch {
			throw new CredentialError("飞书凭据文件不是有效 JSON，请执行 /feishu logout 后重新配置。");
		}
		if (!isCredentialRecord(value)) {
			throw new CredentialError("飞书凭据文件格式无效，请执行 /feishu logout 后重新配置。");
		}
		validateCredentialShape(value);
		return {
			appId: value.appId,
			appSecret: value.appSecret,
			...(value.ownerOpenId ? { ownerOpenId: value.ownerOpenId } : {}),
			...(Array.isArray(value.managedGroupIds)
				? { managedGroupIds: value.managedGroupIds.filter((id): id is string => typeof id === "string") }
				: {}),
			...(isStringRecord(value.groupSessions) ? { groupSessions: value.groupSessions } : {}),
			...(Array.isArray(value.allowlist)
				? { allowlist: value.allowlist.filter((id): id is string => typeof id === "string") }
				: {}),
			...(isStringRecord(value.allowlistNames) ? { allowlistNames: value.allowlistNames } : {}),
		};
	}

	async save(credentials: FeishuCredentials): Promise<void> {
		validateCredentialShape(credentials);
		const directory = dirname(this.path);
		await mkdir(directory, { recursive: true, mode: 0o700 });
		const temporaryPath = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
		const payload = `${JSON.stringify(credentials, null, 2)}\n`;

		try {
			await writeFile(temporaryPath, payload, { encoding: "utf8", mode: 0o600, flag: "wx" });
			await rename(temporaryPath, this.path);
			await restrictFilePermissions(this.path);
		} catch (error) {
			await rm(temporaryPath, { force: true }).catch(() => undefined);
			throw new CredentialError(`保存飞书凭据失败：${errorMessage(error, credentials)}`);
		}
	}

	async clear(): Promise<void> {
		try {
			await rm(this.path, { force: true });
		} catch (error) {
			throw new CredentialError(`清除飞书凭据失败：${errorMessage(error)}`);
		}
	}
}

function isCredentialRecord(value: unknown): value is FeishuCredentials {
	if (!value || typeof value !== "object") return false;
	const record = value as Record<string, unknown>;
	return (
		typeof record.appId === "string" &&
		typeof record.appSecret === "string" &&
		(record.ownerOpenId === undefined || typeof record.ownerOpenId === "string") &&
		(record.managedGroupIds === undefined || Array.isArray(record.managedGroupIds)) &&
		(record.groupSessions === undefined || isStringRecord(record.groupSessions)) &&
		(record.allowlist === undefined || Array.isArray(record.allowlist)) &&
		(record.allowlistNames === undefined || isStringRecord(record.allowlistNames))
	);
}

function isStringRecord(value: unknown): value is Record<string, string> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	return Object.values(value).every((entry) => typeof entry === "string");
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}

async function restrictFilePermissions(path: string): Promise<void> {
	try {
		await chmod(path, 0o600);
	} catch (error) {
		if (process.platform !== "win32") throw error;
	}
}
