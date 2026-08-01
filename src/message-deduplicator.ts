export class MessageDeduplicator {
	private readonly seen = new Set<string>();
	private readonly order: string[] = [];
	private readonly maxEntries: number;

	constructor(maxEntries = 1000) {
		this.maxEntries = maxEntries;
	}

	accept(messageId: string): boolean {
		if (this.seen.has(messageId)) return false;
		this.seen.add(messageId);
		this.order.push(messageId);

		while (this.order.length > this.maxEntries) {
			const oldest = this.order.shift();
			if (oldest) this.seen.delete(oldest);
		}
		return true;
	}

	clear(): void {
		this.seen.clear();
		this.order.length = 0;
	}
}
