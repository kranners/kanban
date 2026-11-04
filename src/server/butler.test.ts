import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { ToolCall } from "../agent/tools.ts";
import {
	aaronFocusStaleMs,
	type Board,
	type ButlerCard,
	type ButlerPresence,
	type Note,
	type Session,
} from "../shared/types.ts";
import { createAnnotationStore } from "./annotations.ts";
import type { AuditEvent } from "./audit.ts";
import {
	butlerAllowed,
	createButler,
	loadWatching,
	parseFocusReport,
	selfFixState,
} from "./butler.ts";
import { createCommentStore } from "./comments.ts";
import { createLayoutStore } from "./layout.ts";
import { createRegionStore } from "./regions.ts";

const session = (id: string): Session => ({
	id,
	short: `${id.slice(0, 7)}0`,
	pid: 1,
	name: `acme-${id.slice(0, 3)}`,
	cwd: "/tmp",
	project: "tmp",
	kind: "background",
	activity: "working",
	doing: null,
	needs: null,
	goal: null,
	startedAt: 0,
	updatedAt: 0,
	attachable: true,
	cmux: false,
	artifacts: [],
	tasks: [],
	steps: [],
});

const board: Board = {
	sessions: [session("aaaaaaaa-1")],
	subagents: [],
	subagentCounts: {},
	subagentStates: {},
	workflowRuns: {},
	workflows: [],
	links: [],
	messages: [],
	generatedAt: 0,
};

const setup = async () => {
	const dir = await mkdtemp(join(tmpdir(), "kanban-butler-"));
	const layout = createLayoutStore({
		file: join(dir, "l.json"),
		initial: {},
		onChange: () => {},
	});
	const annotations = createAnnotationStore({
		file: join(dir, "a.json"),
		initial: {},
		onChange: () => {},
	});
	const regions = createRegionStore({
		file: join(dir, "r.json"),
		initial: [],
		onChange: () => {},
	});
	const calls: [string, ToolCall][] = [];
	const events: AuditEvent[] = [];
	const presences: ButlerPresence[] = [];
	let ids = 0;
	let clock = 1000;
	const file = join(dir, "butler.json");
	const comments = createCommentStore({
		file: join(dir, "c.json"),
		initial: [],
		onChange: () => {},
		onRemove: () => {},
	});
	const butler = createButler({
		source: {
			board: () => board,
			transcript: async () => [],
			transcriptPath: () => null,
		},
		layout,
		annotations,
		regions,
		tools: async (thread, call) => {
			calls.push([thread, call]);
			return { ok: true, text: `ran ${call.tool}` };
		},
		audit: (event) => events.push(event),
		file,
		initial: [],
		onChange: (next) => presences.push(next),
		comments,
		newId: () => `id${++ids}`,
		now: () => clock,
	});
	return {
		butler,
		comments,
		annotations,
		calls,
		events,
		presences,
		file,
		tick: (ms: number) => {
			clock += ms;
		},
	};
};

const cardOf = (
	annotations: { current(): Record<string, unknown> },
	id: string,
) => annotations.current()[id] as ButlerCard;

