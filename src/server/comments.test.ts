import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { CommentThread } from "../shared/types.ts";
import {
	createCommentStore,
	loadComments,
	maxEvents,
	maxThreads,
	parseCommentDraft,
	parseCommentPatch,
	parseComments,
} from "./comments.ts";

const sessionId = "0a1b2c3d-0000-4000-8000-000000000001";

const thread = (id: string, extra: Partial<CommentThread> = {}) => ({
	id,
	x: 10,
	y: 20,
	createdAt: 1,
	updatedAt: 2,
	resolved: false,
	running: false,
	sessionId,
	resumable: true,
	events: [],
	...extra,
});

describe("comment parsing", () => {
	it("validates drafts and patches", () => {
		assert.deepEqual(parseCommentDraft({ x: 1, y: 2, text: "hi" }), {
			x: 1,
			y: 2,
			text: "hi",
		});
		assert.match(
			(parseCommentDraft({ x: 1, y: 2, text: "  " }) as { error: string })
				.error,
			/text/,
		);
		assert.match(
			(parseCommentDraft({ x: "1", y: 2, text: "a" }) as { error: string })
				.error,
			/x and y/,
		);
		assert.match(
			(
				parseCommentDraft({ x: 1, y: 2, text: "a".repeat(4001) }) as {
					error: string;
				}
			).error,
			/4000/,
		);
		assert.deepEqual(parseCommentPatch({ resolved: true }), { resolved: true });
		assert.deepEqual(parseCommentPatch({ x: 5, y: 6 }), { x: 5, y: 6 });
		assert.ok("error" in parseCommentPatch({ x: 5 }));
		assert.ok("error" in parseCommentPatch({ resolved: "yes" }));
		assert.ok("error" in parseCommentPatch({}));
	});

	it("keeps a known button on drafts and threads", () => {
		assert.deepEqual(
			parseCommentDraft({ x: 0, y: 0, text: "t", button: "snooze" }),
			{ x: 0, y: 0, text: "t", button: "snooze" },
		);
		for (const button of ["nap", 1]) {
			assert.deepEqual(parseCommentDraft({ x: 0, y: 0, text: "t", button }), {
				error: "button must be tidy or snooze",
			});
		}
		assert.equal(
			"button" in parseCommentDraft({ x: 0, y: 0, text: "t" }),
			false,
		);
		const [tidy, unknown] = parseComments([
			thread("a", { button: "tidy" }),
			{ ...thread("b"), button: "nap" },
		]);
		assert.equal(tidy?.button, "tidy");
		assert.equal(unknown && "button" in unknown, false);
	});

	it("keeps valid threads, drops bad ones and settles interrupted runs", () => {
		const parsed = parseComments([
			thread("a", {
				running: true,
				events: [
					{ kind: "user", at: 1, text: "go" },
					{
						kind: "action",
						at: 2,
						id: "t1",
						text: "Arranging",
						state: "running",
					},
					{ kind: "bogus", at: 3, text: "x" } as never,
				],
			}),
			thread("a"),
			thread("../b"),
			{ ...thread("c"), sessionId: "not-a-uuid" },
			{ ...thread("d"), x: Number.POSITIVE_INFINITY },
			null,
		]);
		assert.deepEqual(
			parsed.map((t) => t.id),
			["a"],
		);
		assert.equal(parsed[0]?.running, false);
		assert.deepEqual(parsed[0]?.events, [
			{ kind: "user", at: 1, text: "go" },
			{ kind: "action", at: 2, id: "t1", text: "Arranging", state: "failed" },
		]);
		assert.deepEqual(parseComments({}), []);
		assert.equal(
			parseComments(
				Array.from({ length: maxThreads + 5 }, (_, i) => thread(`t${i}`)),
			).length,
			maxThreads,
		);
	});
});

describe("comment store", () => {
	it("creates, updates, removes and persists threads atomically", async () => {
		const dir = await mkdtemp(join(tmpdir(), "kanban-comments-"));
		const file = join(dir, "comments.json");
		const changed: string[] = [];
		const removed: number[] = [];
		let id = 0;
		const store = createCommentStore({
			file,
			initial: [],
			onChange: (t) => changed.push(t.id),
			onRemove: (all) => removed.push(all.length),
			newId: () => `thread-${++id}`,
			now: () => 100,
		});
		const created = store.create({ x: 1, y: 2, text: "hi" });
		assert.ok(created);
		assert.equal(created.id, "thread-1");
		assert.ok(store.owns(created.sessionId));
		assert.equal(store.owns("0f0f0f0f-0000-4000-8000-000000000000"), false);
		const many = Array.from({ length: maxEvents + 10 }, (_, at) => ({
			kind: "reply" as const,
			at,
			text: `${at}`,
		}));
		const updated = store.update("thread-1", (t) => ({
			...t,
			id: "hijack",
			events: many,
		}));
		assert.equal(updated?.id, "thread-1");
		assert.equal(updated?.events.length, maxEvents);
		assert.equal(updated?.events[0]?.at, 10);
		assert.equal(
			store.update("missing", (t) => t),
			null,
		);
		store.create({ x: 3, y: 4, text: "two" });
		assert.ok(store.remove("thread-2"));
		assert.equal(store.remove("thread-2"), false);
		assert.deepEqual(changed, ["thread-1", "thread-1", "thread-2"]);
		assert.deepEqual(removed, [1]);
		assert.equal(
			store.create({ x: 0, y: 0, text: "tidy", button: "tidy" })?.button,
			"tidy",
		);
		await store.saved();
		const loaded = await loadComments(file);
		assert.deepEqual(
			loaded.map((t) => [t.id, t.button]),
			[
				["thread-1", undefined],
				["thread-3", "tidy"],
			],
		);
		assert.equal(JSON.parse(await readFile(file, "utf8")).length, 2);
	});

	it("refuses new threads at the cap and loads a corrupt file as empty", async () => {
		const dir = await mkdtemp(join(tmpdir(), "kanban-comments-"));
		const file = join(dir, "comments.json");
		await writeFile(file, "{not json");
		assert.deepEqual(await loadComments(file), []);
		const store = createCommentStore({
			file,
			initial: Array.from({ length: maxThreads }, (_, i) => thread(`t${i}`)),
			onChange: () => {},
			onRemove: () => {},
		});
		assert.equal(store.create({ x: 0, y: 0, text: "one too many" }), null);
	});
});
