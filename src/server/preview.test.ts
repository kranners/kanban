import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Board, Preview, Session } from "../shared/types.ts";
import { createPreviewer, renderPreview } from "./preview.ts";

const session = (overrides: Partial<Session>): Session => ({
	id: "s1",
	short: "abcd1234",
	pid: 1,
	name: "acme-api",
	cwd: "/Users/me/dev/acme-api",
	project: "acme-api",
	kind: "background",
	activity: "working",
	doing: null,
	needs: null,
	startedAt: 0,
	updatedAt: 0,
	attachable: true,
	...overrides,
});

const boardOf = (sessions: Session[]): Board => ({
	sessions,
	subagents: [],
	links: [],
	messages: [],
	generatedAt: 0,
});

describe("renderPreview", () => {
	it("returns a pre fragment of the last rows with inline styles", async () => {
		const lines = Array.from({ length: 40 }, (_, index) => `line ${index}`);
		const html = await renderPreview(
			`${lines.join("\r\n")}\r\n\x1b[31m<red>\x1b[0m\r\n\r\n`,
		);
		assert.match(html, /^<pre><div>/);
		assert.match(html, /<\/div><\/pre>$/);
		assert.ok(!html.includes("<html>"));
		assert.ok(!html.includes("line 16<"), "older rows are dropped");
		assert.ok(html.includes("line 17"));
		assert.ok(html.includes("&lt;red>"));
		assert.match(html, /style='color: #cc0000;'/);
		assert.equal(html.match(/<div>/g)?.length, 24);
	});
});

describe("createPreviewer", () => {
	it("polls working sessions, others when they change, and emits only changes", async () => {
		let board = boardOf([
			session({ id: "busy", short: "aaaaaaaa", activity: "working" }),
			session({ id: "quiet", short: "bbbbbbbb", activity: "idle" }),
			session({ id: "term", short: null, kind: "interactive" }),
		]);
		const calls: string[] = [];
		const output: Record<string, string> = {
			aaaaaaaa: "one",
			bbbbbbbb: "idle",
		};
		const emitted: Preview[] = [];
		const previewer = createPreviewer({
			board: () => board,
			logs: async (short) => {
				calls.push(short);
				return output[short] ?? "";
			},
			emit: (preview) => emitted.push(preview),
			intervalMs: 60_000,
		});
		previewer.start();
		await previewer.tick();
		assert.deepEqual(calls.sort(), ["aaaaaaaa", "bbbbbbbb"]);
		assert.deepEqual(emitted.map((preview) => preview.sessionId).sort(), [
			"busy",
			"quiet",
		]);

		calls.length = 0;
		emitted.length = 0;
		await previewer.tick();
		assert.deepEqual(calls, ["aaaaaaaa"]);
		assert.equal(emitted.length, 0);

		output.aaaaaaaa = "two";
		await previewer.tick();
		assert.deepEqual(
			emitted.map((preview) => preview.sessionId),
			["busy"],
		);
		assert.ok(emitted[0]?.html.includes("two"));

		calls.length = 0;
		board = boardOf([
			session({ id: "busy", short: "aaaaaaaa", activity: "working" }),
			session({
				id: "quiet",
				short: "bbbbbbbb",
				activity: "idle",
				updatedAt: 5,
			}),
		]);
		await previewer.tick();
		assert.deepEqual(calls.sort(), ["aaaaaaaa", "bbbbbbbb"]);

		board = boardOf([]);
		await previewer.tick();
		assert.deepEqual(previewer.latest(), []);
		previewer.stop();
	});

	it("does not retry a failing idle session every tick", async () => {
		let calls = 0;
		const previewer = createPreviewer({
			board: () => boardOf([session({ activity: "stopped" })]),
			logs: async () => {
				calls++;
				throw new Error("no logs");
			},
			emit: () => {},
			intervalMs: 60_000,
		});
		previewer.start();
		await previewer.tick();
		await previewer.tick();
		previewer.stop();
		assert.equal(calls, 1);
	});
});