describe("Butler on the board", () => {
	it("answers a message about a card on the card too, in one note it keeps", async () => {
		const { butler, comments, annotations } = await setup();
		const inbox = butler.inbox;
		assert.ok(inbox);
		const thread = inbox.start({
			x: -9999,
			y: -9999,
			text: "how is it going?",
		});
		assert.ok(!("error" in thread));
		comments.update(thread.id, (t) => ({
			...t,
			context: {
				card: { id: "aaaaaaaa-1", kind: "session", name: "acme-aaa" },
			},
		}));
		const { messages } = JSON.parse(
			((await butler.tool("board_inbox", {})) as { text: string }).text,
		);
		assert.equal(messages.length, 1);
		await butler.tool("board_ack", { ids: [messages[0].id] });
		const first = await butler.tool("board_reply", {
			thread: thread.id,
			message: messages[0].id,
			text: "Tests are green.",
		});
		assert.deepEqual(first, {
			ok: true,
			text: "Shown on the board and noted on acme-aaa",
		});
		const noteId = comments.get(thread.id)?.replyNote;
		assert.ok(noteId);
		const pinned = annotations.current()[noteId] as Note;
		assert.equal(pinned.author, "butler");
		assert.equal(pinned.session, "aaaaaaaa-1");
		await butler.tool("board_reply", {
			thread: thread.id,
			message: "other",
			text: "Landed.",
		});
		assert.equal(comments.get(thread.id)?.replyNote, noteId);
		assert.equal((annotations.current()[noteId] as Note).text, "Landed.");
		assert.equal(
			Object.values(annotations.current()).filter((a) => a.kind === "note")
				.length,
			1,
		);
		assert.deepEqual(await butler.tool("board_reply", { thread: "gone" }), {
			ok: false,
			error: "message is required",
		});
	});

	it("creates, renames, moves and closes his own cards", async () => {
		const { butler, annotations, presences } = await setup();
		const created = await butler.tool("put_card", {
			title: "Book the dentist",
			state: "working",
		});
		assert.equal(created.ok, true);
		const card = cardOf(annotations, "butler-id1");
		assert.equal(card.kind, "butler-card");
		assert.equal(card.title, "Book the dentist");
		assert.equal(presences.at(-1)?.working?.target, "butler-id1");

		await butler.tool("put_card", {
			id: "butler-id1",
			title: "Dentist booked",
			state: "done",
			x: 2400,
			y: 48,
		});
		const renamed = cardOf(annotations, "butler-id1");
		assert.equal(renamed.title, "Dentist booked");
		assert.equal(renamed.state, "done");
		assert.deepEqual([renamed.x, renamed.y], [2400, 48]);

		const closed = await butler.tool("close_card", { id: "butler-id1" });
		assert.equal(closed.ok, true);
		assert.equal(annotations.current()["butler-id1"], undefined);
	});

	it("refuses to treat a session as one of his cards", async () => {
		const { butler } = await setup();
		const closing = await butler.tool("close_card", { id: "aaaaaaaa-1" });
		assert.equal(closing.ok, false);
		assert.match(closing.ok ? "" : closing.error, /finish_session/);
		const naming = await butler.tool("put_card", {
			id: "aaaaaaaa-1",
			title: "x",
		});
		assert.equal(naming.ok, false);
		const bad = await butler.tool("put_card", { title: "x", state: "lost" });
		assert.equal(bad.ok, false);
		const link = await butler.tool("put_card", {
			title: "x",
			link: "javascript:alert(1)",
		});
		assert.equal(link.ok, false);
	});

	it("signs his notes and pins them beside the card they are about", async () => {
		const { butler, annotations, presences } = await setup();
		const added = await butler.tool("note", {
			target: "aaaaaaaa-1",
			text: "Aaron wants this merged by Friday",
		});
		assert.equal(added.ok, true);
		const note = annotations.current()["butler-note-id1"] as Note;
		assert.equal(note.kind, "note");
		assert.equal(note.author, "butler");
		assert.equal(note.session, "aaaaaaaa-1");
		assert.equal(presences.at(-1)?.working?.target, "aaaaaaaa-1");
		const missing = await butler.tool("note", { target: "nope", text: "x" });
		assert.equal(missing.ok, false);
		const unsigned = await butler.tool("put_note", { text: "x" });
		assert.equal(unsigned.ok, false);
	});

	it("watches sessions and remembers them", async () => {
		const { butler, file } = await setup();
		await butler.tool("watch", { target: "aaaaaaa0" });
		assert.deepEqual(butler.current().watching, ["aaaaaaaa-1"]);
		await butler.saved();
		assert.deepEqual(await loadWatching(file), ["aaaaaaaa-1"]);
		JSON.parse(await readFile(file, "utf8"));
		await butler.tool("watch", { target: "aaaaaaaa-1", watching: false });
		assert.deepEqual(butler.current().watching, []);
	});

	it("mirrors self-fixes as cards, keeping where they were put", async () => {
		const { butler, annotations, tick } = await setup();
		const fix = {
			id: "20261103-014125-2712401",
			state: "running",
			title: "Butler kanban collaborator",
			link: "https://claude.ai/code/session_01abc",
			summary: "- ran Bash: npm run check",
			watching: true,
		};
		const first = await butler.tool("self_fixes", { fixes: [fix] });
		assert.equal(first.ok, true);
		const id = "self-fix-20261103-014125-2712401";
		const card = cardOf(annotations, id);
		assert.equal(card.state, "working");
		assert.equal(card.selfFix, fix.id);
		assert.equal(card.watching, true);
		assert.equal(card.link, fix.link);

		annotations.put({ ...card, x: 4800, y: 960 });
		tick(60_000);
		await butler.tool("self_fixes", {
			fixes: [{ ...fix, state: "waiting on input (AskUserQuestion)" }],
		});
		const waiting = cardOf(annotations, id);
		assert.equal(waiting.state, "needs-you");
		assert.equal(waiting.status, "waiting on input (AskUserQuestion)");
		assert.deepEqual([waiting.x, waiting.y], [4800, 960]);
		assert.equal(waiting.updatedAt, 61_000);

		tick(60_000);
		await butler.tool("self_fixes", {
			fixes: [{ ...fix, state: "waiting on input (AskUserQuestion)" }],
		});
		assert.equal(cardOf(annotations, id).updatedAt, 61_000);

		await butler.tool("self_fixes", { fixes: [] });
		assert.equal(annotations.current()[id], undefined);

		const bad = await butler.tool("self_fixes", {
			fixes: [{ id: "../../etc", state: "running" }],
		});
		assert.equal(bad.ok, false);
	});

	it("takes Aaron's board actions on a self-fix back to spike", async () => {
		const { butler, annotations, file } = await setup();
		const fix = {
			id: "20261101-021240-797168",
			state: "waiting on input (AskUserQuestion)",
			title: "Butler scheduled jobs",
			link: "https://claude.ai/code/session_abc",
		};
		const other = { ...fix, id: "20261102-000000-1", title: "Other" };
		await butler.tool("self_fixes", { fixes: [fix, other] });
		const id = "self-fix-20261101-021240-797168";

		const dismissed = butler.selfFixAction(fix.id, "dismiss");
		assert.equal(dismissed.ok, true);
		assert.equal(cardOf(annotations, id).state, "done");
		const again = await butler.tool("self_fixes", { fixes: [fix, other] });
		assert.equal(cardOf(annotations, id).state, "done");
		assert.match(
			cardOf(annotations, id).status ?? "",
			/^dismissed on the board/,
		);
		assert.match(
			again.ok ? again.text : "",
			/Board actions: \{"archive":\[\],"dismiss":\["20261101-021240-797168"\]\}/,
		);

		// Closing a self-fix's card archives it, and the sync never brings it back.
		const closed = await butler.tool("close_card", { selfFix: other.id });
		assert.equal(closed.ok, true);
		assert.match(closed.ok ? closed.text : "", /archives/);
		const synced = await butler.tool("self_fixes", { fixes: [fix, other] });
		assert.equal(
			annotations.current()["self-fix-20261102-000000-1"],
			undefined,
		);
		assert.match(
			synced.ok ? synced.text : "",
			/"archive":\["20261102-000000-1"\]/,
		);
		await butler.saved();
		const saved = JSON.parse(await readFile(file, "utf8"));
		assert.equal(saved.selfFixActions[other.id], "archive");

		// Once spike stops listing a fix, the board forgets what was done to it.
		const later = await butler.tool("self_fixes", { fixes: [fix] });
		assert.match(later.ok ? later.text : "", /"archive":\[\]/);
	});

	it("addresses a self-fix's card by its self-fix id, never duplicating it", async () => {
		const { butler, annotations } = await setup();
		const fix = {
			id: "20261103-014125-2712401",
			state: "running",
			title: "Fix",
		};
		await butler.tool("self_fixes", { fixes: [fix] });
		const id = "self-fix-20261103-014125-2712401";

		const moved = await butler.tool("put_card", {
			selfFix: fix.id,
			x: 2400,
			y: 0,
		});
		assert.equal(moved.ok, true);
		assert.equal(cardOf(annotations, id).x, 2400);
		const renamed = await butler.tool("put_card", {
			selfFix: fix.id,
			title: "x",
		});
		assert.equal(renamed.ok, false);
		const fresh = await butler.tool("put_card", {
			selfFix: "20261104-000000-1",
			title: "Dup",
		});
		assert.equal(fresh.ok, false);
		const butlerCards = Object.values(annotations.current()).filter(
			(a) => a.kind === "butler-card",
		);
		assert.equal(butlerCards.length, 1);

		const noted = await butler.tool("note", {
			target: fix.id,
			text: "Aaron says ship it",
		});
		assert.equal(noted.ok, true);
		const watched = await butler.tool("watch", { target: fix.id });
		assert.equal(watched.ok, true);
		await butler.tool("self_fixes", { fixes: [fix] });
		assert.equal(cardOf(annotations, id).watching, true);
		const looked = await butler.tool("look", { target: fix.id });
		assert.equal(looked.ok, true);
		assert.equal(butler.current().looking?.target, id);
	});

	it("takes a change's id as change or its old name selfFix, and syncs by either tool name", async () => {
		const { butler, annotations } = await setup();
		const fix = {
			id: "20261103-224306-1143434",
			state: "running",
			title: "Rename",
		};
		const synced = await butler.tool("changes", { fixes: [fix] });
		assert.match(synced.ok ? synced.text : "", /^1 change card: 1 updated/);
		const id = "self-fix-20261103-224306-1143434";
		const moved = await butler.tool("put_card", {
			change: fix.id,
			x: 1200,
			y: 0,
		});
		assert.equal(moved.ok, true);
		assert.equal(cardOf(annotations, id).x, 1200);
		await butler.tool("self_fixes", { fixes: [fix] });
		const old = await butler.tool("put_card", {
			selfFix: fix.id,
			x: 2400,
			y: 0,
		});
		assert.equal(old.ok, true);
		assert.equal(cardOf(annotations, id).x, 2400);
		const closed = await butler.tool("close_card", { change: fix.id });
		assert.equal(closed.ok, true);
		assert.match(
			closed.ok ? closed.text : "",
			/archives the change's cloud session/,
		);
	});

	it("drives the board agent's tools under his own name", async () => {
		const { butler, calls, presences } = await setup();
		const sent = await butler.tool("send_prompt", {
			session: "aaaaaaaa-1",
			text: "Please rebase",
		});
		assert.equal(sent.ok, true);
		assert.equal(calls[0]?.[0], "butler");
		assert.equal(calls[0]?.[1].tool, "send_prompt");
		assert.equal(presences.at(-1)?.working?.target, "aaaaaaaa-1");
		const snapshot = await butler.tool("board_snapshot", {});
		assert.match(snapshot.ok ? snapshot.text : "", /Butler watches: \[\]/);
		const unknown = await butler.tool("rm_rf", {});
		assert.equal(unknown.ok, false);
	});

	it("looks at a card, labelled, and steps away", async () => {
		const { butler } = await setup();
		await butler.tool("look", { target: "aaaaaaaa-1", label: "Butler" });
		assert.equal(butler.current().looking?.target, "aaaaaaaa-1");
		await butler.tool("look", {});
		assert.equal(butler.current().looking, null);
	});

	it("looks at a session he reads and works on one he prompts", async () => {
		const { butler } = await setup();
		await butler.tool("read_transcript", { session: "aaaaaaaa-1" });
		assert.equal(butler.current().looking?.target, "aaaaaaaa-1");
		assert.equal(butler.current().working, null);
		await butler.tool("work", { target: "aaaaaaaa-1", label: "Butler" });
		assert.equal(butler.current().working?.target, "aaaaaaaa-1");
		await butler.tool("work", {});
		assert.equal(butler.current().working, null);
		assert.equal((await butler.tool("work", { target: "nope" })).ok, false);
	});
});

