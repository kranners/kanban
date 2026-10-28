import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
	activityOf,
	isAlive,
	type Job,
	type RegistryEntry,
} from "./registry.ts";

const entry = (status: string): RegistryEntry => ({
	pid: 1,
	sessionId: "s",
	cwd: "/Users/me/dev/acme-api",
	kind: "bg",
	jobId: "0a1b2c3d",
	name: "acme-api",
	status,
	waitingFor: null,
	socket: null,
	startedAt: 0,
	updatedAt: 0,
});

const job = (state: string, tempo: string | null = null): Job => ({
	short: "0a1b2c3d",
	sessionId: "s",
	cwd: "/Users/me/dev/acme-api",
	name: null,
	state,
	tempo,
	detail: null,
	needs: null,
	intent: null,
	block: null,
	createdAt: 0,
	updatedAt: 0,
});

describe("activityOf", () => {
	test("maps interactive status", () => {
		assert.equal(activityOf(entry("busy"), null), "working");
		assert.equal(activityOf(entry("shell"), null), "watching");
		assert.equal(activityOf(entry("waiting"), null), "needs-you");
		assert.equal(activityOf(entry("idle"), null), "idle");
	});

	test("a turn that ended with background shells left running is watching", () => {
		assert.equal(activityOf(entry("shell"), job("working")), "watching");
		assert.equal(activityOf(entry("shell"), job("blocked")), "needs-you");
	});

	test("a resting session with live subagents or shells is watching", () => {
		assert.equal(activityOf(entry("idle"), null, true), "watching");
		assert.equal(activityOf(entry("idle"), job("working"), true), "watching");
		assert.equal(activityOf(entry("busy"), null, true), "working");
		assert.equal(activityOf(entry("waiting"), null, true), "needs-you");
		assert.equal(activityOf(entry("idle"), job("done"), true), "done");
		assert.equal(activityOf(null, job("working"), true), "stopped");
	});

	test("folds job state into an idle live session", () => {
		assert.equal(activityOf(entry("idle"), job("blocked")), "needs-you");
		assert.equal(activityOf(entry("idle"), job("done")), "done");
		assert.equal(activityOf(entry("idle"), job("failed")), "failed");
		assert.equal(activityOf(entry("idle"), job("crashed")), "failed");
		assert.equal(activityOf(entry("idle"), job("working")), "idle");
		assert.equal(
			activityOf(entry("idle"), job("working", "blocked")),
			"needs-you",
		);
		assert.equal(activityOf(entry("busy"), job("working")), "working");
		assert.equal(activityOf(entry("busy"), job("done")), "working");
	});

	test("a job without a live process is stopped unless it finished", () => {
		assert.equal(activityOf(null, job("blocked")), "stopped");
		assert.equal(activityOf(null, job("working")), "stopped");
		assert.equal(activityOf(null, job("done")), "done");
		assert.equal(activityOf(null, job("failed")), "failed");
	});
});

test("isAlive", () => {
	assert.equal(isAlive(process.pid), true);
	assert.equal(isAlive(2 ** 22 - 3), false);
});
