import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import { describe, it } from "node:test";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { accessAuthenticator, accessToken, originAllowed } from "./auth.ts";

const team = "acme-team";
const aud = "aud-123";
const issuer = `https://${team}.cloudflareaccess.com`;

const request = (headers: Record<string, string>): IncomingMessage =>
	({ headers }) as unknown as IncomingMessage;

const setup = async () => {
	const { publicKey, privateKey } = await generateKeyPair("RS256");
	const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256" };
	const keys = createLocalJWKSet({ keys: [jwk] });
	const sign = (claims: { iss?: string; aud?: string; exp?: string } = {}) =>
		new SignJWT({ email: "me@example.com" })
			.setProtectedHeader({ alg: "RS256", kid: "k1" })
			.setIssuer(claims.iss ?? issuer)
			.setAudience(claims.aud ?? aud)
			.setSubject("user-1")
			.setIssuedAt()
			.setExpirationTime(claims.exp ?? "5m")
			.sign(privateKey);
	return { authenticate: accessAuthenticator(team, aud, keys), sign };
};

describe("accessAuthenticator", () => {
	it("returns 401 without a token", async () => {
		const { authenticate } = await setup();
		assert.deepEqual(await authenticate(request({})), {
			ok: false,
			status: 401,
		});
	});

	it("returns 403 for a malformed token", async () => {
		const { authenticate } = await setup();
		const result = await authenticate(
			request({ "cf-access-jwt-assertion": "not-a-jwt" }),
		);
		assert.deepEqual(result, { ok: false, status: 403 });
	});

	it("accepts a valid header token and reports the email", async () => {
		const { authenticate, sign } = await setup();
		const result = await authenticate(
			request({ "cf-access-jwt-assertion": await sign() }),
		);
		assert.deepEqual(result, { ok: true, identity: "me@example.com" });
	});

	it("accepts a valid CF_Authorization cookie", async () => {
		const { authenticate, sign } = await setup();
		const cookie = `theme=dark; CF_Authorization=${await sign()}; other=1`;
		const result = await authenticate(request({ cookie }));
		assert.equal(result.ok, true);
	});

	it("rejects the wrong audience, issuer or an expired token", async () => {
		const { authenticate, sign } = await setup();
		for (const token of [
			await sign({ aud: "someone-else" }),
			await sign({ iss: "https://other.cloudflareaccess.com" }),
			await sign({ exp: "-1m" }),
		]) {
			const result = await authenticate(
				request({ "cf-access-jwt-assertion": token }),
			);
			assert.deepEqual(result, { ok: false, status: 403 });
		}
	});

	it("rejects a token signed by another key", async () => {
		const { authenticate } = await setup();
		const { sign } = await setup();
		const result = await authenticate(
			request({ "cf-access-jwt-assertion": await sign() }),
		);
		assert.deepEqual(result, { ok: false, status: 403 });
	});
});

describe("accessToken", () => {
	it("prefers the header over the cookie", () => {
		assert.equal(
			accessToken(
				request({
					"cf-access-jwt-assertion": "a",
					cookie: "CF_Authorization=b",
				}),
			),
			"a",
		);
		assert.equal(accessToken(request({ cookie: "x=1" })), null);
	});
});

describe("originAllowed", () => {
	it("requires an exact configured origin", () => {
		const origins = ["https://kanban.example.com"];
		assert.ok(
			originAllowed(request({ origin: origins[0] as string }), origins),
		);
		assert.ok(!originAllowed(request({}), origins));
		assert.ok(
			!originAllowed(request({ origin: "https://evil.example.com" }), origins),
		);
	});
});