describe("Butler sees what Aaron is working on", () => {
	const viewport = { x: 0, y: 0, w: 4000, h: 3000 };

	it("follows the session Aaron has open and tells spike on every poll", async () => {
		const { butler } = await setup();
		butler.focus({ client: "a", session: "aaaaaaaa-1", viewport });
		assert.equal(
			butler.current().looking,
			null,
			"his face never follows Aaron",
		);
		const polled = await butler.tool("board_inbox", {});
		const { aaron } = JSON.parse(polled.ok ? polled.text : "{}");
		assert.equal(aaron.card.id, "aaaaaaaa-1");
		assert.equal(aaron.card.kind, "session");
		assert.equal(aaron.open, true);
		assert.deepEqual(aaron.viewport, viewport);
		assert.equal(aaron.onScreen[0].id, "aaaaaaaa-1");
		const asked = await butler.tool("board_focus", {});
		assert.match(asked.ok ? asked.text : "", /"open":true/);
		const snapshot = await butler.tool("board_snapshot", {});
		assert.match(
			snapshot.ok ? snapshot.text : "",
			/Aaron has open session acme-aaa \(aaaaaaaa-1, working\)/,
		);
	});

	it("follows the card in the middle of Aaron's screen when nothing is open", async () => {
		const { butler } = await setup();
		await butler.tool("put_card", { title: "Groceries", x: 5000, y: 5000 });
		butler.focus({
			client: "a",
			viewport: { x: 4800, y: 4800, w: 712, h: 616 },
		});
		const focus = butler.aaron();
		assert.equal(focus?.open, false);
		assert.equal(focus?.card?.name, "Groceries");
		butler.focus({ client: "a", viewport: { x: 0, y: 9000, w: 10, h: 10 } });
		assert.equal(butler.aaron()?.card, undefined);
	});

	it("forgets Aaron when his page goes away or goes quiet, but not another tab's", async () => {
		const { butler, tick } = await setup();
		butler.focus({ client: "a", session: "aaaaaaaa-1" });
		butler.focus({ client: "b", away: true });
		assert.equal(butler.aaron()?.card?.id, "aaaaaaaa-1");
		butler.focus({ client: "a", away: true });
		assert.equal(butler.aaron(), null);
		butler.focus({ client: "a", session: "aaaaaaaa-1" });
		tick(aaronFocusStaleMs + 1);
		butler.check();
		assert.equal(butler.aaron(), null);
		const snapshot = await butler.tool("board_snapshot", {});
		assert.match(snapshot.ok ? snapshot.text : "", /Aaron is not at the board/);
	});

	it("puts his cursor on the card a message is about once spike takes it", async () => {
		const { butler } = await setup();
		const thread = butler.inbox?.start({
			x: 10,
			y: 10,
			text: "What is this doing?",
		});
		assert.ok(thread && !("error" in thread));
		const polled = await butler.tool("board_inbox", {});
		const { messages } = JSON.parse(polled.ok ? polled.text : "{}");
		await butler.tool("board_ack", { ids: [messages[0].id] });
		assert.equal(
			butler.current().working?.target,
			thread.context?.card?.id ?? thread.id,
		);
	});

	it("checks a page's report", () => {
		assert.deepEqual(parseFocusReport({ client: "a", away: true }), {
			client: "a",
			away: true,
		});
		assert.deepEqual(
			parseFocusReport({ client: "a", session: "s", viewport }),
			{ client: "a", session: "s", viewport },
		);
		assert.ok("error" in parseFocusReport({ session: "s" }));
		assert.ok("error" in parseFocusReport({ client: "a b" }));
		assert.ok(
			"error" in parseFocusReport({ client: "a", viewport: { x: "1" } }),
		);
	});
});

describe("Butler's tool calls", () => {
	const request = (address: string, headers: Record<string, string> = {}) =>
		({ socket: { remoteAddress: address }, headers }) as IncomingMessage;

	it("come only from this Mac, never from a page", () => {
		assert.equal(butlerAllowed(request("127.0.0.1")), true);
		assert.equal(butlerAllowed(request("::1")), true);
		assert.equal(butlerAllowed(request("10.100.0.1")), false);
		assert.equal(
			butlerAllowed(request("127.0.0.1", { origin: "https://evil.example" })),
			false,
		);
		assert.equal(butlerAllowed(request("127.0.0.1", { "cf-ray": "1" })), false);
	});

	it("fold a self-fix's state into a card's", () => {
		assert.equal(selfFixState("running"), "working");
		assert.equal(selfFixState("still starting"), "working");
		assert.equal(selfFixState("waiting on input (Bash)"), "needs-you");
		assert.equal(selfFixState("finished"), "done");
		assert.equal(selfFixState("archived"), "done");
		assert.equal(selfFixState("finished with an error"), "failed");
		assert.equal(selfFixState("failed to start: no repo"), "failed");
		assert.equal(
			selfFixState("unknown, its progress could not be read yet"),
			"idle",
		);
	});
});
