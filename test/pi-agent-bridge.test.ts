import { describe, expect, it } from "vitest";
import { PiAgentBridge } from "../src/pi-agent-bridge.js";

describe("PiAgentBridge", () => {
	it("submits a user message and resolves with the final assistant text when the agent settles", async () => {
		const submitted: string[] = [];
		const bridge = new PiAgentBridge((text) => submitted.push(text));

		const response = bridge.run("hello");
		expect(submitted).toEqual(["hello"]);

		bridge.captureMessage({
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "hidden" },
				{ type: "text", text: "Hello " },
				{ type: "text", text: "from Pi" },
			],
		});
		bridge.settle();

		await expect(response).resolves.toBe("Hello from Pi");
	});

	it("uses the last non-empty assistant response and rejects pending work on shutdown", async () => {
		const bridge = new PiAgentBridge(() => undefined);
		const response = bridge.run("hello");
		bridge.captureMessage({ role: "assistant", content: [{ type: "text", text: "intermediate" }] });
		bridge.captureMessage({ role: "assistant", content: [{ type: "text", text: "final" }] });
		bridge.cancel("session closed");
		await expect(response).rejects.toThrow("session closed");
	});

	it("emits incremental assistant text and safe tool activity for a pending Feishu turn", async () => {
		const updates: string[] = [];
		const activities: Array<{ kind: string; toolName?: string }> = [];
		const bridge = new PiAgentBridge(() => undefined);
		const response = bridge.run("hello", {
			onText: (text) => updates.push(text),
			onActivity: (activity) => activities.push(activity),
		});

		bridge.captureStreamingMessage({ role: "assistant", content: [{ type: "text", text: "Hel" }] });
		bridge.captureStreamingMessage({ role: "assistant", content: [{ type: "text", text: "Hello" }] });
		bridge.captureToolStart("bash");
		bridge.captureToolEnd();
		bridge.captureMessage({ role: "assistant", content: [{ type: "text", text: "Hello" }] });
		bridge.settle();

		expect(updates).toEqual(["Hel", "Hello"]);
		expect(activities).toEqual([{ kind: "thinking" }, { kind: "tool", toolName: "bash" }, { kind: "thinking" }]);
		await expect(response).resolves.toBe("Hello");
	});
});
