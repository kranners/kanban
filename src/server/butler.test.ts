import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { ToolCall } from "../agent/tools.ts";
import type {
	Board,
	ButlerCard,
	ButlerPresence,
	Note,
	Session,
} from "../shared/types.ts";
import { createAnnotationStore } from "./annotations.ts";
import type { AuditEvent } from "./audit.ts";
import {
	butlerAllowed,
	createButler,
	loadWatching,
	selfFixState,
} from "./butler.ts";
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
		newId: () => `id${++ids}`,
		now: () => clock,
	});
	return {
		butler,
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
		assert.equal(presences.at(-1)?.presence?.target, "butler-id1");

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
		assert.equal(presences.at(-1)?.presence?.target, "aaaaaaaa-1");
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
		assert.equal(butler.current().presence?.target, id);
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
		assert.equal(presences.at(-1)?.presence?.target, "aaaaaaaa-1");
		const snapshot = await butler.tool("board_snapshot", {});
		assert.match(snapshot.ok ? snapshot.text : "", /Butler watches: \[\]/);
		const unknown = await butler.tool("rm_rf", {});
		assert.equal(unknown.ok, false);
	});

	it("looks at a card, labelled, and steps away", async () => {
		const { butler } = await setup();
		await butler.tool("look", { target: "aaaaaaaa-1", label: "Butler" });
		assert.equal(butler.current().presence?.target, "aaaaaaaa-1");
		await butler.tool("look", {});
		assert.equal(butler.current().presence, null);
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
