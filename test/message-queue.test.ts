import { describe, expect, it } from "vitest";
import { SerialMessageQueue } from "../src/message-queue.js";

function deferred<T>() {
	let resolvePromise: (value: T) => void = () => undefined;
	const promise = new Promise<T>((resolve) => {
		resolvePromise = resolve;
	});
	return { promise, resolve: resolvePromise };
}

describe("SerialMessageQueue", () => {
	it("runs jobs strictly one at a time and survives a failed job", async () => {
		const queue = new SerialMessageQueue();
		const first = deferred<void>();
		const order: string[] = [];

		const firstResult = queue.enqueue(async () => {
			order.push("first:start");
			await first.promise;
			order.push("first:end");
			throw new Error("expected failure");
		});
		const secondResult = queue.enqueue(async () => {
			order.push("second:start");
			return "done";
		});

		await Promise.resolve();
		expect(order).toEqual(["first:start"]);
		first.resolve();
		await expect(firstResult).rejects.toThrow("expected failure");
		await expect(secondResult).resolves.toBe("done");
		expect(order).toEqual(["first:start", "first:end", "second:start"]);
		await queue.waitForIdle();
		expect(queue.pendingCount).toBe(0);
	});
});
