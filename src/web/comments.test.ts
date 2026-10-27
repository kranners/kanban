import assert from "node:assert/strict";
import { test } from "node:test";
import type { CommentThread } from "../shared/types.ts";
import { isCommentKey, pinState, threadTitle } from "./comments.ts";

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
