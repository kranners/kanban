import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import { describe, it } from "node:test";
import { createAgentTokens } from "./agentAuth.ts";

const request = (
	remoteAddress: string,
	headers: Record<string, string> = {},
): IncomingMessage =>
	({ socket: { remoteAddress }, headers }) as unknown as IncomingMessage;

describe("agent tokens", () => {
	it("admit a live token from loopback only", () => {
		let time = 0;
		const tokens = createAgentTokens(1000, () => time);
		const token = tokens.issue("thread-1");
		const auth = { authorization: `Bearer ${token}` };
		assert.equal(tokens.verify(request("127.0.0.1", auth)), "thread-1");
		assert.equal(tokens.verify(request("::ffff:127.0.0.1", auth)), "thread-1");
		assert.equal(tokens.verify(request("::1", auth)), "thread-1");
		assert.equal(tokens.verify(request("192.168.1.20", auth)), null);
		assert.equal(tokens.verify(request("::ffff:10.0.0.2", auth)), null);
		time = 999;
		assert.equal(tokens.verify(request("127.0.0.1", auth)), "thread-1");
	});

	it("refuse a missing, malformed, unknown, expired or revoked token", () => {
		let time = 0;
		const tokens = createAgentTokens(1000, () => time);
		const token = tokens.issue("thread-1");
		assert.equal(tokens.verify(request("127.0.0.1")), null);
		assert.equal(
			tokens.verify(request("127.0.0.1", { authorization: token })),
			null,
		);
		assert.equal(
			tokens.verify(
				request("127.0.0.1", { authorization: `Bearer ${"a".repeat(43)}` }),
			),
			null,
		);
		const revoked = tokens.issue("thread-2");
		tokens.revoke(revoked);
		assert.equal(
			tokens.verify(
				request("127.0.0.1", { authorization: `Bearer ${revoked}` }),
			),
			null,
		);
		time = 1000;
		assert.equal(
			tokens.verify(request("127.0.0.1", { authorization: `Bearer ${token}` })),
			null,
		);
	});

	it("refuse requests that came through the tunnel", () => {
		const tokens = createAgentTokens(1000);
		const token = tokens.issue("thread-1");
		for (const header of [
			"cf-connecting-ip",
			"cf-access-jwt-assertion",
			"cf-ray",
		]) {
			assert.equal(
				tokens.verify(
					request("127.0.0.1", {
						authorization: `Bearer ${token}`,
						[header]: "x",
					}),
				),
				null,
				header,
			);
		}
	});
});
