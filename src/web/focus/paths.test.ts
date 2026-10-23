import assert from "node:assert/strict";
import { test } from "node:test";
import {
	attachUrl,
	directoryName,
	isAbsoluteDirectory,
	needsTrust,
	transcriptUrl,
} from "./paths.ts";

test("attachUrl uses ws on http and wss on https", () => {
	assert.equal(
		attachUrl({ protocol: "http:", host: "127.0.0.1:7420" }, "a1b2", 120, 40),
		"ws://127.0.0.1:7420/api/attach/a1b2?cols=120&rows=40",
	);
	assert.equal(
		attachUrl({ protocol: "https:", host: "board.example" }, "a1b2", 80, 24),
		"wss://board.example/api/attach/a1b2?cols=80&rows=24",
	);
});

test("transcriptUrl encodes the session id", () => {
	assert.equal(
		transcriptUrl("abc/def", 200),
		"/api/sessions/abc%2Fdef/transcript?limit=200",
	);
});

test("directoryName takes the last path segment", () => {
	assert.equal(directoryName("/Users/me/dev/acme-api"), "acme-api");
	assert.equal(directoryName("/Users/me/dev/acme-api/"), "acme-api");
	assert.equal(directoryName(""), "");
});

test("isAbsoluteDirectory requires a leading slash", () => {
	assert.equal(isAbsoluteDirectory("/Users/me/dev/acme-api"), true);
	assert.equal(isAbsoluteDirectory("dev/acme-api"), false);
	assert.equal(isAbsoluteDirectory("~/dev"), false);
});

test("needsTrust spots workspace trust errors", () => {
	assert.equal(needsTrust("workspace not trusted"), true);
	assert.equal(needsTrust("Trust the folder first"), true);
	assert.equal(needsTrust("claude exited 1"), false);
});
