import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { Session } from "../shared/types.ts";
import type { Answer } from "./exit.ts";
import {
	createPermissions,
	isPermissionRule,
	maxRules,
	mergeAllowRules,
	parseGrants,
	parsePermissions,
	settingsPathFor,
	surveyPrompt,
} from "./permissions.ts";

const sessionAt = (
	id: string,
	cwd: string,
	extra: Partial<Session> = {},
): Session => ({
	id,
	short: null,
	pid: 1,
	name: `name-${id}`,
	cwd,
	project: "p",
	kind: "interactive",
	activity: "working",
	doing: null,
	needs: null,
	goal: null,
	startedAt: 0,
	updatedAt: 0,
	attachable: false,
	cmux: false,
	artifacts: [],
	tasks: [],
	steps: [],
	...extra,
});

describe("isPermissionRule", () => {
	it("accepts permission rules and rejects prose", () => {
		for (const rule of [
			"Bash",
			"Bash(npm run test:*)",
			"Edit(src/**)",
			"WebFetch(domain:example.com)",
			"mcp__claude-in-chrome__navigate",
		]) {
			assert.ok(isPermissionRule(rule), rule);
		}
		for (const rule of [
			"",
			"rm -rf /",
			"Read the file",
			"Bash()",
			"Bash(a)(b)",
			"Bash(a\nb)",
			`Bash(${"x".repeat(400)})`,
			42,
		]) {
			assert.ok(!isPermissionRule(rule), String(rule));
		}
	});
});

describe("parsePermissions", () => {
	it("reads JSON wrapped in fences or prose, dropping bad and repeated rules", () => {
		const answer = [
			"Here is what I need:",
			"```json",
			JSON.stringify({
				permissions: [
					{ rule: " Bash(npm run test:*) ", reason: "run tests" },
					{ rule: "Bash(npm run test:*)", reason: "again" },
					{ rule: "just let me do stuff", reason: "nope" },
					{ rule: "Edit(src/**)" },
					"Write",
					"Read(‮docs)",
				],
			}),
			"```",
		].join("\n");
		assert.deepEqual(parsePermissions(answer), {
			ok: true,
			permissions: [
				{ rule: "Bash(npm run test:*)", reason: "run tests" },
				{ rule: "Edit(src/**)", reason: "" },
				{ rule: "Write", reason: "" },
			],
		});
	});

	it("fails when every listed rule is invalid", () => {
		assert.deepEqual(
			parsePermissions(
				JSON.stringify({ permissions: ["Bash(echo (y))", "Read(a\u0000b)"] }),
			),
			{
				ok: false,
				error: "The session's rules were not valid permission rules",
			},
		);
	});

	it("accepts a bare list and caps its length", () => {
		const list = Array.from({ length: maxRules + 5 }, (_, index) => ({
			rule: `Read(dir${index}/**)`,
			reason: "r".repeat(500),
		}));
		const parsed = parsePermissions(`ok ${JSON.stringify(list)} done`);
		assert.ok(parsed.ok);
		assert.equal(parsed.permissions.length, maxRules);
		assert.equal(parsed.permissions[0]?.reason.length, 200);
	});

	it("fails when there is no permission list", () => {
		assert.equal(parsePermissions("I need nothing").ok, false);
		assert.equal(parsePermissions('{"other": 1}').ok, false);
	});
});

describe("parseGrants", () => {
	it("validates the grant list", () => {
		const grants = [{ sessionId: "a", rules: ["Bash(git push:*)"] }];
		assert.deepEqual(parseGrants(grants), { grants });
		assert.ok("error" in parseGrants({}));
		assert.ok("error" in parseGrants([{ sessionId: "a" }]));
		assert.ok("error" in parseGrants([{ sessionId: "a", rules: ["sudo x"] }]));
	});
});

