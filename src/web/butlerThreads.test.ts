import assert from "node:assert/strict";
import { test } from "node:test";
import type { Annotations, ButlerCard, Session } from "../shared/types.ts";
import { withButlerCards } from "./butlerSubagents.ts";
import {
	isFromDm,
	linkedCount,
	openParent,
	openThreadCard,
	parentTitle,
	threadKindLabels,
} from "./butlerThreads.ts";

const card = (id: string, extra: Partial<ButlerCard> = {}): ButlerCard => ({
	id,
	kind: "butler-card",
	title: `Card ${id}`,
	state: "working",
	x: 0,
	y: 0,
	w: 312,
	h: 216,
	z: 1,
	updatedAt: 0,
	...extra,
});

const thread = card("thread-11111111", {
	title: "Book the dentist",
	thread: {
		id: "11111111",
		kind: "job",
		link: "https://discord.com/channels/1/11111111",
		private: false,
	},
});

const annotations: Annotations = {
	[thread.id]: thread,
	"self-fix-1": card("self-fix-1", { parent: thread.id }),
	"thread-22222222": card("thread-22222222", { parent: thread.id }),
	"butler-x": card("butler-x"),
};

const session = (parent?: string) =>
	({
		id: `s-${parent ?? "none"}`,
		...(parent ? { parent: { thread: parent, card: `thread-${parent}` } } : {}),
	}) as Session;

test("a thread card counts the cards and sessions it started", () => {
	assert.equal(
		linkedCount(thread, annotations, [session("11111111"), session()]),
		3,
	);
	assert.equal(linkedCount(card("butler-x"), annotations, []), 0);
});

test("a card names the thread it came from, or falls back while that card is gone", () => {
	assert.equal(parentTitle(thread.id, annotations), "Book the dentist");
	assert.equal(parentTitle("thread-33333333", annotations, "Old"), "Old");
	assert.equal(parentTitle("thread-33333333", annotations), null);
	assert.equal(parentTitle(undefined, annotations), null);
});

test("opening a parent opens its thread view, and nothing else", () => {
	openThreadCard.value = null;
	openParent("self-fix-1");
	assert.equal(openThreadCard.value, null);
	openParent("thread-11111111");
	assert.equal(openThreadCard.value, "11111111");
	openThreadCard.value = null;
	assert.equal(threadKindLabels.desk, "Desk session");
});

test("draws an arrow from each thread card to the cards and sessions it started", () => {
	const desk = card("thread-22222222", {
		parent: "thread-11111111",
		x: 400,
		thread: {
			id: "22222222",
			kind: "desk",
			link: "https://discord.com/channels/1/22222222",
			private: false,
		},
	});
	const change = card("self-fix-20261106-134847-1", {
		parent: "thread-22222222",
		x: 800,
	});
	const orphan = card("self-fix-20261106-134847-2", { parent: "thread-404" });
	const self = card("thread-33333333", { parent: "thread-33333333" });
	const annotations: Annotations = {
		[thread.id]: thread,
		[desk.id]: desk,
		[change.id]: change,
		[orphan.id]: orphan,
		[self.id]: self,
	};
	const started = {
		id: "session_1",
		parent: { thread: "22222222", card: "thread-22222222" },
	} as Session;
	const unplaced = {
		id: "session_2",
		parent: { thread: "22222222", card: "thread-22222222" },
	} as Session;
	assert.deepEqual(spawned(annotations, [started, unplaced]), [
		"thread-11111111>thread-22222222",
		"thread-22222222>self-fix-20261106-134847-1",
		"thread-22222222>session_1",
		"thread-22222222>session_2",
	]);
});

test("knows a card or session that came from the DM, which has no card", () => {
	const dm = "99999999";
	assert.equal(isFromDm({ card: "thread-99999999" }, dm, annotations), true);
	assert.equal(isFromDm({ thread: dm, title: "x" }, dm, annotations), true);
	assert.equal(isFromDm({ card: thread.id }, dm, annotations), false);
	assert.equal(isFromDm({ thread: "11111111" }, dm, annotations), false);
	assert.equal(isFromDm(undefined, dm, annotations), false);
	// While the board has no DM, its title still says so, unless it is a card.
	assert.equal(
		isFromDm(
			{ card: "thread-99999999", title: "Direct messages" },
			undefined,
			annotations,
		),
		true,
	);
	assert.equal(
		isFromDm(
			{ card: thread.id, title: "Direct messages" },
			undefined,
			annotations,
		),
		false,
	);
});

test("draws no arrow to or from the DM, which is no card, while the rest stay", () => {
	const fromDm = card("thread-33333333", { parent: "thread-99999999" });
	const all: Annotations = { ...annotations, [fromDm.id]: fromDm };
	const sessions = [
		{
			id: "s-dm",
			parent: { thread: "99999999", card: "thread-99999999" },
		} as Session,
		session("11111111"),
	];
	const links = spawned(all, sessions);
	assert.equal(
		links.some((key) => key.includes("99999999") || key.includes("33333333")),
		false,
	);
	assert.ok(links.includes("thread-11111111>thread-22222222"));
	assert.ok(links.includes("thread-11111111>s-11111111"));
});

/** The spawned links the board gets from Butler's cards, as parent>child ids. */
function spawned(annotations: Annotations, sessions: Session[]): string[] {
	return withButlerCards(
		{
			sessions,
			subagents: [],
			subagentCounts: {},
			subagentStates: {},
			workflowRuns: {},
			workflows: [],
			links: [],
			messages: [],
			generatedAt: 0,
		},
		annotations,
	)
		.links.filter((link) => link.kind === "spawned")
		.map((link) => `${link.from.id}>${link.to.id}`);
}
