import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { maxImageBytes } from "../shared/promptImages.ts";
import type { Session } from "../shared/types.ts";
import { matchRoute } from "./http.ts";
import { projectSlug } from "./ingest/locate.ts";
import { collectShots, reportShotContentType } from "./reportShots.ts";

const cwd = "/work/acme-api";
const sessionId = "11111111-2222-3333-4444-555555555555";

const session = (extra: Partial<Session> = {}): Session => ({
	id: sessionId,
	short: null,
	pid: null,
	name: "acme",
	cwd,
	project: "acme-api",
	kind: "interactive",
	activity: "idle",
	doing: null,
	needs: null,
	goal: null,
	startedAt: 0,
	updatedAt: 0,
	attachable: false,
	cmux: false,
	artifacts: [],
	tasks: [],
	steps: [],
	...extra,
});

const png = (n: number) => Buffer.from(`fake-png-${n}`);
const image = (bytes: Buffer, mediaType = "image/png") => ({
	type: "image",
	source: {
		type: "base64",
		media_type: mediaType,
		data: bytes.toString("base64"),
	},
});
const at = (minute: number) =>
	`2026-10-31T10:${String(minute).padStart(2, "0")}:00.000Z`;

const toolUse = (id: string, name: string, input: unknown, minute: number) => ({
	type: "assistant",
	timestamp: at(minute),
	message: {
		role: "assistant",
		content: [{ type: "tool_use", id, name, input }],
	},
});
const toolResult = (id: string, blocks: unknown[], minute: number) => ({
	type: "user",
	timestamp: at(minute),
	message: {
		role: "user",
		content: [{ type: "tool_result", tool_use_id: id, content: blocks }],
	},
});
const pasted = (blocks: unknown[], minute: number) => ({
	type: "user",
	timestamp: at(minute),
	message: { role: "user", content: blocks },
});

const setup = async (records: unknown[]) => {
	const root = await mkdtemp(join(tmpdir(), "kanban-shots-"));
	const home = join(root, "claude");
	const dir = join(root, "state", "report-shots");
	const project = join(home, "projects", projectSlug(cwd) ?? "x");
	await mkdir(project, { recursive: true });
	await writeFile(
		join(project, `${sessionId}.jsonl`),
		`${records.map((r) => JSON.stringify(r)).join("\n")}\nnot json "image"\n`,
	);
	return { home, dir };
};

const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

describe("collectShots", () => {
	it("returns the newest tool-result images, newest last, with captions", async () => {
		const { home, dir } = await setup([
			toolUse("t1", "Read", { file_path: "/tmp/one.png" }, 1),
			toolResult("t1", [image(png(1))], 1),
			toolUse(
				"t2",
				"mcp__playwright__browser_take_screenshot",
				{ filename: "board.png" },
				2,
			),
			toolResult(
				"t2",
				[{ type: "text", text: "saved" }, image(png(2), "image/jpeg")],
				2,
			),
			pasted([image(png(9)), { type: "text", text: "look" }], 3),
			toolUse("t3", "Screenshot", {}, 4),
			toolResult("t3", [image(png(3))], 4),
		]);
		const shots = await collectShots(session(), {
			dir,
			claudeHome: home,
			limit: 2,
		});
		assert.deepEqual(shots, [
			{
				url: `/api/report-shots/${sha(png(2))}.jpg`,
				caption: "board.png",
				at: Date.parse(at(2)),
			},
			{
				url: `/api/report-shots/${sha(png(3))}.png`,
				caption: "Screenshot",
				at: Date.parse(at(4)),
			},
		]);
		assert.deepEqual(await readFile(join(dir, `${sha(png(3))}.png`)), png(3));
	});

	it("fills with pasted images when tool results run short and dedupes files", async () => {
		const { home, dir } = await setup([
			toolUse("t1", "Read", { file_path: "/tmp/one.png" }, 1),
			toolResult("t1", [image(png(1))], 1),
			pasted([image(png(1))], 2),
			pasted([image(png(5))], 3),
		]);
		const shots = await collectShots(session(), { dir, claudeHome: home });
		assert.deepEqual(
			shots.map(({ caption }) => caption),
			["/tmp/one.png", "Screenshot", "Screenshot"],
		);
		assert.equal((await readdir(dir)).length, 2);
		const again = await collectShots(session(), { dir, claudeHome: home });
		assert.deepEqual(again, shots);
		assert.equal((await readdir(dir)).length, 2);
	});

	it("skips oversized and unsupported images", async () => {
		const { home, dir } = await setup([
			toolResult("t1", [image(Buffer.alloc(maxImageBytes + 1))], 1),
			toolResult("t2", [image(png(1), "image/tiff")], 2),
		]);
		assert.deepEqual(
			await collectShots(session(), { dir, claudeHome: home }),
			[],
		);
	});

	it("uses the session's configDir over the default home", async () => {
		const { home, dir } = await setup([toolResult("t1", [image(png(1))], 1)]);
		const shots = await collectShots(session({ configDir: home }), {
			dir,
			claudeHome: "/nonexistent",
		});
		assert.equal(shots.length, 1);
	});

	it("returns [] for cloud sessions, missing transcripts and no dir", async () => {
		const { home, dir } = await setup([toolResult("t1", [image(png(1))], 1)]);
		assert.deepEqual(
			await collectShots(session({ cloud: { url: "https://x" } }), {
				dir,
				claudeHome: home,
			}),
			[],
		);
		assert.deepEqual(
			await collectShots(session({ id: "missing" }), { dir, claudeHome: home }),
			[],
		);
		assert.deepEqual(await collectShots(session(), { claudeHome: home }), []);
	});
});

describe("report shot route", () => {
	const name = `${"a".repeat(64)}.png`;
	const route = (path: string, method = "GET") =>
		matchRoute(method, new URL(path, "http://kanban.invalid"));

	it("accepts strict hashed names only", () => {
		assert.deepEqual(route(`/api/report-shots/${name}`), {
			kind: "report-shot",
			name,
		});
		assert.deepEqual(route("/api/report-shots/..%2Fsecret.png"), {
			kind: "not-found",
		});
		assert.deepEqual(route(`/api/report-shots/${"A".repeat(64)}.png`), {
			kind: "not-found",
		});
		assert.deepEqual(route(`/api/report-shots/${"a".repeat(64)}.svg`), {
			kind: "not-found",
		});
		assert.deepEqual(route(`/api/report-shots/${name}`, "POST"), {
			kind: "method-not-allowed",
		});
	});

	it("maps extensions to content types", () => {
		assert.equal(reportShotContentType(name), "image/png");
		assert.equal(reportShotContentType(`${"b".repeat(64)}.jpg`), "image/jpeg");
		assert.equal(reportShotContentType("x.png"), null);
	});
});
