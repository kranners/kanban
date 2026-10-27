import { execFile } from "node:child_process";
import type { MirrorKey, Session } from "../shared/types.ts";
import { lastLine } from "./ansi.ts";

export type CmuxSurface = { workspace: string; surface: string };

export type CmuxResult<T> =
	| { ok: true; value: T }
	| { ok: false; error: string };

export type Cmux = {
	surfaces(): Promise<CmuxResult<Map<number, CmuxSurface>>>;
	readScreen(target: CmuxSurface): Promise<CmuxResult<string>>;
	paste(
		target: CmuxSurface,
		text: string,
		submit: boolean,
		force?: boolean,
	): Promise<CmuxResult<null>>;
	sendKey(target: CmuxSurface, key: MirrorKey): Promise<CmuxResult<null>>;
};

export const cmuxKeys: Record<MirrorKey, string> = {
	Enter: "enter",
	Escape: "escape",
	Tab: "tab",
	"Shift+Tab": "shift+tab",
	Up: "up",
	Down: "down",
	Left: "left",
	Right: "right",
	Backspace: "backspace",
	"Ctrl+C": "ctrl+c",
};

const pidRef = /^\d+$/;

export const parseSurfaces = (tsv: string): Map<number, CmuxSurface> => {
	const paneWorkspace = new Map<string, string>();
	const surfacePane = new Map<string, string>();
	const processParents = new Map<number, string[]>();
	for (const line of tsv.split("\n")) {
		const [, , , kind, ref, parent] = line.split("\t");
		if (!ref || !parent) continue;
		if (kind === "pane") paneWorkspace.set(ref, parent);
		if (kind === "surface") surfacePane.set(ref, parent);
		if (kind === "process" && pidRef.test(ref)) {
			const pid = Number(ref);
			processParents.set(pid, [...(processParents.get(pid) ?? []), parent]);
		}
	}
	const surfaceOf = (pid: number, seen: Set<number>): string | null => {
		if (seen.has(pid)) return null;
		seen.add(pid);
		for (const parent of processParents.get(pid) ?? []) {
			if (surfacePane.has(parent)) return parent;
			const above = pidRef.test(parent)
				? surfaceOf(Number(parent), seen)
				: null;
			if (above) return above;
		}
		return null;
	};
	const surfaces = new Map<number, CmuxSurface>();
	for (const pid of processParents.keys()) {
		const surface = surfaceOf(pid, new Set());
		const workspace = surface
			? paneWorkspace.get(surfacePane.get(surface) ?? "")
			: undefined;
		if (surface && workspace) surfaces.set(pid, { workspace, surface });
	}
	return surfaces;
};

const refusal = /password|auth|denied|not allowed|unauthori[sz]ed|forbidden/i;

export const explainFailure = (cmuxBin: string, output: string): string => {
	const detail = output.replace(/^Error:\s*/, "");
	if (/ENOENT/.test(detail)) {
		return `cmux was not found at ${cmuxBin}; set CMUX_BIN`;
	}
	if (/waiting on a question or dialog/.test(detail)) {
		return "The session has a question open, so the text was not sent. Answer it with the keys first.";
	}
	if (/holds text someone is typing/.test(detail)) {
		return "Someone is typing in the session's prompt, so the text was not sent. Try again once the prompt is clear.";
	}
	if (refusal.test(detail)) {
		return `cmux refused kanban (${detail}). Run kanban from inside cmux, or set CMUX_SOCKET_PASSWORD to cmux's socket password.`;
	}
	return `cmux: ${detail || "no output"}`;
};

const inheritedTargets = [
	"CMUX_WORKSPACE_ID",
	"CMUX_SURFACE_ID",
	"CMUX_PANEL_ID",
	"CMUX_TAB_ID",
];

const childEnv = (): NodeJS.ProcessEnv =>
	Object.fromEntries(
		Object.entries(process.env).filter(
			([name]) => !inheritedTargets.includes(name),
		),
	);

const commandTimeoutMs = 10_000;

