import type { FeishuCredentials } from "./contracts.js";

export const REQUIRED_APP_SCOPES = [
	"im:message.p2p_msg:readonly",
	"im:message.group_at_msg:readonly",
	"im:message:send_as_bot",
	"im:message:update",
	"im:message.reactions:read",
	"im:message.reactions:write_only",
	"im:chat",
	"im:chat:read",
	"application:application:self_manage",
] as const;

export const SENSITIVE_GROUP_MSG_SCOPE = "im:message.group_msg";

export interface ScopeProbeResult {
	grantedScopes?: string[];
}

export function missingScopes(granted: readonly string[] | undefined, required: readonly string[]): string[] {
	if (!granted) return [...required];
	const set = new Set(granted);
	return required.filter((scope) => !set.has(scope));
}

export function hasScope(granted: readonly string[] | undefined, scope: string): boolean {
	return Boolean(granted?.includes(scope));
}

export function buildScopeApplyUrl(params: { appId: string; scopes: readonly string[] }): string {
	const url = new URL(`https://open.feishu.cn/app/${params.appId}/auth`);
	if (params.scopes.length > 0 && params.scopes.length < 20) url.searchParams.set("q", params.scopes.join(","));
	url.searchParams.set("op_from", "pi-feishu");
	url.searchParams.set("token_type", "tenant");
	return url.toString();
}

export function buildPermissionPageUrl(appId: string): string {
	return `https://open.feishu.cn/app/${appId}/permission`;
}

export function buildEventSubUrl(appId: string): string {
	return `https://open.feishu.cn/app/${appId}/event-sub`;
}

export async function probeGrantedScopes(credentials: FeishuCredentials): Promise<ScopeProbeResult> {
	const tokenResponse = await fetch("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ app_id: credentials.appId, app_secret: credentials.appSecret }),
	});
	const tokenResult = (await tokenResponse.json()) as { code?: number; msg?: string; tenant_access_token?: string };
	if (!tokenResponse.ok || tokenResult.code !== 0 || !tokenResult.tenant_access_token) {
		throw new Error(`获取飞书 tenant token 失败：${tokenResult.msg ?? tokenResponse.statusText}`);
	}

	const scopeResponse = await fetch("https://open.feishu.cn/open-apis/application/v6/applications/me?lang=zh_cn", {
		headers: { Authorization: `Bearer ${tokenResult.tenant_access_token}` },
	});
	const scopeResult = (await scopeResponse.json()) as {
		code?: number;
		app?: ScopeApp;
		data?: ScopeApp & { app?: ScopeApp };
	};
	if (!scopeResponse.ok || scopeResult.code !== 0) return {};
	const app = scopeResult.data?.app ?? scopeResult.app ?? scopeResult.data ?? {};
	const rawScopes = app.scopes ?? app.online_version?.scopes ?? [];
	return {
		grantedScopes: rawScopes.map((entry) => entry.scope).filter((scope): scope is string => Boolean(scope)),
	};
}

interface ScopeApp {
	scopes?: Array<{ scope?: string }>;
	online_version?: { scopes?: Array<{ scope?: string }> };
}

export function buildGroupPermissionReminder(params: {
	appId: string;
	groupName: string;
	grantedScopes?: readonly string[];
}): string | null {
	const missingRequired = missingScopes(params.grantedScopes, REQUIRED_APP_SCOPES);
	const missingGroupMsg = !hasScope(params.grantedScopes, SENSITIVE_GROUP_MSG_SCOPE);
	const unknown = !params.grantedScopes;
	if (!unknown && missingRequired.length === 0 && !missingGroupMsg) return null;

	const requiredForLink = unknown ? REQUIRED_APP_SCOPES : missingRequired;
	const lines = ["💬 **【重要体验提示 — 飞书项目群权限】**", "", `您刚才成功创建了项目群「${params.groupName}」。`, ""];
	if (unknown) {
		lines.push(
			"ℹ️ 当前应用还不能读取自身已开通 scope 列表（通常缺少 `application:application:self_manage`），无法自动确认权限完整性。",
			"",
		);
	}
	if (missingRequired.length > 0 || unknown) {
		lines.push(
			"⚠️ **基础权限可能未完整开通**，缺失时会影响私聊/群聊接收、回复、更新卡片和已读表情。",
			`👉 一键申请基础权限：${buildScopeApplyUrl({ appId: params.appId, scopes: requiredForLink })}`,
			"",
		);
	}
	if (missingGroupMsg || unknown) {
		lines.push(
			`⚠️ **免 @ 权限未确认**：如果不开通 \`${SENSITIVE_GROUP_MSG_SCOPE}\`，群里普通消息可能不会触发机器人；请在群里 @ 机器人，或申请免 @ 权限。`,
			`👉 一键申请免 @ 权限：${buildScopeApplyUrl({ appId: params.appId, scopes: [SENSITIVE_GROUP_MSG_SCOPE] })}`,
			"",
		);
	}
	lines.push(
		"还需要确认事件订阅与发布：",
		`1️⃣ 事件订阅页确认订阅 \`im.message.receive_v1\`：${buildEventSubUrl(params.appId)}`,
		`2️⃣ 权限管理页申请发布版本使权限生效：${buildPermissionPageUrl(params.appId)}`,
		"",
		"权限生效前，群里请先使用 `@机器人 你的问题`。",
	);
	return lines.join("\n");
}
