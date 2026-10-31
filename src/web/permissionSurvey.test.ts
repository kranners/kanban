import assert from "node:assert/strict";
import { test } from "node:test";
import type { PermissionSurveyEntry } from "../shared/permissions.ts";
import {
	allRuleKeys,
	grantsFor,
	isBroadRule,
	narrowRuleKeys,
	ruleKey,
} from "./permissionSurvey.ts";

const entries: PermissionSurveyEntry[] = [
	{
		sessionId: "a",
		name: "alpha",
		cwd: "/a",
		ok: true,
		permissions: [
			{ rule: "Bash(npm run test:*)", reason: "tests" },
			{ rule: "Edit(src/**)", reason: "edits" },
			{ rule: "Edit(src/**)", reason: "again" },
		],
	},
	{ sessionId: "b", name: "beta", cwd: "/b", ok: false, error: "cloud" },
	{
		sessionId: "c",
		name: "gamma",
		cwd: "/c",
		ok: true,
		permissions: [{ rule: "WebFetch(domain:example.com)", reason: "docs" }],
	},
];

test("approving every rule grants each session its rules once", () => {
	assert.deepEqual(grantsFor(entries, allRuleKeys(entries)), [
		{ sessionId: "a", rules: ["Bash(npm run test:*)", "Edit(src/**)"] },
		{ sessionId: "c", rules: ["WebFetch(domain:example.com)"] },
	]);
});

test("approving a selection leaves out sessions with nothing selected", () => {
	assert.deepEqual(
		grantsFor(entries, new Set([ruleKey("a", "Edit(src/**)")])),
		[{ sessionId: "a", rules: ["Edit(src/**)"] }],
	);
	assert.deepEqual(grantsFor(entries, new Set()), []);
});

test("rules reaching past the project or allowing a whole tool are broad", () => {
	for (const rule of [
		"Bash",
		"Edit",
		"Bash(*)",
		"Edit(//**)",
		"Write(~/.claude/settings.json)",
		"Read(../other/**)",
	]) {
		assert.ok(isBroadRule(rule), rule);
	}
	for (const rule of [
		"Bash(npm run test:*)",
		"Edit(src/**)",
		"Edit(/src/**)",
		"WebFetch(domain:example.com)",
		"mcp__server__tool",
	]) {
		assert.ok(!isBroadRule(rule), rule);
	}
});

test("broad rules start unselected", () => {
	const broad: PermissionSurveyEntry[] = [
		{
			sessionId: "a",
			name: "alpha",
			cwd: "/a",
			ok: true,
			permissions: [
				{ rule: "Bash", reason: "anything" },
				{ rule: "Edit(src/**)", reason: "edits" },
			],
		},
	];
	assert.deepEqual(
		narrowRuleKeys(broad),
		new Set([ruleKey("a", "Edit(src/**)")]),
	);
});
