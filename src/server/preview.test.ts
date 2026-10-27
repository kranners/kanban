import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type {
	Board,
	Preview,
	Session,
	TranscriptEntry,
} from "../shared/types.ts";
import {
	createPreviewer,
	previewEntryCount,
	renderTranscriptPreview,
} from "./preview.ts";

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
	cmux: false,
	...overrides,
});

const boardOf = (sessions: Session[]): Board => ({
	sessions,
	subagents: [],
	subagentCounts: {},
	links: [],
	messages: [],
	generatedAt: 0,
});

const entry = (
	role: TranscriptEntry["role"],
	text: string,
): TranscriptEntry => ({ at: 0, role, text });

describe("renderTranscriptPreview", () => {
	it("renders each role the way Claude Code shows it, oldest first", () => {
		const html = renderTranscriptPreview([
			entry("user", "fix the <auth> bug"),
			entry("assistant", "Looking now."),
			entry("tool", "Bash: npm test -- --filter auth"),
			entry("tool", "TodoWrite"),
			entry("peer", "acme-lead: please rebase"),
		]);
		assert.equal(
			html,
			[
				'<div class="tx tx-user"><span class="tx-mark">&gt;</span> fix the &lt;auth&gt; bug</div>',
				'<div class="tx tx-assistant"><span class="tx-mark">●</span> Looking now.</div>',
				'<div class="tx tx-tool"><span class="tx-mark">●</span> <b>Bash</b>(npm test -- --filter auth)</div>',
				'<div class="tx tx-tool"><span class="tx-mark">●</span> <b>TodoWrite</b></div>',
				'<div class="tx tx-peer"><span class="tx-mark">✉</span> acme-lead: please rebase</div>',
			].join(""),
		);
	});

	it("escapes markup and quotes", () => {
		const html = renderTranscriptPreview([
			entry("assistant", `<img src=x onerror="alert('x')"> & more`),
		]);
		assert.ok(!html.includes("<img"));
		assert.ok(
			html.includes(
				"&lt;img src=x onerror=&quot;alert(&#39;x&#39;)&quot;&gt; &amp; more",
			),
		);
	});

	it("keeps long entries compact and skips blank ones", () => {
		const long = Array.from({ length: 10 }, (_, index) => `line ${index}`);
		const html = renderTranscriptPreview([
			entry("assistant", `\n\n${long.join("\n\n")}`),
			entry("assistant", "   "),
			entry("user", "x".repeat(500)),
		]);
		assert.equal(html.match(/<div/g)?.length, 2);
		assert.ok(html.includes("line 0\nline 1\nline 2\nline 3\n…"));
		assert.ok(!html.includes("line 4"));
		assert.ok(html.includes(`${"x".repeat(199)}…`));
		assert.ok(!html.includes("x".repeat(200)));
	});
});

describe("createPreviewer", () => {
	it("renders every kind of session when it changes and emits only changes", async () => {
		const entries: Record<string, TranscriptEntry[]> = {
			bg: [entry("assistant", "one")],
			term: [entry("user", "hello")],
			empty: [],
		};
		const reads: [string, number][] = [];
		const emitted: Preview[] = [];
		const previewer = createPreviewer({
			transcript: async (sessionId, limit) => {
				reads.push([sessionId, limit]);
				return entries[sessionId] ?? [];
			},
			emit: (preview) => emitted.push(preview),
			now: () => 7,
		});
		const sessions = [
			session({ id: "bg" }),
			session({ id: "term", kind: "interactive", short: null }),
			session({ id: "empty" }),
		];

		await previewer.update(boardOf(sessions));
		assert.deepEqual(reads, [
			["bg", previewEntryCount],
			["term", previewEntryCount],
			["empty", previewEntryCount],
		]);
		assert.deepEqual(
			emitted.map((preview) => [preview.sessionId, preview.capturedAt]),
			[
				["bg", 7],
				["term", 7],
			],
		);

		reads.length = 0;
		emitted.length = 0;
		await previewer.update(boardOf(sessions));
		assert.deepEqual(reads, [], "unchanged sessions are not reread");

		await previewer.update(
			boardOf([session({ id: "bg", updatedAt: 1 }), ...sessions.slice(1)]),
		);
		assert.deepEqual(reads, [["bg", previewEntryCount]]);
		assert.equal(emitted.length, 0, "same transcript, nothing to send");

		entries.bg = [entry("assistant", "two")];
		await previewer.update(
			boardOf([session({ id: "bg", updatedAt: 2 }), ...sessions.slice(1)]),
		);
		assert.deepEqual(
			emitted.map((preview) => preview.sessionId),
			["bg"],
		);
		assert.ok(emitted[0]?.html.includes("two"));

		await previewer.update(boardOf([session({ id: "bg", updatedAt: 2 })]));
		assert.deepEqual(
			previewer.latest().map((preview) => preview.sessionId),
			["bg"],
		);
	});

	it("does not retry a failing session until it changes", async () => {
		let calls = 0;
		const previewer = createPreviewer({
			transcript: async () => {
				calls++;
				throw new Error("unreadable");
			},
			emit: () => {},
		});
		const board = boardOf([session({ activity: "stopped" })]);
		await previewer.update(board);
		await previewer.update(board);
		assert.equal(calls, 1);
		assert.deepEqual(previewer.latest(), []);
	});
});
