import { execFile } from "node:child_process";
import { mkdir, mkdtemp, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import {
	imageExtensions,
	maxImageBytes,
	maxPromptImages,
} from "../shared/promptImages.ts";
import type {
	NewSessionRequest,
	NewSessionResult,
	PromptImage,
} from "../shared/types.ts";
import { stripAnsi } from "./ansi.ts";
import { parsePoint } from "./layout.ts";

export type SessionLauncher = (
	request: NewSessionRequest,
) => Promise<NewSessionResult>;

const maxNameLength = 60;
const controlCharacters = /\p{Cc}/u;

export const isDirectory = async (path: string): Promise<boolean> => {
	try {
		return (await stat(path)).isDirectory();
	} catch {
		return false;
	}
};

const isBase64 = (data: string): boolean =>
	data.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(data);

const decodedBytes = (data: string): number =>
	(data.length / 4) * 3 - (data.match(/=*$/)?.[0].length ?? 0);

const isPromptImage = (image: unknown): image is PromptImage => {
	if (typeof image !== "object" || image === null) return false;
	const { type, data } = image as Record<string, unknown>;
	return (
		typeof type === "string" &&
		Object.hasOwn(imageExtensions, type) &&
		typeof data === "string" &&
		data !== "" &&
		isBase64(data)
	);
};

const validateImages = (images: unknown): PromptImage[] | { error: string } => {
	if (!Array.isArray(images) || !images.every(isPromptImage)) {
		return { error: "images must be base64 PNG, JPEG, GIF or WebP images" };
	}
	if (images.length > maxPromptImages) {
		return { error: `Attach at most ${maxPromptImages} images` };
	}
	if (images.some((image) => decodedBytes(image.data) > maxImageBytes)) {
		return {
			error: `Each image must be at most ${maxImageBytes / 1024 / 1024} MB`,
		};
	}
	return images.map(({ type, data }) => ({ type, data }));
};

export const validateNewSession = async (
	body: unknown,
): Promise<NewSessionRequest | { error: string }> => {
	if (typeof body !== "object" || body === null) {
		return { error: "Expected a JSON object with cwd and prompt" };
	}
	const { cwd, name, prompt, images, at } = body as Record<string, unknown>;
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
	const attached = images === undefined ? [] : validateImages(images);
	if ("error" in attached) return attached;
	const point = at === undefined ? undefined : parsePoint(at);
	if (point === null) {
		return { error: "at must be a point with finite x and y" };
	}
	return {
		cwd,
		prompt,
		...(trimmed ? { name: trimmed } : {}),
		...(attached.length ? { images: attached } : {}),
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

export type SavedImages = { folder: string; paths: string[] };

export const saveImages = async (
	imagesDir: string,
	images: PromptImage[],
): Promise<SavedImages> => {
	await mkdir(imagesDir, { recursive: true });
	const folder = await mkdtemp(join(imagesDir, "prompt-"));
	const paths = images.map((image, index) =>
		join(folder, `image-${index + 1}.${imageExtensions[image.type]}`),
	);
	await Promise.all(
		images.map((image, index) =>
			writeFile(paths[index] as string, Buffer.from(image.data, "base64")),
		),
	);
	return { folder, paths };
};

export const launchArgs = (
	request: NewSessionRequest,
	saved: SavedImages | null = null,
): string[] => [
	"--bg",
	...(request.name ? [`--name=${request.name}`] : []),
	...(saved ? [`--add-dir=${saved.folder}`] : []),
	"--",
	saved ? [request.prompt, ...saved.paths].join("\n\n") : request.prompt,
];

export const claudeLauncher =
	(claudeBin: string, imagesDir: string): SessionLauncher =>
	async (request) => {
		let saved: SavedImages | null = null;
		try {
			if (request.images) saved = await saveImages(imagesDir, request.images);
		} catch (error) {
			return { ok: false, error: `Couldn't save the images (${error})` };
		}
		return new Promise((resolve) => {
			execFile(
				claudeBin,
				launchArgs(request, saved),
				{ cwd: request.cwd, timeout: 60_000, maxBuffer: 1024 * 1024 },
				(_error, stdout, stderr) =>
					resolve(launchResult(request.cwd, stdout, stderr)),
			);
		});
	};
