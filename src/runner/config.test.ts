import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parsePaths, parseRunnerConfig } from "./config.ts";

const token = "k".repeat(64);

describe("parseRunnerConfig", () => {
	it("takes flags first, then the environment, then the env file", () => {
		const config = parseRunnerConfig(
			["--hub", "http://10.100.0.11:7420/", "--cap", "3"],
			{ KANBAN_RUNNER_NAME: "jimbo-linux", KANBAN_RUNNER_CAP: "9" },
			{
				KANBAN_RUNNER_TOKEN: token,
				KANBAN_RUNNER_HUB: "http://elsewhere:1",
				KANBAN_RUNNER_CLAUDE_ARGS: "--permission-mode  acceptEdits",
				KANBAN_RUNNER_PATHS: "/Users/aaron/code=/srv/code",
			},
			"jimbo",
		);
		assert.deepEqual(config, {
			hub: "http://10.100.0.11:7420",
			token,
			name: "jimbo-linux",
			cap: 3,
			claudeBin: "claude",
			claudeArgs: ["--permission-mode", "acceptEdits"],
			paths: [["/Users/aaron/code", "/srv/code"]],
		});
	});

	it("names the machine after its hostname by default", () => {
		const config = parseRunnerConfig(
			[],
			{
				KANBAN_RUNNER_HUB: "http://10.100.0.1:7420",
				KANBAN_RUNNER_TOKEN: token,
			},
			{},
			"piggys-MBP",
		);
		assert.equal(config.name, "piggys-MBP");
		assert.equal(config.cap, 4);
	});

	it("refuses a missing hub or token, a bad token and a bad cap", () => {
		const hub = { KANBAN_RUNNER_HUB: "http://10.100.0.11:7420" };
		assert.throws(() => parseRunnerConfig([], {}, {}), /--hub/);
		assert.throws(() => parseRunnerConfig([], hub, {}), /KANBAN_RUNNER_TOKEN/);
		assert.throws(
			() => parseRunnerConfig([], { ...hub, KANBAN_RUNNER_TOKEN: "short" }, {}),
			(error: Error) =>
				/32-128/.test(error.message) && !error.message.includes("short"),
		);
		assert.throws(
			() =>
				parseRunnerConfig(
					["--cap", "0"],
					{ ...hub, KANBAN_RUNNER_TOKEN: token },
					{},
				),
			/--cap/,
		);
		assert.throws(
			() =>
				parseRunnerConfig(
					["--hub", "ftp://x"],
					{ KANBAN_RUNNER_TOKEN: token },
					{},
				),
			/http or https/,
		);
		assert.throws(() => parseRunnerConfig(["--bogus"], hub, {}), /bogus/);
	});
});

describe("parsePaths", () => {
	it("reads from=to pairs", () => {
		assert.deepEqual(parsePaths(" /a=/b ; C:/x=D:\\y;"), [
			["/a", "/b"],
			["C:/x", "D:\\y"],
		]);
		assert.throws(() => parsePaths("nonsense"), /from=to/);
	});
});