describe("mergeAllowRules", () => {
	it("creates the settings file when missing", async () => {
		const dir = await mkdtemp(join(tmpdir(), "permissions-"));
		const path = settingsPathFor(dir);
		assert.deepEqual(await mergeAllowRules(path, ["Edit(src/**)"]), [
			"Edit(src/**)",
		]);
		assert.equal(
			await readFile(path, "utf8"),
			`${JSON.stringify({ permissions: { allow: ["Edit(src/**)"] } }, null, 2)}\n`,
		);
	});

	it("keeps other settings and dedupes", async () => {
		const dir = await mkdtemp(join(tmpdir(), "permissions-"));
		const path = settingsPathFor(dir);
		await mkdir(join(dir, ".claude"));
		await writeFile(
			path,
			JSON.stringify({
				model: "opus",
				permissions: { allow: ["Bash(ls:*)"], deny: ["Bash(rm:*)"] },
			}),
		);
		assert.deepEqual(
			await mergeAllowRules(path, ["Bash(ls:*)", "Read", "Read"]),
			["Read"],
		);
		assert.deepEqual(JSON.parse(await readFile(path, "utf8")), {
			model: "opus",
			permissions: { allow: ["Bash(ls:*)", "Read"], deny: ["Bash(rm:*)"] },
		});
	});

	it("refuses to overwrite settings it cannot read", async () => {
		const dir = await mkdtemp(join(tmpdir(), "permissions-"));
		const path = settingsPathFor(dir);
		await mkdir(join(dir, ".claude"));
		await writeFile(path, "{ not json");
		await assert.rejects(mergeAllowRules(path, ["Read"]));
		assert.equal(await readFile(path, "utf8"), "{ not json");
	});
});

describe("createPermissions", () => {
	it("asks every running local session and reports each failure", async () => {
		const asked: string[] = [];
		const answers: Record<string, Answer | Error> = {
			good: {
				ok: true,
				answer: '{"permissions":[{"rule":"Bash(make:*)","reason":"build"}]}',
			},
			silent: { ok: false, error: "The session did not answer" },
			broken: new Error("spawn failed"),
		};
		const permissions = createPermissions({
			sessions: () => [
				sessionAt("good", "/a"),
				sessionAt("silent", "/b"),
				sessionAt("broken", "/c"),
				sessionAt("cloudy", "", { cloud: { url: "https://x" } }),
				sessionAt("folderless", ""),
				sessionAt("over", "/d", { activity: "done" }),
				sessionAt("leaving", "/e"),
			],
			isExiting: (sessionId) => sessionId === "leaving",
			ask: async (session, question) => {
				asked.push(session.id);
				assert.equal(question, surveyPrompt);
				const answer = answers[session.id];
				if (answer instanceof Error) throw answer;
				return answer ?? { ok: false, error: "unexpected" };
			},
		});
		const { entries } = await permissions.survey();
		assert.deepEqual(asked.sort(), ["broken", "good", "silent"]);
		assert.deepEqual(
			entries.map((entry) => [
				entry.sessionId,
				entry.ok ? entry.permissions.map(({ rule }) => rule) : entry.error,
			]),
			[
				["good", ["Bash(make:*)"]],
				["silent", "The session did not answer"],
				["broken", "spawn failed"],
				["cloudy", "Runs in the cloud, so it can't be asked"],
				["folderless", "This session has no local folder"],
			],
		);
	});

	it("grants into each session's own folder, serializing writes", async () => {
		const dir = await mkdtemp(join(tmpdir(), "permissions-"));
		const permissions = createPermissions({
			sessions: () => [
				sessionAt("one", dir),
				sessionAt("two", dir),
				sessionAt("cloudy", "", { cloud: { url: "https://x" } }),
			],
			isExiting: () => false,
			ask: async () => ({ ok: false, error: "unused" }),
		});
		const results = await permissions.grant([
			{ sessionId: "one", rules: ["Read", "Edit(src/**)"] },
			{ sessionId: "two", rules: ["Edit(src/**)", "Bash(make:*)"] },
			{ sessionId: "cloudy", rules: ["Read"] },
			{ sessionId: "ghost", rules: ["Read"] },
		]);
		const path = settingsPathFor(dir);
		assert.deepEqual(results, [
			{
				sessionId: "one",
				settingsPath: path,
				ok: true,
				added: ["Read", "Edit(src/**)"],
			},
			{
				sessionId: "two",
				settingsPath: path,
				ok: true,
				added: ["Bash(make:*)"],
			},
			{
				sessionId: "cloudy",
				settingsPath: "",
				ok: false,
				error: "This session has no local folder",
			},
			{
				sessionId: "ghost",
				settingsPath: "",
				ok: false,
				error: "No such session",
			},
		]);
		assert.deepEqual(
			JSON.parse(await readFile(path, "utf8")).permissions.allow,
			["Read", "Edit(src/**)", "Bash(make:*)"],
		);
	});
});
