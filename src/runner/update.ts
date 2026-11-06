// A runner fetches its code from the hub only when it starts, so one left
// running kept old code until its machine rebooted. The hub now says, as each
// runner registers, which runner.js it serves; a runner on another version
// downloads it over its own file once it has no live session, then exits, and
// launchd or systemd starts it again on the new code.
import { createHash } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";

export const versionOf = (bytes: Uint8Array): string =>
	createHash("sha256").update(bytes).digest("hex");

/** The version of a file on disk, or null when it can't be read. */
export const fileVersion = async (file: string): Promise<string | null> => {
	try {
		return versionOf(await readFile(file));
	} catch {
		return null;
	}
};

export type SelfUpdateOptions = {
	/** The runner.js this process runs. */
	script: string;
	/** Its version when this process started. */
	current: string;
	hub: string;
	token: string;
	/** True while no session this runner carries is starting or working. */
	idle: () => boolean;
	/** Stops the runner; its service manager starts it again. */
	exit: () => void | Promise<void>;
	fetch?: typeof fetch;
	log?: (line: string) => void;
	retryMs?: number;
};

export type SelfUpdate = {
	/** The hub's version, from a registration. */
	offer(version: string): void;
	stop(): void;
};

export const createSelfUpdate = ({
	script,
	current,
	hub,
	token,
	idle,
	exit,
	fetch: fetchImpl = fetch,
	log = console.error,
	retryMs = 30_000,
}: SelfUpdateOptions): SelfUpdate => {
	let wanted: string | null = null;
	let failed: string | null = null;
	let busy = false;
	let timer: NodeJS.Timeout | undefined;

	const later = () => {
		clearTimeout(timer);
		timer = setTimeout(() => void attempt(), retryMs);
		timer.unref?.();
	};

	const attempt = async () => {
		const version = wanted;
		if (!version || busy) return;
		if (!idle()) return later();
		busy = true;
		const next = `${script}.update`;
		try {
			const response = await fetchImpl(`${hub}/runner.js`, {
				headers: { authorization: `Bearer ${token}` },
				signal: AbortSignal.timeout(60_000),
			});
			if (!response.ok) throw new Error(`the hub answered ${response.status}`);
			const bytes = new Uint8Array(await response.arrayBuffer());
			if (versionOf(bytes) !== version) {
				throw new Error("what it served isn't the version it announced");
			}
			await writeFile(next, bytes);
			await rename(next, script);
		} catch (error) {
			await rm(next, { force: true }).catch(() => {});
			// Tried once per announced version, so a failing download never loops.
			failed = version;
			wanted = null;
			busy = false;
			log(
				`kanban-runner: couldn't update to the board's runner: ${(error as Error).message}`,
			);
			return;
		}
		log(
			"kanban-runner: the board serves a newer runner; updated, restarting on it",
		);
		await exit();
	};

	return {
		offer(version) {
			if (version === current || version === failed || version === wanted) {
				return;
			}
			wanted = version;
			void attempt();
		},
		stop() {
			clearTimeout(timer);
			wanted = null;
		},
	};
};
