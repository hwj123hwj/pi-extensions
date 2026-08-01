import { describe, expect, it } from "vitest";
import { parseFeishuCommand, renderFeishuHelp, renderFeishuStatus } from "../src/extension.js";

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
});
