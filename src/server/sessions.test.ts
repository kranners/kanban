import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { describe, it } from "node:test";
import { maxImageBytes, maxPromptImages } from "../shared/promptImages.ts";
import {
	claudeLauncher,
	launchArgs,
	launchResult,
	parseBackgrounded,
	saveImages,
	validateNewSession,
} from "./sessions.ts";

const valid = { cwd: tmpdir(), name: "acme-api fix", prompt: "say hi" };

describe("validateNewSession", () => {
	it("accepts a request for an existing directory", async () => {
		assert.deepEqual(await validateNewSession({ ...valid, name: "  acme  " }), {
			...valid,
			name: "acme",
		});
	});

	it("leaves the name to Claude Code when it is missing or blank", async () => {
		const { name: _name, ...unnamed } = valid;
		assert.deepEqual(await validateNewSession(unnamed), unnamed);
		assert.deepEqual(
			await validateNewSession({ ...valid, name: "  " }),
			unnamed,
		);
		assert.deepEqual(launchArgs(unnamed), ["--bg", "--", "say hi"]);
		assert.deepEqual(launchArgs(valid), [
			"--bg",
			"--name=acme-api fix",
			"--",
			"say hi",
		]);
	});

	it("keeps the board point a session should spawn at", async () => {
		assert.deepEqual(
			await validateNewSession({ ...valid, at: { x: -40, y: 120, z: 1 } }),
			{ ...valid, at: { x: -40, y: 120 } },
		);
	});

	it("rejects bad input with a reason", async () => {
		const cases: [unknown, RegExp][] = [
			[null, /JSON object/],
			[{ ...valid, cwd: "dev/acme-api" }, /absolute/],
			[{ ...valid, cwd: "/Users/me/dev/acme-api-missing" }, /not an existing/],
			[{ ...valid, cwd: import.meta.filename }, /not an existing directory/],
			[{ ...valid, name: 7 }, /name must be a string/],
			[{ ...valid, name: "x".repeat(61) }, /at most 60/],
			[{ ...valid, name: "two\nlines" }, /one line/],
			[{ ...valid, prompt: "   " }, /prompt is required/],
			[{ ...valid, at: { x: 1 } }, /at must be a point/],
			[{ ...valid, at: { x: 1, y: Number.NaN } }, /at must be a point/],
		];
		for (const [body, reason] of cases) {
			const result = await validateNewSession(body);
			assert.ok("error" in result, JSON.stringify(body));
			assert.match(result.error, reason);
		}
	});
});

describe("launchResult", () => {
	it("parses the short from claude --bg output", () => {
		assert.equal(
			parseBackgrounded("backgrounded · 1ca86d73 · acme\n"),
			"1ca86d73",
		);
		assert.deepEqual(
			launchResult("/x", "backgrounded · 1ca86d73 · acme\n", ""),
			{
				ok: true,
				short: "1ca86d73",
			},
		);
	});

	it("explains an untrusted workspace", () => {
		const result = launchResult(
			"/Users/me/dev/acme-api",
			"",
			"\x1b[31mWorkspace not trusted. Run claude in /Users/me/dev/acme-api once\x1b[0m",
		);
		assert.equal(result.ok, false);
		assert.match(
			result.ok ? "" : result.error,
			/^Workspace not trusted: run claude in \/Users\/me\/dev\/acme-api once/,
		);
	});

	it("surfaces the last line of other failures", () => {
		assert.deepEqual(launchResult("/x", "", "warming up\nboom\n"), {
			ok: false,
			error: "claude --bg failed: boom",
		});
	});
});

describe("prompt images", () => {
	const png = {
		type: "image/png",
		data: Buffer.from("png bytes").toString("base64"),
	};

	it("keeps attached images", async () => {
		assert.deepEqual(await validateNewSession({ ...valid, images: [png] }), {
			...valid,
			images: [png],
		});
		assert.deepEqual(await validateNewSession({ ...valid, images: [] }), valid);
	});

	it("rejects images it can't hand to Claude", async () => {
		const tooBig = "AAAA".repeat(Math.ceil(maxImageBytes / 3) + 1);
		const cases: [unknown, RegExp][] = [
			["png", /images must be/],
			[[{ ...png, type: "image/svg+xml" }], /images must be/],
			[[{ ...png, data: "not base64!" }], /images must be/],
			[[{ ...png, data: "" }], /images must be/],
			[Array(maxPromptImages + 1).fill(png), /at most 8 images/],
			[[{ ...png, data: tooBig }], /at most 5 MB/],
		];
		for (const [images, reason] of cases) {
			const result = await validateNewSession({ ...valid, images });
			assert.ok("error" in result, JSON.stringify(images).slice(0, 80));
			assert.match(result.error, reason);
		}
	});

	it("saves images where the session may read them", async () => {
		const dir = await mkdtemp(join(tmpdir(), "kanban-images-"));
		try {
			const saved = await saveImages(join(dir, "images"), [
				png,
				{ type: "image/jpeg", data: png.data },
			]);
			assert.deepEqual(
				saved.paths.map((path) => relative(saved.folder, path)),
				["image-1.png", "image-2.jpg"],
			);
			assert.equal(
				await readFile(saved.paths[0] as string, "utf8"),
				"png bytes",
			);
			assert.deepEqual(launchArgs({ ...valid, images: [png] }, saved), [
				"--bg",
				"--name=acme-api fix",
				`--add-dir=${saved.folder}`,
				"--",
				`say hi\n\n${saved.paths[0]}\n\n${saved.paths[1]}`,
			]);
		} finally {
			await rm(dir, { recursive: true });
		}
	});

	it("reports images it can't save instead of launching", async () => {
		const launch = claudeLauncher("/bin/false", import.meta.filename);
		const result = await launch({ ...valid, images: [png] });
		assert.equal(result.ok, false);
		assert.match(result.ok ? "" : result.error, /Couldn't save the images/);
	});
});
