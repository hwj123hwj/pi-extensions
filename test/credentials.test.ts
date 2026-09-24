import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	CredentialError,
	FileCredentialStore,
	parseSetupArguments,
	redactSensitiveText,
	resolveCredentialInput,
	resolveRuntimeCredentials,
} from "../src/credentials.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("credential setup", () => {
	it("parses exactly an App ID and App Secret", () => {
		expect(parseSetupArguments("cli_test secret-value")).toEqual({
			appId: "cli_test",
			appSecret: "secret-value",
		});
		expect(() => parseSetupArguments("cli_test")).toThrow(CredentialError);
		expect(() => parseSetupArguments("cli_test secret extra")).toThrow(CredentialError);
		expect(() => parseSetupArguments("not-a-feishu-id secret")).toThrow(CredentialError);
	});

	it("prefers explicit arguments, then complete environment credentials", () => {
		const environment = {
			FEISHU_APP_ID: "cli_env",
			FEISHU_APP_SECRET: "env-secret",
		};

		expect(resolveCredentialInput("cli_arg arg-secret", environment)).toEqual({
			appId: "cli_arg",
			appSecret: "arg-secret",
			source: "arguments",
		});
		expect(resolveCredentialInput("", environment)).toEqual({
			appId: "cli_env",
			appSecret: "env-secret",
			source: "environment",
		});
		expect(() => resolveCredentialInput("", { FEISHU_APP_ID: "cli_incomplete" })).toThrow(CredentialError);
	});

	it("writes credentials atomically and restricts permissions where supported", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-feishu-"));
		temporaryDirectories.push(directory);
		const path = join(directory, "credentials.json");
		const store = new FileCredentialStore(path);

		await store.save({
			appId: "cli_test",
			appSecret: "secret-value",
			ownerOpenId: "ou_owner",
			managedGroupIds: ["oc_project"],
		});

		expect(await store.load()).toEqual({
			appId: "cli_test",
			appSecret: "secret-value",
			ownerOpenId: "ou_owner",
			managedGroupIds: ["oc_project"],
		});
		expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
			appId: "cli_test",
			appSecret: "secret-value",
			ownerOpenId: "ou_owner",
			managedGroupIds: ["oc_project"],
		});
		if (process.platform !== "win32") {
			expect((await stat(path)).mode & 0o777).toBe(0o600);
		}
	});

	it("preserves managed groups when environment credentials override the stored secret", () => {
		expect(
			resolveRuntimeCredentials(
				{ FEISHU_APP_ID: "cli_test", FEISHU_APP_SECRET: "new-secret" },
				{ appId: "cli_test", appSecret: "old-secret", ownerOpenId: "ou_owner", managedGroupIds: ["oc_project"] },
			),
		).toEqual({
			appId: "cli_test",
			appSecret: "new-secret",
			ownerOpenId: "ou_owner",
			managedGroupIds: ["oc_project"],
		});
	});

	it("redacts secrets from errors and logs", () => {
		const message = "request failed for cli_test with secret-value and Bearer tenant-token";
		expect(
			redactSensitiveText(message, {
				appId: "cli_test",
				appSecret: "secret-value",
			}),
		).toBe("request failed for cli_test with [REDACTED] and Bearer [REDACTED]");
	});
});
