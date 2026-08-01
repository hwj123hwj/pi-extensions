import { randomInt, timingSafeEqual } from "node:crypto";

export type AuthorizationResult =
	| { kind: "authorized"; text: string }
	| { kind: "bound"; ownerOpenId: string }
	| { kind: "binding-required" }
	| { kind: "invalid-binding-code" }
	| { kind: "unauthorized" };

export class OwnerBinding {
	private owner: string | undefined;
	private code: string | undefined;
	private readonly generateCode: () => string;

	constructor(ownerOpenId: string | undefined, generateCode: () => string = defaultBindingCode) {
		this.owner = ownerOpenId;
		this.generateCode = generateCode;
	}

	get ownerOpenId(): string | undefined {
		return this.owner;
	}

	getOrCreateCode(): string | undefined {
		if (this.owner) return undefined;
		if (!this.code) {
			const generated = this.generateCode();
			if (!/^\d{6}$/.test(generated)) {
				throw new Error("绑定码生成器必须返回六位数字。");
			}
			this.code = generated;
		}
		return this.code;
	}

	authorize(senderOpenId: string, text: string): AuthorizationResult {
		if (this.owner) {
			return senderOpenId === this.owner ? { kind: "authorized", text } : { kind: "unauthorized" };
		}

		const match = text.trim().match(/^\/bind\s+(\d{6})$/);
		if (!match) return { kind: "binding-required" };
		const candidate = match[1] ?? "";
		const expected = this.getOrCreateCode();
		if (!expected || !safeEqual(candidate, expected)) return { kind: "invalid-binding-code" };

		this.owner = senderOpenId;
		this.code = undefined;
		return { kind: "bound", ownerOpenId: senderOpenId };
	}
}

function defaultBindingCode(): string {
	return randomInt(100000, 1000000).toString();
}

function safeEqual(left: string, right: string): boolean {
	const leftBuffer = Buffer.from(left);
	const rightBuffer = Buffer.from(right);
	return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}
