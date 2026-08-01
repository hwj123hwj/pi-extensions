import { describe, expect, it } from "vitest";
import { OwnerBinding } from "../src/owner-binding.js";

describe("OwnerBinding", () => {
	it("creates a six-digit one-time code and binds only the matching private message", () => {
		const binding = new OwnerBinding(undefined, () => "123456");

		expect(binding.getOrCreateCode()).toBe("123456");
		expect(binding.authorize("ou_alice", "hello")).toEqual({ kind: "binding-required" });
		expect(binding.authorize("ou_alice", "/bind 000000")).toEqual({ kind: "invalid-binding-code" });
		expect(binding.authorize("ou_alice", "/bind 123456")).toEqual({
			kind: "bound",
			ownerOpenId: "ou_alice",
		});
		expect(binding.ownerOpenId).toBe("ou_alice");
		expect(binding.getOrCreateCode()).toBeUndefined();
	});

	it("accepts only the persisted Owner after binding", () => {
		const binding = new OwnerBinding("ou_owner", () => "123456");

		expect(binding.authorize("ou_owner", "run tests")).toEqual({ kind: "authorized", text: "run tests" });
		expect(binding.authorize("ou_intruder", "run tests")).toEqual({ kind: "unauthorized" });
	});
});
