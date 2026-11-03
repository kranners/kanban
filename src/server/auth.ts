import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { createRemoteJWKSet, type JWTVerifyGetKey, jwtVerify } from "jose";
import type { AuthConfig } from "./config.ts";

export type AuthResult =
	| { ok: true; identity: string | null }
	| { ok: false; status: 401 | 403 };

export type Authenticate = (req: IncomingMessage) => Promise<AuthResult>;

const readCookie = (
	header: string | undefined,
	name: string,
): string | null => {
	for (const part of (header ?? "").split(";")) {
		const [key, ...value] = part.trim().split("=");
		if (key === name) return value.join("=");
	}
	return null;
};

export const accessToken = (req: IncomingMessage): string | null => {
	const header = req.headers["cf-access-jwt-assertion"];
	const fromHeader = Array.isArray(header) ? header[0] : header;
	return fromHeader || readCookie(req.headers.cookie, "CF_Authorization");
};

export const accessIssuer = (team: string): string =>
	`https://${team}.cloudflareaccess.com`;

export const accessAuthenticator = (
	team: string,
	aud: string,
	keys: JWTVerifyGetKey = createRemoteJWKSet(
		new URL(`${accessIssuer(team)}/cdn-cgi/access/certs`),
	),
): Authenticate => {
	const issuer = accessIssuer(team);
	return async (req) => {
		const token = accessToken(req);
		if (!token) return { ok: false, status: 401 };
		try {
			const { payload } = await jwtVerify(token, keys, {
				issuer,
				audience: aud,
			});
			const email = typeof payload.email === "string" ? payload.email : null;
			return { ok: true, identity: email ?? payload.sub ?? null };
		} catch {
			return { ok: false, status: 403 };
		}
	};
};

export const authenticatorFor = (auth: AuthConfig): Authenticate =>
	auth.mode === "off"
		? async () => ({ ok: true, identity: null })
		: accessAuthenticator(auth.team, auth.aud);

export const originAllowed = (
	req: IncomingMessage,
	origins: string[],
): boolean => {
	const origin = req.headers.origin;
	return origin !== undefined && origins.includes(origin);
};

// The shared runner token, sent as `Authorization: Bearer <token>`, admits
// machine-to-machine calls: runners checking in, and spike or Butler calling
// the API over WireGuard. Both sides are hashed first so the comparison takes
// the same time whatever the length or content of the guess.
export type RunnerTokenCheck = (
	req: IncomingMessage,
) => "none" | "ok" | "wrong";

const sha256 = (text: string): Buffer =>
	createHash("sha256").update(text).digest();

export const runnerTokenCheck = (token: string | null): RunnerTokenCheck => {
	const expected = token === null ? null : sha256(token);
	return (req) => {
		const match = req.headers.authorization?.match(/^Bearer\s+(\S+)$/i);
		if (!match?.[1]) return "none";
		if (expected === null) return "wrong";
		return timingSafeEqual(sha256(match[1]), expected) ? "ok" : "wrong";
	};
};

export const runnerIdentity = "runner-token";
