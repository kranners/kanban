import assert from "node:assert/strict";
import { test } from "node:test";
import {
	attachUrl,
	commandsUrl,
	conversationUrl,
	directoryName,
	filesUrl,
	mirrorUrl,
	needsTrust,
	remoteHostsUrl,
	runsOnBlockerUrl,
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

test("mirrorUrl follows the page's scheme", () => {
	assert.equal(
		mirrorUrl({ protocol: "https:", host: "board.example" }, "abc-1"),
		"wss://board.example/api/mirror/abc-1",
	);
	assert.equal(
		mirrorUrl({ protocol: "http:", host: "127.0.0.1:7420" }, "a/b"),
		"ws://127.0.0.1:7420/api/mirror/a%2Fb",
	);
});

test("conversationUrl names the node and resumes from a revision", () => {
	assert.equal(
		conversationUrl(
			{ protocol: "https:", host: "board.example" },
			{ kind: "session", id: "abc/def" },
			"e1:42",
		),
		"wss://board.example/api/sessions/abc%2Fdef/conversation?since=e1%3A42",
	);
	assert.equal(
		conversationUrl(
			{ protocol: "http:", host: "127.0.0.1:7420" },
			{ kind: "subagent", id: "a1" },
			null,
		),
		"ws://127.0.0.1:7420/api/subagents/a1/conversation",
	);
});

test("composer lookups encode the session and query", () => {
	assert.equal(
		filesUrl("s/1", "src app"),
		"/api/sessions/s%2F1/files?q=src+app",
	);
	assert.equal(commandsUrl("s/1"), "/api/sessions/s%2F1/commands");
});

test("directoryName takes the last path segment", () => {
	assert.equal(directoryName("/Users/me/dev/acme-api"), "acme-api");
	assert.equal(directoryName("/Users/me/dev/acme-api/"), "acme-api");
	assert.equal(directoryName(""), "");
});

test("needsTrust spots workspace trust errors", () => {
	assert.equal(needsTrust("workspace not trusted"), true);
	assert.equal(needsTrust("Trust the folder first"), true);
	assert.equal(needsTrust("claude exited 1"), false);
});

test("runsOnBlockerUrl carries the folder, where it runs and the account", () => {
	assert.equal(
		runsOnBlockerUrl("/Users/me/dev/a b&c", "cloud"),
		"/api/cloud-blocker?cwd=%2FUsers%2Fme%2Fdev%2Fa+b%26c&runsOn=cloud",
	);
	assert.equal(
		runsOnBlockerUrl("/x", "env_01host", 2),
		"/api/cloud-blocker?cwd=%2Fx&runsOn=env_01host&account=2",
	);
});

test("remoteHostsUrl asks for the account's hosts", () => {
	assert.equal(remoteHostsUrl(), "/api/remote-hosts?");
	assert.equal(remoteHostsUrl(3), "/api/remote-hosts?account=3");
});
