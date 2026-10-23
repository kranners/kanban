import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { NewSessionRequest, NewSessionResult } from "../shared/types.ts";
import { stripAnsi } from "./ansi.ts";
import { parsePoint } from "./layout.ts";

export type SessionLauncher = (
	request: NewSessionRequest,
) => Promise<NewSessionResult>;

const maxNameLength = 60;
const controlCharacters = /\p{Cc}/u;

const isDirectory = async (path: string): Promise<boolean> => {
	try {
		return (await stat(path)).isDirectory();
	} catch {
		return false;
	}
};

export const validateNewSession = async (
	body: unknown,
): Promise<NewSessionRequest | { error: string }> => {
	if (typeof body !== "object" || body === null) {
		return { error: "Expected a JSON object with cwd and prompt" };
	}
	const { cwd, name, prompt, at } = body as Record<string, unknown>;
	if (typeof cwd !== "string" || !isAbsolute(cwd)) {
		return { error: "cwd must be an absolute path" };
	}
	if (!(await isDirectory(cwd))) {
		return { error: `${cwd} is not an existing directory` };
	}
	if (name !== undefined && typeof name !== "string") {
		return { error: "name must be a string" };
	}
	const trimmed = name?.trim() ?? "";
	if (trimmed.length > maxNameLength || controlCharacters.test(trimmed)) {
		return {
			error: `name must be at most ${maxNameLength} characters on one line`,
		};
	}
	if (typeof prompt !== "string" || prompt.trim() === "") {
		return { error: "prompt is required" };
	}
	const point = at === undefined ? undefined : parsePoint(at);
	if (point === null) {
		return { error: "at must be a point with finite x and y" };
	}
	return {
		cwd,
		prompt,
		...(trimmed ? { name: trimmed } : {}),
		...(point ? { at: point } : {}),
	};
};

export const parseBackgrounded = (stdout: string): string | null =>
	stdout.match(/backgrounded · ([0-9a-f]{8})/)?.[1] ?? null;

const untrustedHint = (cwd: string) =>
	`Workspace not trusted: run claude in ${cwd} once and accept the trust prompt, then try again`;

export const launchResult = (
	cwd: string,
	stdout: string,
	stderr: string,
): NewSessionResult => {
	const short = parseBackgrounded(stdout);
	if (short) return { ok: true, short };
	const output = stripAnsi(`${stdout}\n${stderr}`);
	if (output.includes("Workspace not trusted")) {
		return { ok: false, error: untrustedHint(cwd) };
	}
	const detail = output.trim().split("\n").at(-1)?.trim();
	return {
		ok: false,
		error: detail ? `claude --bg failed: ${detail}` : "claude --bg failed",
	};
};

export const launchArgs = (request: NewSessionRequest): string[] => [
	"--bg",
	...(request.name ? [`--name=${request.name}`] : []),
	"--",
	request.prompt,
];

export const claudeLauncher =
	(claudeBin: string): SessionLauncher =>
	(request) =>
		new Promise((resolve) => {
			execFile(
				claudeBin,
				launchArgs(request),
				{ cwd: request.cwd, timeout: 60_000, maxBuffer: 1024 * 1024 },
				(_error, stdout, stderr) =>
					resolve(launchResult(request.cwd, stdout, stderr)),
			);
		});
