import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const RETENTION_MS = 48 * 60 * 60 * 1000;

interface DedupRecord {
	/** message_id → receipt epoch ms. */
	entries: Record<string, number>;
}

/**
 * At-most-once guard for Feishu event redelivery. Feishu retries webhook/WS
 * events after process restarts, so the seen-set is persisted to disk with a
 * 48h retention window (aligned with easycodeclient) instead of living only
 * in process memory. The receipt is written synchronously on accept — the
 * whole point is surviving an abrupt kill between "受理" and the next tick.
 */
export class MessageDeduplicator {
	private readonly seen = new Set<string>();
	private readonly receipts = new Map<string, number>();
	private readonly order: string[] = [];
	private readonly maxEntries: number;
	private readonly path: string | undefined;
	private loaded = false;

	constructor(maxEntries = 5000, path?: string) {
		this.maxEntries = maxEntries;
		this.path = path;
	}

	accept(messageId: string): boolean {
		if (this.seen.has(messageId)) return false;
		this.seen.add(messageId);
		this.order.push(messageId);
		this.receipts.set(messageId, Date.now());

		while (this.order.length > this.maxEntries) {
			const oldest = this.order.shift();
			if (oldest) {
				this.seen.delete(oldest);
				this.receipts.delete(oldest);
			}
		}
		this.persist();
		return true;
	}

	/** Loads prior receipts from disk; must complete before messages are accepted. */
	async hydrate(): Promise<void> {
		if (this.loaded || !this.path) {
			this.loaded = true;
			return;
		}
		this.loaded = true;
		let raw: string;
		try {
			raw = readFileSync(this.path, "utf8");
		} catch {
			return;
		}
		try {
			const record = JSON.parse(raw) as DedupRecord;
			const now = Date.now();
			for (const [messageId, receiptMs] of Object.entries(record.entries ?? {})) {
				if (typeof receiptMs !== "number" || now - receiptMs > RETENTION_MS) continue;
				this.receipts.set(messageId, receiptMs);
				this.seen.add(messageId);
				this.order.push(messageId);
			}
		} catch {
			// 损坏的记录文件等价于空集合：宁可重复处理也不能卡死正常消息。
		}
	}

	clear(): void {
		this.seen.clear();
		this.order.length = 0;
		this.receipts.clear();
		this.persist();
	}

	private persist(): void {
		if (!this.path) return;
		const now = Date.now();
		const entries: Record<string, number> = {};
		for (const [messageId, receiptMs] of this.receipts) {
			if (now - receiptMs <= RETENTION_MS) entries[messageId] = receiptMs;
		}
		const temporaryPath = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
		try {
			mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
			writeFileSync(temporaryPath, `${JSON.stringify({ entries })}\n`, { encoding: "utf8", flag: "wx" });
			renameSync(temporaryPath, this.path);
		} catch {
			rmSync(temporaryPath, { force: true });
			// 落盘失败不阻塞消息处理：内存集合仍在，本进程内去重有效。
		}
	}
}
