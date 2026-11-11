import assert from "node:assert/strict";
import { test } from "node:test";
import type {
	Annotations,
	Board,
	ButlerCard,
	Region,
	Session,
} from "../shared/types.ts";
import { cardSession, ownCards, withButlerCards } from "./butlerSessions.ts";
import { withSubagentsShown } from "./subagentSetting.ts";

const board = (parts: Partial<Board> = {}): Board => ({
	sessions: [],
	subagents: [],
	subagentCounts: {},
	subagentStates: {},
	workflowRuns: {},
	workflows: [],
	links: [],
	messages: [],
	generatedAt: 0,
	...parts,
});

const card = (id: string, fields: Partial<ButlerCard> = {}): ButlerCard => ({
	id,
	kind: "butler-card",
	title: id,
	state: "working",
	x: 0,
	y: 0,
	w: 312,
	h: 216,
	z: 1,
	updatedAt: 0,
	...fields,
});

const reported = (
	id: string,
	state: "working" | "idle" | "done",
	parent?: string,
) => ({
	id,
	description: `do ${id}`,
	type: "general-purpose",
	state,
	updatedAt: 5,
	...(parent ? { parent } : {}),
});

const cards: Annotations = {
	"self-fix-1": card("self-fix-1", {
		subagents: [
			reported("top", "working"),
			reported("child", "done", "top"),
			reported("lost", "idle", "gone"),
		],
	}),
	"thread-9": card("thread-9", { subagents: [reported("w", "working")] }),
};

test("a Butler card's subagents become the board's own, owned by the card", () => {
	const merged = withButlerCards(board(), cards);
	const byId = new Map(merged.subagents.map((s) => [s.id, s]));
	assert.equal(byId.get("top")?.sessionId, "self-fix-1");
	assert.equal(byId.get("top")?.live, true);
	assert.equal(byId.get("child")?.parentAgentId, "top");
	assert.equal(byId.get("child")?.done, true);
	assert.equal(
		byId.get("lost")?.parentAgentId,
		null,
		"a parent the card no longer reports leaves it under the card",
	);
	assert.deepEqual(merged.subagentCounts["self-fix-1"], {
		working: 1,
		idle: 1,
		done: 1,
	});
	assert.equal(merged.subagentStates.w, "working");
	assert.deepEqual(merged.links.find((l) => l.to.id === "child")?.from, {
		kind: "subagent",
		id: "top",
	});
	assert.deepEqual(merged.links.find((l) => l.to.id === "top")?.from, {
		kind: "session",
		id: "self-fix-1",
	});
	assert.equal(byId.get("w")?.sessionId, "thread-9");
});

test("every Butler card joins the board as a session that cannot be attached to", () => {
	const merged = withButlerCards(board(), cards);
	const ids = merged.sessions.map((s) => s.id);
	assert.deepEqual(ids, ["self-fix-1", "thread-9"]);
	for (const session of merged.sessions) {
		assert.equal(session.attachable, false);
		assert.equal(session.cmux, false);
		assert.equal(session.cloud, undefined);
		assert.equal(session.short, null);
		assert.equal(session.pid, null);
	}
	assert.equal(merged.sessions[0]?.butler?.origin, "butler");
	assert.deepEqual(
		ownCards(merged).map((c) => c.id),
		["self-fix-1", "thread-9"],
	);
});

test("a card's session carries its state, status, parent and the region it stands in", () => {
	const region: Region = {
		id: "r1",
		name: "Kanban",
		cwd: "butler:project:kanban",
		x: -100,
		y: -100,
		w: 1000,
		h: 1000,
	} as Region;
	const session = cardSession(
		card("thread-22222", {
			state: "needs-you",
			status: "Waiting on your yes",
			parent: "thread-11111",
			thread: {
				id: "22222",
				kind: "desk",
				link: "https://discord.com/channels/1/22222",
				private: false,
			},
			history: [
				{ at: 1, state: "working", status: "Reading" },
				{ at: 2, state: "needs-you", status: "Waiting on your yes" },
			],
		}),
		[region],
	);
	assert.equal(session.needs, "Waiting on your yes");
	assert.equal(session.doing, null);
	assert.equal(session.cwd, "butler:project:kanban");
	assert.equal(session.butler?.origin, "desk");
	assert.deepEqual(session.parent, { thread: "11111", card: "thread-11111" });
	assert.deepEqual(
		session.steps.map((s) => s.text),
		["Working: Reading", "Needs you: Waiting on your yes"],
	);
	assert.equal(session.startedAt, 1);
});

test("a change whose cloud session is on the board shows as that one session", () => {
	const cloud: Session = {
		...cardSession(card("ignored")),
		id: "session_abc",
		butler: undefined,
		cloud: { url: "https://claude.ai/code/session_abc" },
	};
	delete cloud.butler;
	const merged = withButlerCards(board({ sessions: [cloud] }), {
		"self-fix-2": card("self-fix-2", {
			selfFix: "2",
			link: "https://claude.ai/code/session_abc",
		}),
	});
	assert.deepEqual(
		merged.sessions.map((s) => [s.id, s.butler?.card.id]),
		[["session_abc", "self-fix-2"]],
	);
	assert.deepEqual(ownCards(merged), []);
});

test("a card's link to what it started is a spawned link, never one to itself", () => {
	const merged = withButlerCards(board(), {
		"thread-11111": card("thread-11111"),
		"self-fix-3": card("self-fix-3", { parent: "thread-11111" }),
		"thread-22222": card("thread-22222", { parent: "thread-22222" }),
	});
	assert.deepEqual(
		merged.links.map((l) => `${l.from.id}>${l.to.id}`),
		["thread-11111>self-fix-3"],
	);
});

test("one Show subagents setting hides a card's subagents with a session's", () => {
	const hidden = withSubagentsShown(withButlerCards(board(), cards), false);
	assert.equal(hidden.subagents.length, 0);
	assert.equal(hidden.links.length, 0);
	assert.deepEqual(hidden.subagentCounts, {});
});

test("a subagent the board already has is never drawn twice", () => {
	const own = withButlerCards(
		board({
			subagents: [
				{
					id: "w",
					kind: "agent",
					sessionId: "real",
					parentAgentId: null,
					type: "t",
					description: "d",
					live: true,
					done: false,
					startedAt: 1,
					updatedAt: 1,
				},
			],
		}),
		cards,
	);
	assert.equal(own.subagents.filter((s) => s.id === "w").length, 1);
	assert.equal(own.subagents.find((s) => s.id === "w")?.sessionId, "real");
	assert.equal(withButlerCards(board(), {}).subagents.length, 0);
});
