export class SerialMessageQueue {
	private tail: Promise<void> = Promise.resolve();
	private pending = 0;

	get pendingCount(): number {
		return this.pending;
	}

	enqueue<T>(task: () => Promise<T>): Promise<T> {
		this.pending += 1;
		const execution = this.tail.then(task);
		this.tail = execution
			.then(
				() => undefined,
				() => undefined,
			)
			.finally(() => {
				this.pending -= 1;
			});
		return execution;
	}

	async waitForIdle(): Promise<void> {
		await this.tail;
	}
}
