import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { describe, it } from "node:test";
import {
	launchResult,
	parseBackgrounded,
	validateNewSession,
} from "./sessions.ts";

const valid = { cwd: tmpdir(), name: "acme-api fix", prompt: "say hi" };

describe("validateNewSession", () => {
	it("accepts a request for an existing directory", async () => {
		assert.deepEqual(await validateNewSession({ ...valid, name: "  acme  " }), {
			...valid,
			name: "acme",
		});
	});

	it("rejects bad input with a reason", async () => {
		const cases: [unknown, RegExp][] = [
			[null, /JSON object/],
			[{ ...valid, cwd: "dev/acme-api" }, /absolute/],
			[{ ...valid, cwd: "/Users/me/dev/acme-api-missing" }, /not an existing/],
			[{ ...valid, cwd: import.meta.filename }, /not an existing directory/],
			[{ ...valid, name: "" }, /name is required/],
			[{ ...valid, name: "x".repeat(61) }, /at most 60/],
			[{ ...valid, name: "two\nlines" }, /one line/],
			[{ ...valid, prompt: "   " }, /prompt is required/],
		];
		for (const [body, reason] of cases) {
			const result = await validateNewSession(body);
			assert.ok("error" in result, JSON.stringify(body));
			assert.match(result.error, reason);
		}
	});
});

describe("launchResult", () => {
	it("parses the short from claude --bg output", () => {
		assert.equal(
			parseBackgrounded("backgrounded · 1ca86d73 · acme\n"),
			"1ca86d73",
		);
		assert.deepEqual(
			launchResult("/x", "backgrounded · 1ca86d73 · acme\n", ""),
			{
				ok: true,
				short: "1ca86d73",
			},
		);
	});

	it("explains an untrusted workspace", () => {
		const result = launchResult(
			"/Users/me/dev/acme-api",
			"",
			"\x1b[31mWorkspace not trusted. Run claude in /Users/me/dev/acme-api once\x1b[0m",
		);
		assert.equal(result.ok, false);
		assert.match(
			result.ok ? "" : result.error,
			/^Workspace not trusted: run claude in \/Users\/me\/dev\/acme-api once/,
		);
	});

	it("surfaces the last line of other failures", () => {
		assert.deepEqual(launchResult("/x", "", "warming up\nboom\n"), {
			ok: false,
			error: "claude --bg failed: boom",
		});
	});
});
