import { createHash, randomBytes } from "node:crypto";
import type { IncomingMessage } from "node:http";

export type AgentTokens = {
	issue(threadId: string): string;
	revoke(token: string): void;
	verify(req: IncomingMessage): string | null;
};

const digest = (token: string): string =>
	createHash("sha256").update(token).digest("hex");

const tunnelHeaders = ["cf-connecting-ip", "cf-access-jwt-assertion", "cf-ray"];

export const fromLoopback = (req: IncomingMessage): boolean => {
	const address = req.socket.remoteAddress ?? "";
	const local =
		address === "::1" || /^(::ffff:)?127\.\d+\.\d+\.\d+$/.test(address);
	return (
		local && tunnelHeaders.every((name) => req.headers[name] === undefined)
	);
};

export const bearer = (req: IncomingMessage): string | null => {
	const match = req.headers.authorization?.match(
		/^Bearer ([A-Za-z0-9_-]{32,128})$/,
	);
	return match?.[1] ?? null;
};

export const createAgentTokens = (
	ttlMs: number,
	now: () => number = Date.now,
): AgentTokens => {
	const live = new Map<string, { threadId: string; expires: number }>();
	return {
		issue(threadId) {
			const token = randomBytes(32).toString("base64url");
			live.set(digest(token), { threadId, expires: now() + ttlMs });
			return token;
		},
		revoke(token) {
			live.delete(digest(token));
		},
		verify(req) {
			if (!fromLoopback(req)) return null;
			const token = bearer(req);
			if (!token) return null;
			const key = digest(token);
			const entry = live.get(key);
			if (!entry) return null;
			if (now() >= entry.expires) {
				live.delete(key);
				return null;
			}
			return entry.threadId;
		},
	};
};
