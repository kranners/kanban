import { createHash } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { imageExtensions, maxImageBytes } from "../shared/promptImages.ts";
import type { Session } from "../shared/types.ts";
import { asTime, parseJson } from "./ingest/json.ts";
import { locateTranscript } from "./ingest/locate.ts";

export type ReportShot = { url: string; caption: string; at: number };

export type CollectShotsOptions = {
	dir?: string;
	limit?: number;
	claudeHome?: string;
};

export const reportShotsUrlPrefix = "/api/report-shots/";
export const reportShotName = /^[0-9a-f]{64}\.(png|jpg|gif|webp)$/;
export const defaultShotLimit = 4;

export const reportShotsDir = (stateDir: string): string =>
	join(stateDir, "report-shots");

export const reportShotContentType = (name: string): string | null => {
	const match = name.match(reportShotName);
	if (!match) return null;
	const ext = match[1];
	return (
		Object.entries(imageExtensions).find(([, e]) => e === ext)?.[0] ?? null
	);
};

type Found = {
	mediaType: string;
	data: string;
	at: number;
	toolUseId: string | null;
	fromTool: boolean;
};

const maxBase64Length = Math.ceil((maxImageBytes * 4) / 3) + 4;

const record = (value: unknown): Record<string, unknown> | null =>
	value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;

const imageOf = (
	block: Record<string, unknown>,
): { mediaType: string; data: string } | null => {
	if (block.type !== "image") return null;
	const source = record(block.source);
	if (source?.type !== "base64") return null;
	const { media_type: mediaType, data } = source;
	if (typeof mediaType !== "string" || !(mediaType in imageExtensions))
		return null;
	if (typeof data !== "string" || data.length === 0) return null;
	if (data.length > maxBase64Length) return null;
	return { mediaType, data };
};

const imagesInLine = (line: string): Found[] => {
	const entry = record(parseJson(line));
	if (entry?.type !== "user") return [];
	const content = record(entry.message)?.content;
	if (!Array.isArray(content)) return [];
	const at = asTime(entry.timestamp) ?? 0;
	const found: Found[] = [];
	for (const raw of content) {
		const block = record(raw);
		if (!block) continue;
		const pasted = imageOf(block);
		if (pasted) {
			found.push({ ...pasted, at, toolUseId: null, fromTool: false });
			continue;
		}
		if (block.type !== "tool_result" || !Array.isArray(block.content)) continue;
		const toolUseId =
			typeof block.tool_use_id === "string" ? block.tool_use_id : null;
		for (const inner of block.content) {
			const innerBlock = record(inner);
			const image = innerBlock && imageOf(innerBlock);
			if (image) found.push({ ...image, at, toolUseId, fromTool: true });
		}
	}
	return found;
};

const captionFromInput = (input: Record<string, unknown>): string | null => {
	for (const key of [
		"file_path",
		"path",
		"filename",
		"description",
		"url",
		"element",
	]) {
		const value = input[key];
		if (typeof value === "string" && value.trim()) return value.trim();
	}
	return null;
};

const captionsFor = (
	lines: string[],
	ids: Set<string>,
): Map<string, string> => {
	const captions = new Map<string, string>();
	if (ids.size === 0) return captions;
	for (const line of lines) {
		if (!line.includes('"tool_use"')) continue;
		let hit = false;
		for (const id of ids) {
			if (line.includes(id)) {
				hit = true;
				break;
			}
		}
		if (!hit) continue;
		const content = record(record(parseJson(line))?.message)?.content;
		if (!Array.isArray(content)) continue;
		for (const raw of content) {
			const block = record(raw);
			if (block?.type !== "tool_use" || typeof block.id !== "string") continue;
			if (!ids.has(block.id)) continue;
			const input = record(block.input);
			const caption = input && captionFromInput(input);
			captions.set(
				block.id,
				caption ?? (typeof block.name === "string" ? block.name : ""),
			);
		}
	}
	return captions;
};

const pick = (found: Found[], limit: number): Found[] => {
	const tools = found.filter((f) => f.fromTool);
	const chosen = tools.slice(-limit);
	if (chosen.length < limit) {
		const pasted = found.filter((f) => !f.fromTool);
		chosen.push(...pasted.slice(-(limit - chosen.length)));
	}
	return chosen
		.map((f) => ({ f, i: found.indexOf(f) }))
		.sort((a, b) => a.f.at - b.f.at || a.i - b.i)
		.map(({ f }) => f);
};

const store = async (dir: string, image: Found): Promise<string | null> => {
	const bytes = Buffer.from(image.data, "base64");
	if (bytes.length === 0 || bytes.length > maxImageBytes) return null;
	const name = `${createHash("sha256").update(bytes).digest("hex")}.${imageExtensions[image.mediaType]}`;
	const file = join(dir, name);
	try {
		await stat(file);
		return name;
	} catch {}
	const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
	await writeFile(temp, bytes);
	await rename(temp, file);
	return name;
};

export async function collectShots(
	session: Session,
	options: CollectShotsOptions = {},
): Promise<ReportShot[]> {
	try {
		const { dir } = options;
		const limit = Math.max(0, Math.floor(options.limit ?? defaultShotLimit));
		if (!dir || limit === 0 || session.cloud) return [];
		const home =
			session.configDir ??
			options.claudeHome ??
			(process.env.CLAUDE_HOME || join(homedir(), ".claude"));
		const path = locateTranscript(home, session.id, session.cwd);
		if (!path) return [];
		const lines = (await readFile(path, "utf8")).split("\n");
		const found: Found[] = [];
		for (const line of lines) {
			if (!line.includes('"image"')) continue;
			found.push(...imagesInLine(line));
		}
		const chosen = pick(found, limit);
		if (chosen.length === 0) return [];
		const captions = captionsFor(
			lines,
			new Set(chosen.flatMap((f) => (f.toolUseId ? [f.toolUseId] : []))),
		);
		await mkdir(dir, { recursive: true });
		const shots: ReportShot[] = [];
		for (const image of chosen) {
			const name = await store(dir, image).catch(() => null);
			if (!name) continue;
			const caption =
				(image.toolUseId && captions.get(image.toolUseId)) || "Screenshot";
			shots.push({ url: reportShotsUrlPrefix + name, caption, at: image.at });
		}
		return shots;
	} catch {
		return [];
	}
}
