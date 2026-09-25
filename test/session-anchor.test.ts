import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { anchorSessionHeaderCwd } from "../src/extension.js";

async function writeSessionFile(header: object, entries: object[] = []): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "pi-feishu-session-"));
	const file = join(directory, "session.jsonl");
	const lines = [JSON.stringify(header), ...entries.map((entry) => JSON.stringify(entry))];
	await writeFile(file, `${lines.join("\n")}\n`, "utf8");
	return file;
}

describe("anchorSessionHeaderCwd", () => {
	it("rewrites only the header cwd and keeps entries intact", async () => {
		const file = await writeSessionFile(
			{ type: "session", version: 1, id: "s1", cwd: "/Users/weijian" },
			[{ type: "message", role: "user", text: "hi" }],
		);

		const ok = await anchorSessionHeaderCwd(file, "/tmp/project");
		expect(ok).toBe(true);

		const lines = (await readFile(file, "utf8")).trim().split("\n");
		expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({ type: "session", cwd: "/tmp/project" });
		expect(JSON.parse(lines[1] ?? "{}")).toEqual({ type: "message", role: "user", text: "hi" });
	});

	it("is idempotent when the cwd already matches", async () => {
		const file = await writeSessionFile({ type: "session", cwd: "/tmp/project" });
		await expect(anchorSessionHeaderCwd(file, "/tmp/project/")).resolves.toBe(true);
		const raw = await readFile(file, "utf8");
		expect(JSON.parse(raw.trim())).toMatchObject({ cwd: "/tmp/project" });
	});

	it("returns false for malformed or non-session files", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-feishu-session-"));

		const notJson = join(directory, "a.jsonl");
		await writeFile(notJson, "not json at all\n", "utf8");
		await expect(anchorSessionHeaderCwd(notJson, "/tmp")).resolves.toBe(false);

		const wrongType = join(directory, "b.jsonl");
		await writeFile(wrongType, `${JSON.stringify({ type: "message" })}\n`, "utf8");
		await expect(anchorSessionHeaderCwd(wrongType, "/tmp")).resolves.toBe(false);

		await expect(anchorSessionHeaderCwd(join(directory, "missing.jsonl"), "/tmp")).resolves.toBe(false);
	});
});