export const cmuxCli = (cmuxBin: string): Cmux => {
	const run = (args: string[]): Promise<CmuxResult<string>> =>
		new Promise((resolve) => {
			execFile(
				cmuxBin,
				args,
				{
					env: childEnv(),
					timeout: commandTimeoutMs,
					maxBuffer: 4 * 1024 * 1024,
				},
				(error, stdout, stderr) =>
					resolve(
						error
							? {
									ok: false,
									error: explainFailure(
										cmuxBin,
										lastLine(`${stdout}\n${stderr}`) || error.message,
									),
								}
							: { ok: true, value: stdout },
					),
			);
		});
	const at = (target: CmuxSurface): string[] => [
		"--workspace",
		target.workspace,
		"--surface",
		target.surface,
	];
	const done = (result: CmuxResult<string>): CmuxResult<null> =>
		result.ok ? { ok: true, value: null } : result;
	return {
		async surfaces() {
			const result = await run([
				"top",
				"--all",
				"--processes",
				"--format",
				"tsv",
				"--id-format",
				"uuids",
			]);
			return result.ok
				? { ok: true, value: parseSurfaces(result.value) }
				: result;
		},
		readScreen: (target) => run(["read-screen", ...at(target)]),
		paste: async (target, text, submit, force = false) =>
			done(
				await run([
					"paste",
					...at(target),
					...(submit ? ["--submit"] : []),
					...(force ? ["--force"] : []),
					"--",
					text,
				]),
			),
		sendKey: async (target, key) =>
			done(
				await run(["send-key", ...at(target), "--force", "--", cmuxKeys[key]]),
			),
	};
};

export type CmuxTargets = {
	has(pid: number): boolean;
	refresh(): Promise<boolean>;
	resolve(session: Session): Promise<CmuxResult<CmuxSurface>>;
};

const surfacesKey = (surfaces: Map<number, CmuxSurface>): string =>
	JSON.stringify([...surfaces].sort(([a], [b]) => a - b));

export const createCmuxTargets = (deps: {
	cmux: Cmux;
	live(session: Session): Promise<boolean>;
	onError?: (error: string) => void;
	keepMs?: number;
	now?: () => number;
}): CmuxTargets => {
	const keepMs = deps.keepMs ?? 60_000;
	const now = deps.now ?? Date.now;
	const seen = new Map<number, { surface: CmuxSurface; at: number }>();
	let lastError: string | null = null;
	let announced = surfacesKey(new Map());

	const current = (): Map<number, CmuxSurface> =>
		new Map([...seen].map(([pid, { surface }]) => [pid, surface]));

	const list = async (): Promise<Map<number, CmuxSurface> | null> => {
		const result = await deps.cmux.surfaces();
		const error = result.ok ? null : result.error;
		if (error && error !== lastError) deps.onError?.(error);
		lastError = error;
		return result.ok && result.value.size > 0 ? result.value : null;
	};

	return {
		has: (pid) => seen.has(pid),
		async refresh() {
			const listed = await list();
			const at = now();
			if (listed) {
				for (const pid of seen.keys()) if (!listed.has(pid)) seen.delete(pid);
				for (const [pid, surface] of listed) seen.set(pid, { surface, at });
			} else {
				for (const [pid, entry] of seen) {
					if (at - entry.at > keepMs) seen.delete(pid);
				}
			}
			const key = surfacesKey(current());
			const changed = key !== announced;
			announced = key;
			return changed;
		},
		async resolve(session) {
			if (session.kind !== "interactive" || session.pid === null) {
				return { ok: false, error: "Only terminal sessions run in cmux" };
			}
			if (!(await deps.live(session))) {
				return {
					ok: false,
					error: "The session's process is no longer the one on the board",
				};
			}
			const listed = await list();
			const kept = seen.get(session.pid);
			const target =
				listed?.get(session.pid) ??
				(!listed && kept && now() - kept.at <= keepMs ? kept.surface : null);
			if (target) return { ok: true, value: target };
			return {
				ok: false,
				error:
					lastError && !listed
						? lastError
						: "This session is no longer in a cmux pane",
			};
		},
	};
};
