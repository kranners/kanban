import assert from "node:assert/strict";
import { test } from "node:test";
import type { CommentThread } from "../shared/types.ts";
import {
	butlerStatus,
	isCommentKey,
	isRetired,
	openThreadId,
	pinned,
	pinState,
	receiveComments,
	threadTitle,
} from "./comments.ts";

const press = {
	key: "/",
	repeat: false,
	altKey: false,
	ctrlKey: false,
	metaKey: false,
	shiftKey: false,
};

const thread = (extra: Partial<CommentThread> = {}): CommentThread => ({
	id: "t",
	x: 0,
	y: 0,
	createdAt: 0,
	updatedAt: 0,
	resolved: false,
	running: false,
	sessionId: "s",
	resumable: true,
	events: [{ kind: "user", at: 0, text: "Organise my board\ninto projects" }],
	...extra,
});

test("slash opens a comment unless typing, repeating or modified", () => {
	assert.equal(isCommentKey(press, false), true);
	assert.equal(isCommentKey(press, true), false);
	assert.equal(isCommentKey({ ...press, repeat: true }, false), false);
	assert.equal(isCommentKey({ ...press, metaKey: true }, false), false);
	assert.equal(isCommentKey({ ...press, key: "?" }, false), false);
});

test("a pin shows whether its agent is working, failed, resolved or answered", () => {
	assert.equal(pinState(thread({ running: true, resolved: true })), "running");
	assert.equal(pinState(thread({ resolved: true })), "resolved");
	assert.equal(
		pinState(thread({ events: [{ kind: "error", at: 1, text: "Cancelled" }] })),
		"failed",
	);
	assert.equal(pinState(thread()), "answered");
	assert.equal(threadTitle(thread()), "Organise my board");
	assert.equal(threadTitle(thread({ events: [] })), "Comment");
});

test("every thread is pinned, and the retired agent's take no replies", () => {
	const butler = thread({ id: "b", to: "butler" });
	const retired = thread({ id: "old" });
	receiveComments([butler, retired]);
	assert.deepEqual(pinned.value, [butler, retired]);
	assert.equal(isRetired(butler), false);
	assert.equal(isRetired(retired), true);
});

test("an open thread closes once it is gone", () => {
	receiveComments([thread({ id: "b", to: "butler" })]);
	openThreadId.value = "b";
	receiveComments([]);
	assert.equal(openThreadId.value, null);
});

test("a message to Butler shows queued, unreachable, working, then nothing", () => {
	const queued = thread({
		to: "butler",
		queued: [{ id: "m", at: 1, text: "hi" }],
	});
	assert.equal(pinState(queued), "queued");
	assert.match(butlerStatus(queued, "up") ?? "", /Waiting for spike/);
	assert.match(butlerStatus(queued, "down") ?? "", /unreachable/);
	const working = thread({ to: "butler", running: true, waiting: ["m"] });
	assert.equal(butlerStatus(working, "up"), "Butler is working on it…");
	assert.equal(butlerStatus(thread({ to: "butler" }), "down"), null);
});
