// A secret per runner, so one machine's credential opens only its own
// endpoints. Each runner makes its own secret on its own disk and enrols once:
// it presents the shared token and its secret's hash, from the address the hub
// is told belongs to that runner's name. The hub keeps only the hash, in a
// file in its state folder. From then on that name is accepted only with its
// own secret, and the shared token only for names that have not enrolled.
// Setting a name's entry to null cuts that machine off; deleting the entry
// lets it enrol again.
import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import type { RunnerEnrolment } from "../shared/runners.ts";

export const runnerNameHeader = "x-kanban-runner";
const hashPattern = /^[0-9a-f]{64}$/;
const idPattern = /^[a-z0-9][a-z0-9-]{0,39}$/;

export type RunnerKeyFile = Record<string, string | null>;

/** What a request's bearer credential is, judged for the runner it acts as. */
export type RunnerCredential =
	| { kind: "own"; id: string }
	| { kind: "shared" }
	| { kind: "none" }
	| { kind: "wrong" };

export type RunnerKeys = {
	/** Who the credential belongs to, or that it is the shared token. */
	credential(req: IncomingMessage): RunnerCredential;
	/** Null when the request may act as this runner, else why not. */
	mayActAs(req: IncomingMessage, id: string): string | null;
	enrol(
		id: string,
		hash: unknown,
		address: string | null,
	):
		| { ok: true; already: boolean }
		| { ok: false; status: number; error: string };
	state(id: string): RunnerEnrolment;
};

const sha256 = (text: string) => createHash("sha256").update(text).digest();

const bearer = (req: IncomingMessage): string | null =>
	req.headers.authorization?.match(/^Bearer\s+(\S+)$/i)?.[1] ?? null;

const same = (a: Buffer, b: Buffer) =>
	a.length === b.length && timingSafeEqual(a, b);

/** Name=address pairs, comma-separated, from the hub's environment. */
export const parseRunnerAddresses = (
	raw: string | undefined,
): Map<string, string> =>
	new Map(
		(raw ?? "")
			.split(",")
			.map((pair) => pair.trim())
			.filter((pair) => pair.includes("="))
			.map((pair) => {
				const eq = pair.indexOf("=");
				return [pair.slice(0, eq).trim(), pair.slice(eq + 1).trim()] as const;
			})
			.filter(([id, address]) => idPattern.test(id) && address !== ""),
	);

/** The address the proxy in front of the hub saw the request come from. */
export const forwardedAddress = (req: IncomingMessage): string | null => {
	const sent = req.headers["cf-connecting-ip"];
	return typeof sent === "string" && sent.length <= 64 ? sent : null;
};

export const createRunnerKeys = ({
	file,
	sharedToken,
	addresses,
	log = () => {},
}: {
	file: string | null;
	sharedToken: string | null;
	addresses: Map<string, string>;
	log?: (line: string) => void;
}): RunnerKeys => {
	const shared = sharedToken === null ? null : sha256(sharedToken);
	let keys: RunnerKeyFile = {};
	let readAt = -1;
	// A keys file that can't be read refuses the shared token to everyone and enrols no one, rather than forget who enrolled.
	let broken: string | null = null;

	const load = () => {
		if (!file) return;
		let mtime: number;
		try {
			mtime = statSync(file).mtimeMs;
		} catch {
			keys = {};
			readAt = -1;
			broken = null;
			return;
		}
		if (mtime === readAt) return;
		readAt = mtime;
		try {
			const body = JSON.parse(readFileSync(file, "utf8")) as unknown;
			if (typeof body !== "object" || body === null || Array.isArray(body)) {
				throw new Error("it is not an object of names");
			}
			keys = Object.fromEntries(
				Object.entries(body)
					.filter(([id]) => idPattern.test(id))
					.map(([id, hash]) => [
						id,
						typeof hash === "string" && hashPattern.test(hash) ? hash : null,
					]),
			);
			broken = null;
		} catch (error) {
			broken = `the board can't read ${file}: ${(error as Error).message}`;
			log(
				`runner keys: ${broken}, so it refuses the shared token and enrols no one`,
			);
		}
	};

	const save = () => {
		if (!file) return;
		const next = `${file}.next`;
		writeFileSync(next, `${JSON.stringify(keys, null, "\t")}\n`, {
			mode: 0o600,
		});
		renameSync(next, file);
		readAt = statSync(file).mtimeMs;
	};

	const credential = (req: IncomingMessage): RunnerCredential => {
		const token = bearer(req);
		if (!token) return { kind: "none" };
		const hashed = sha256(token);
		if (shared && same(hashed, shared)) return { kind: "shared" };
		load();
		const hex = hashed.toString("hex");
		for (const [id, hash] of Object.entries(keys)) {
			if (hash && same(Buffer.from(hash, "hex"), Buffer.from(hex, "hex"))) {
				return { kind: "own", id };
			}
		}
		return { kind: "wrong" };
	};

	return {
		credential,
		mayActAs(req, id) {
			const held = credential(req);
			load();
			if (held.kind === "none") return "no credential";
			if (held.kind === "wrong") return "a credential the board doesn't know";
			if (held.kind === "own") {
				return held.id === id ? null : `${held.id}'s secret can't act as ${id}`;
			}
			if (broken) return broken;
			if (!(id in keys)) {
				const expected = addresses.get(id);
				if (!expected) return null;
				const from = forwardedAddress(req);
				return from === null || from === expected
					? null
					: `the shared token speaks for ${id} only from its own address`;
			}
			return keys[id] === null
				? `${id} is cut off on the board`
				: `${id} has enrolled, so only its own secret is accepted`;
		},
		enrol(id, hash, address) {
			load();
			if (broken) return { ok: false, status: 503, error: broken };
			if (!idPattern.test(id))
				return { ok: false, status: 400, error: "Not a runner name" };
			if (typeof hash !== "string" || !hashPattern.test(hash)) {
				return {
					ok: false,
					status: 400,
					error: "Send the sha256 of the secret, in hex",
				};
			}
			const expected = addresses.get(id);
			if (!expected) {
				return {
					ok: false,
					status: 403,
					error: `The board knows no address for ${id}, so it can't enrol`,
				};
			}
			if (address !== expected) {
				log(
					`runner keys: ${id} tried to enrol from ${address ?? "an unknown address"}, not ${expected}`,
				);
				return {
					ok: false,
					status: 403,
					error: `${id} enrols only from its own address`,
				};
			}
			if (id in keys) {
				if (keys[id] === hash) return { ok: true, already: true };
				return {
					ok: false,
					status: 409,
					error:
						keys[id] === null
							? `${id} is cut off on the board`
							: `${id} has already enrolled with another secret`,
				};
			}
			keys[id] = hash;
			save();
			log(`runner keys: ${id} enrolled from ${address}`);
			return { ok: true, already: false };
		},
		state(id) {
			load();
			if (!(id in keys)) return "shared-token";
			return keys[id] === null ? "cut-off" : "enrolled";
		},
	};
};
