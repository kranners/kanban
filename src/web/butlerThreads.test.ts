import assert from "node:assert/strict";
import { test } from "node:test";
import type { Annotations, ButlerCard, Session } from "../shared/types.ts";
import {
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
