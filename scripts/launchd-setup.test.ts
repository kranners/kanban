import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	buildPath,
	looseMode,
	renderPlist,
	runnerPlist,
	withoutSecrets,
} from "./launchd-setup.ts";

describe("renderPlist", () => {
	const xml = renderPlist({
		label: "kanban-example",
		programArguments: [
			"/opt/homebrew/bin/node",
			"/Users/me/kanban/scripts/example.ts",
		],
		workingDirectory: "/Users/me/kanban",
		environment: {
			PATH: "/opt/homebrew/bin:/usr/bin",
			KANBAN_ORIGIN: "https://a.example.com/?x=1&y=<2>",
		},
		runAtLoad: true,
		startInterval: 60,
		log: "/Users/me/Library/Logs/kanban/example.log",
	});

	it("writes the keys launchd needs", () => {
		assert.match(xml, /^<\?xml version="1.0" encoding="UTF-8"\?>/);
		assert.match(xml, /<key>Label<\/key><string>kanban-example<\/string>/);
		assert.match(
			xml,
			/<array>\n\t\t<string>\/opt\/homebrew\/bin\/node<\/string>\n\t\t<string>\/Users\/me\/kanban\/scripts\/example.ts<\/string>\n\t<\/array>/,
		);
		assert.match(
			xml,
			/<key>WorkingDirectory<\/key><string>\/Users\/me\/kanban<\/string>/,
		);
		assert.match(xml, /<key>RunAtLoad<\/key><true\/>/);
		assert.match(xml, /<key>StartInterval<\/key><integer>60<\/integer>/);
		assert.match(
			xml,
			/<key>StandardErrorPath<\/key><string>\/Users\/me\/Library\/Logs\/kanban\/example.log<\/string>/,
		);
		assert.doesNotMatch(xml, /KeepAlive/);
	});

	it("escapes XML in values", () => {
		assert.match(
			xml,
			/<key>KANBAN_ORIGIN<\/key><string>https:\/\/a.example.com\/\?x=1&amp;y=&lt;2&gt;<\/string>/,
		);
	});

	it("writes KeepAlive for long-running agents", () => {
		const server = renderPlist({
			label: "kanban",
			programArguments: [
				"/usr/local/bin/node",
				"/Users/me/kanban/src/server/main.ts",
			],
			keepAlive: true,
			log: "/Users/me/Library/Logs/kanban/server.log",
		});
		assert.match(server, /<key>KeepAlive<\/key><true\/>/);
		assert.doesNotMatch(
			server,
			/StartInterval|EnvironmentVariables|WorkingDirectory/,
		);
	});
});

describe("buildPath", () => {
	it("keeps order, splits entries and drops duplicates and blanks", () => {
		assert.equal(
			buildPath([
				"/opt/homebrew/bin",
				null,
				"/Users/me/.local/bin",
				"",
				"/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
			]),
			"/opt/homebrew/bin:/Users/me/.local/bin:/usr/local/bin:/usr/bin:/bin",
		);
	});
});

describe("withoutSecrets", () => {
	it("keeps the runner token out of plists", () => {
		assert.deepEqual(
			withoutSecrets({
				KANBAN_HOST: "127.0.0.1,10.100.0.11",
				KANBAN_RUNNER_TOKEN: "s3cret",
			}),
			{ KANBAN_HOST: "127.0.0.1,10.100.0.11" },
		);
	});
});

describe("looseMode", () => {
	it("flags env files others can read", () => {
		assert.equal(looseMode(0o100600), false);
		assert.equal(looseMode(0o100644), true);
		assert.equal(looseMode(0o100640), true);
	});
});

describe("runnerPlist", () => {
	it("runs the runner from the checkout with no secrets in the plist", () => {
		const plist = renderPlist(
			runnerPlist({
				node: "/opt/homebrew/bin/node",
				root: "/Users/me/kanban",
				path: "/opt/homebrew/bin:/usr/bin",
				logs: "/Users/me/Library/Logs/kanban",
			}),
		);
		assert.match(plist, /<string>kanban-runner<\/string>/);
		assert.match(
			plist,
			/<string>\/Users\/me\/kanban\/src\/runner\/main\.ts<\/string>/,
		);
		assert.match(plist, /<key>KeepAlive<\/key><true\/>/);
		assert.doesNotMatch(plist, /TOKEN/);
	});
});
