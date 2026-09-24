import { describe, expect, it } from "vitest";
import {
	appendScopeHealthHint,
	parseFeishuCommand,
	renderFeishuHelp,
	renderFeishuStatus,
	renderMissingCredentials,
	renderPostSetupGuidance,
	renderStartSuccess,
} from "../src/extension.js";
import { REQUIRED_APP_SCOPES, SENSITIVE_GROUP_MSG_SCOPE } from "../src/scopes.js";

describe("feishu extension command surface", () => {
	it("supports only the minimal command set", () => {
		expect(parseFeishuCommand("")).toEqual({ name: "help", args: "" });
		expect(parseFeishuCommand("setup --manual cli_test secret")).toEqual({
			name: "setup",
			args: "cli_test secret",
		});
		expect(parseFeishuCommand("start")).toEqual({ name: "start", args: "" });
		expect(parseFeishuCommand("stop")).toEqual({ name: "stop", args: "" });
		expect(parseFeishuCommand("status")).toEqual({ name: "status", args: "" });
		expect(parseFeishuCommand("logout")).toEqual({ name: "logout", args: "" });
		expect(() => parseFeishuCommand("allow ou_user")).toThrow("未知子命令");
	});

	it("renders concise help and status without exposing an App Secret", () => {
		expect(renderFeishuHelp()).toContain("/feishu setup");
		expect(renderFeishuHelp()).not.toContain("/feishu allow");
		const status = renderFeishuStatus({
			configured: true,
			running: true,
			appId: "cli_test",
			ownerOpenId: "ou_owner",
			source: "environment",
			pendingMessages: 2,
		});
		expect(status).toContain("cli_test");
		expect(status).toContain("ou_owner");
		expect(status).toContain("队列：2");
		expect(status).not.toContain("secret");
	});

	it("renders a dashboard on successful start", () => {
		const text = renderStartSuccess({
			configured: true,
			running: true,
			appId: "cli_test",
			ownerOpenId: "ou_owner",
			source: "file",
			pendingMessages: 0,
		});
		expect(text).toContain("🚀 飞书 Bot 已就绪！");
		expect(text).toContain("cli_test");
		expect(text).toContain("ou_owner");
		expect(text).toContain("现在去飞书给 Bot 发消息试试");
		expect(text).toContain("/feishu stop");
	});

	it("includes the binding code in the start dashboard when owner is unbound", () => {
		const text = renderStartSuccess(
			{ configured: true, running: true, appId: "cli_test", source: "file", pendingMessages: 0 },
			"123456",
		);
		expect(text).toContain("123456");
		expect(text).toContain("/bind 123456");
	});

	it("renders actionable guidance when credentials are missing", () => {
		const text = renderMissingCredentials();
		expect(text).toContain("未找到飞书凭证");
		expect(text).toContain("/feishu setup");
		expect(text).toContain("FEISHU_APP_ID");
	});

	it("renders post-setup guidance with apply links and event subscription", () => {
		const text = renderPostSetupGuidance("cli_test");
		expect(text).toContain("一键完成下一步配置");
		expect(text).toContain("open.feishu.cn/app/cli_test/auth");
		expect(text).toContain("im.message.receive_v1");
		expect(text).toContain("open.feishu.cn/app/cli_test/event-sub");
		expect(text).toContain("申请发布版本");
		expect(text).toContain("/feishu start");
	});

	it("post-setup guidance lists the free-@ sensitive scope separately", () => {
		const text = renderPostSetupGuidance("cli_test");
		expect(text).toContain(SENSITIVE_GROUP_MSG_SCOPE);
		expect(text).toContain("人工审核");
		// 全部 scope 已开通且含免@时不再提示
		const complete = renderPostSetupGuidance("cli_test", [...REQUIRED_APP_SCOPES, SENSITIVE_GROUP_MSG_SCOPE]);
		expect(complete).toContain("无需额外申请");
		expect(complete).not.toContain("人工审核");
	});

	it("appends scope health hint to the dashboard only when scopes are known", async () => {
		const dashboard = "🚀 飞书 Bot 已就绪！";
		const healthy = await appendScopeHealthHint("cli_test", dashboard, [
			...REQUIRED_APP_SCOPES,
			SENSITIVE_GROUP_MSG_SCOPE,
		]);
		expect(healthy).toContain("应用权限配置完整");

		const degraded = await appendScopeHealthHint("cli_test", dashboard, ["im:message.p2p_msg:readonly"]);
		expect(degraded).toContain("尚未开通");
		expect(degraded).toContain("免 @ 响应");
		expect(degraded).toContain("open.feishu.cn/app/cli_test/permission");

		const unknown = await appendScopeHealthHint("cli_test", dashboard, undefined);
		expect(unknown).toBe(dashboard);
	});

	it("status mini-doctor reports missing scopes", () => {
		const text = renderFeishuStatus(
			{ configured: true, running: false, appId: "cli_test", source: "file", pendingMessages: 0 },
			["im:message:update"],
		);
		expect(text).toContain("📊 飞书状态:");
		expect(text).toContain("缺失 1 项必需 scope");
		expect(text).toContain("im:message:update");
		expect(text).toContain("运行 /feishu start 启动 Bot");
	});
});
