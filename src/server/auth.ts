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
