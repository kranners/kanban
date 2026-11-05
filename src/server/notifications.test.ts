import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
	applyNotificationUpdate,
	type BoardNotification,
	unreadCount,
	unreadFor,
} from "../shared/notifications.ts";
import type { Activity, Board, Session } from "../shared/types.ts";
import {
	createNotificationStore,
	keepReadMs,
	loadNotifications,
	parseNotifications,
	parseNotificationUpdate,
} from "./notifications.ts";

const session = (
	id: string,
	activity: Activity,
	extra: Partial<Session> = {},
): Session => ({
	id,
	short: null,
	pid: null,
	name: id,
	cwd: `/work/${id}`,
	project: id,
	kind: "background",
	activity,
	doing: null,
	needs: null,
	goal: null,
	startedAt: 1,
	updatedAt: 1,
	attachable: true,
	cmux: false,
	artifacts: [],
	tasks: [],
	steps: [],
	...extra,
});

const board = (...sessions: Session[]) => ({ sessions }) as unknown as Board;

const note = (
	id: string,
	extra: Partial<BoardNotification> = {},
): BoardNotification => ({
	id,
	sessionId: id,
	kind: "finished",
	title: `${id} finished`,
	body: id,
	at: 1,
	read: false,
	...extra,
});

const setup = async (
	initial: BoardNotification[] = [],
	options: { now?: () => number; ignored?: (s: Session) => boolean } = {},
) => {
	const dir = await mkdtemp(join(tmpdir(), "kanban-notifications-"));
	const file = join(dir, "state", "notifications.json");
	const changes: BoardNotification[][] = [];
	const store = createNotificationStore({
		file,
		initial,
		now: options.now ?? (() => 1000),
		ignored: options.ignored,
		onChange: (next) => changes.push(next),
	});
	return { file, store, changes };
};

describe("createNotificationStore", () => {
	it("raises nothing on first sight of the board", async () => {
		const { store } = await setup();
		store.observe(board(session("a", "needs-you"), session("b", "idle")));
		assert.deepEqual(store.current(), []);
	});

	it("raises an unread notification when a session finishes, fails or needs you", async () => {
		const { store } = await setup();
		store.observe(
			board(
				session("a", "working"),
				session("b", "working"),
				session("c", "working"),
			),
		);
		store.observe(
			board(
				session("a", "idle", { doing: "Opened a PR" }),
				session("b", "failed"),
				session("c", "needs-you", { needs: "Approve Bash?" }),
			),
		);
		const byId = new Map(store.current().map((n) => [n.sessionId, n]));
		assert.equal(byId.get("a")?.kind, "finished");
		assert.equal(byId.get("a")?.title, "a finished");
		assert.equal(byId.get("a")?.body, "Opened a PR");
		assert.equal(byId.get("b")?.kind, "failed");
		assert.equal(byId.get("c")?.kind, "needs");
		assert.equal(byId.get("c")?.body, "Approve Bash?");
		assert.equal(unreadCount(store.current()), 3);
		assert.ok(store.current().every((n) => n.at === 1000));
	});

	it("keeps one notification per session, the latest first", async () => {
		const { store } = await setup();
		store.observe(board(session("a", "working"), session("b", "working")));
		store.observe(board(session("a", "needs-you"), session("b", "working")));
		store.observe(board(session("a", "working"), session("b", "idle")));
		store.observe(board(session("a", "idle"), session("b", "idle")));
		assert.deepEqual(
			store.current().map((n) => [n.sessionId, n.kind]),
			[
				["a", "finished"],
				["b", "finished"],
			],
		);
	});

	it("lingers once raised, even after the session moves on", async () => {
		const { store } = await setup();
		store.observe(board(session("a", "working")));
		store.observe(board(session("a", "idle")));
		store.observe(board(session("a", "stopped")));
		store.observe(board());
		assert.equal(store.current().length, 1);
	});

	it("raises nothing for an ignored project", async () => {
		const { store } = await setup([], { ignored: (s) => s.id === "a" });
		store.observe(board(session("a", "working"), session("b", "working")));
		store.observe(board(session("a", "idle"), session("b", "idle")));
		assert.deepEqual(
			store.current().map((n) => n.sessionId),
			["b"],
		);
	});

	it("marks read, unread and dismisses, saving and broadcasting each", async () => {
		const { file, store, changes } = await setup([note("a"), note("b")]);
		store.update({ action: "read", ids: ["a"] });
		assert.deepEqual(
			store.current().map((n) => n.read),
			[true, false],
		);
		store.update({ action: "read", ids: ["a"] });
		assert.equal(changes.length, 1, "an update that changes nothing is quiet");
		store.update({ action: "unread", ids: ["a"] });
		assert.equal(store.current()[0]?.read, false);
		store.update({ action: "dismiss", ids: ["b"] });
		assert.deepEqual(
			store.current().map((n) => n.id),
			["a"],
		);
		assert.equal(changes.length, 3);
		await store.saved();
		assert.deepEqual(await loadNotifications(file), store.current());
	});

	it("lets read notifications go after a week, but never unread ones", async () => {
		const { store } = await setup(
			[
				note("old-read", { read: true, at: 0 }),
				note("old-unread", { at: 0 }),
				note("new-read", { read: true, at: keepReadMs }),
			],
			{ now: () => keepReadMs + 1 },
		);
		assert.deepEqual(
			store.current().map((n) => n.id),
			["old-unread", "new-read"],
		);
	});
});

describe("parsing notifications", () => {
	it("drops malformed stored entries", () => {
		assert.deepEqual(parseNotifications("nope"), []);
		assert.deepEqual(
			parseNotifications([note("a"), { ...note("b"), kind: "weird" }, null]),
			[note("a")],
		);
	});

	it("accepts an action and a list of ids", () => {
		assert.deepEqual(parseNotificationUpdate({ action: "read", ids: ["a"] }), {
			action: "read",
			ids: ["a"],
		});
		for (const body of [
			null,
			{ action: "delete", ids: ["a"] },
			{ action: "read" },
			{ action: "read", ids: [1] },
			{ action: "read", ids: [""] },
		])
			assert.ok("error" in parseNotificationUpdate(body), JSON.stringify(body));
	});
});

describe("applyNotificationUpdate", () => {
	it("returns the same list when nothing changes", () => {
		const list = [note("a", { read: true })];
		assert.equal(
			applyNotificationUpdate(list, { action: "read", ids: ["a"] }),
			list,
		);
		assert.equal(
			applyNotificationUpdate(list, { action: "dismiss", ids: ["z"] }),
			list,
		);
	});

	it("finds a session's unread notifications", () => {
		const list = [
			note("a"),
			note("b", { sessionId: "a", read: true }),
			note("c"),
		];
		assert.deepEqual(unreadFor(list, "a"), ["a"]);
	});
});
