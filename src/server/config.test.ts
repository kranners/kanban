import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import {
	findClaude,
	isLoopback,
	loadConfig,
	withFileSecrets,
} from "./config.ts";

const access = {
	KANBAN_ACCESS_TEAM: "acme-team",
	KANBAN_ACCESS_AUD: "aud-123",
	KANBAN_ORIGIN: "https://kanban.example.com",
};

describe("loadConfig", () => {
	it("defaults to access auth on loopback port 7420", () => {
		const config = loadConfig(access);
		assert.equal(config.port, 7420);
		assert.equal(config.host, "127.0.0.1");
		assert.deepEqual(config.auth, {
			mode: "access",
			team: "acme-team",
			aud: "aud-123",
		});
		assert.deepEqual(config.origins, ["https://kanban.example.com"]);
		assert.equal(config.claudeBin, "claude");
		assert.equal(
			config.cmuxBin,
			"/Applications/cmux.app/Contents/Resources/bin/cmux",
		);
		assert.match(config.claudeHome, /\/\.claude$/);
		assert.match(config.dist, /\/dist$/);
		assert.match(config.stateDir, /\/\.local\/state\/kanban$/);
		assert.match(
			loadConfig({ ...access, KANBAN_PORT: "7421" }).stateDir,
			/\/\.local\/state\/kanban-7421$/,
		);
		assert.equal(
			loadConfig({ ...access, KANBAN_STATE: "/tmp/kanban-state" }).stateDir,
			"/tmp/kanban-state",
		);
	});

	it("refuses access auth without team or audience", () => {
		assert.throws(
			() => loadConfig({ KANBAN_ORIGIN: "https://kanban.example.com" }),
			/KANBAN_ACCESS_TEAM and KANBAN_ACCESS_AUD/,
		);
		assert.throws(
			() => loadConfig({ ...access, KANBAN_ACCESS_AUD: "" }),
			/KANBAN_ACCESS_AUD/,
		);
	});

	it("refuses access auth without an origin", () => {
		assert.throws(
			() => loadConfig({ ...access, KANBAN_ORIGIN: undefined }),
			/KANBAN_ORIGIN/,
		);
	});

	it("refuses auth off on a non-loopback host", () => {
		assert.throws(
			() => loadConfig({ KANBAN_AUTH: "off", KANBAN_HOST: "0.0.0.0" }),
			/loopback/,
		);
	});

	it("refuses auth off when any listed host is not loopback", () => {
		assert.throws(
			() =>
				loadConfig({
					KANBAN_AUTH: "off",
					KANBAN_HOST: "127.0.0.1,10.100.0.11",
				}),
			/loopback host, not "10\.100\.0\.11"/,
		);
		assert.throws(
			() =>
				loadConfig({
					KANBAN_AUTH: "off",
					KANBAN_HOST: "127.0.0.1,10.100.0.11",
					KANBAN_RUNNER_TOKEN: "a".repeat(64),
				}),
			/loopback/,
		);
	});

	it("binds loopback alongside a network address", () => {
		const config = loadConfig({ ...access, KANBAN_HOST: "10.100.0.11" });
		assert.deepEqual(config.hosts, ["127.0.0.1", "10.100.0.11"]);
		assert.equal(config.host, "127.0.0.1");
		assert.deepEqual(
			loadConfig({
				...access,
				KANBAN_HOST: " 127.0.0.1 , 10.100.0.11,127.0.0.1",
			}).hosts,
			["127.0.0.1", "10.100.0.11"],
		);
		assert.deepEqual(loadConfig({ ...access, KANBAN_HOST: "0.0.0.0" }).hosts, [
			"0.0.0.0",
		]);
		assert.throws(
			() => loadConfig({ ...access, KANBAN_HOST: "10.0.0.1/24" }),
			/KANBAN_HOST/,
		);
	});

	it("reads the runner token without ever echoing it", () => {
		assert.equal(loadConfig(access).runnerToken, null);
		const token = "Zx9_".repeat(10);
		assert.equal(
			loadConfig({ ...access, KANBAN_RUNNER_TOKEN: token }).runnerToken,
			token,
		);
		const short = "secret-but-short";
		assert.throws(
			() => loadConfig({ ...access, KANBAN_RUNNER_TOKEN: short }),
			(error: Error) =>
				/KANBAN_RUNNER_TOKEN/.test(error.message) &&
				!error.message.includes(short),
		);
	});

	it("reads the runner cap and the expected runners", () => {
		assert.equal(loadConfig(access).runnerCap, 4);
		assert.equal(
			loadConfig({ ...access, KANBAN_RUNNER_CAP: "2" }).runnerCap,
			2,
		);
		assert.throws(
			() => loadConfig({ ...access, KANBAN_RUNNER_CAP: "0" }),
			/KANBAN_RUNNER_CAP/,
		);
		assert.deepEqual(
			loadConfig({ ...access, KANBAN_RUNNERS: "spike, jimbo,,piggys-MBP" })
				.expectedRunners,
			["spike", "jimbo", "piggys-MBP"],
		);
	});

	it("allows local origins on the configured port with auth off", () => {
		const config = loadConfig({ KANBAN_AUTH: "off", KANBAN_PORT: "7499" });
		assert.deepEqual(config.auth, { mode: "off" });
		assert.deepEqual(config.origins, [
			"http://127.0.0.1:7499",
			"http://localhost:7499",
		]);
	});

	it("rejects unknown auth modes, bad ports and origins with paths", () => {
		assert.throws(() => loadConfig({ KANBAN_AUTH: "none" }), /KANBAN_AUTH/);
		assert.throws(
			() => loadConfig({ KANBAN_AUTH: "off", KANBAN_PORT: "70000" }),
			/KANBAN_PORT/,
		);
		assert.throws(
			() => loadConfig({ ...access, KANBAN_ORIGIN: "https://x.example/app" }),
			/bare origin/,
		);
	});

	it("honours overrides", () => {
		const config = loadConfig({
			KANBAN_AUTH: "off",
			KANBAN_HOST: "::1",
			CLAUDE_BIN: "/usr/local/bin/claude",
			CMUX_BIN: "/usr/local/bin/cmux",
			CLAUDE_HOME: "/Users/me/.claude-test",
			KANBAN_DIST: "/Users/me/dev/acme-api/dist",
		});
		assert.equal(config.host, "::1");
		assert.equal(config.claudeBin, "/usr/local/bin/claude");
		assert.equal(config.cmuxBin, "/usr/local/bin/cmux");
		assert.equal(config.claudeHome, "/Users/me/.claude-test");
		assert.equal(config.dist, "/Users/me/dev/acme-api/dist");
	});
});

describe("withFileSecrets", () => {
	it("fills the runner token from the env file only when unset", () => {
		const file = { KANBAN_RUNNER_TOKEN: "from-file", KANBAN_AUTH: "off" };
		assert.deepEqual(withFileSecrets({ PATH: "/bin" }, file), {
			PATH: "/bin",
			KANBAN_RUNNER_TOKEN: "from-file",
		});
		assert.equal(
			withFileSecrets({ KANBAN_RUNNER_TOKEN: "from-env" }, file)
				.KANBAN_RUNNER_TOKEN,
			"from-env",
		);
	});
});

describe("isLoopback", () => {
	it("accepts only loopback addresses", () => {
		for (const host of ["127.0.0.1", "127.1.2.3", "::1", "localhost"]) {
			assert.ok(isLoopback(host), host);
		}
		for (const host of ["0.0.0.0", "192.168.1.2", "::", "example.com"]) {
			assert.ok(!isLoopback(host), host);
		}
	});
});

describe("findClaude", () => {
	let dir: string;
	const bin = (name: string) => join(dir, name);

	before(async () => {
		dir = await mkdtemp(join(tmpdir(), "kanban-path-"));
		for (const name of ["cmux-cli-shims/ABC", "real", "plain", "empty"]) {
			await mkdir(bin(name), { recursive: true });
		}
		await mkdir(bin("folder/claude"), { recursive: true });
		for (const name of ["cmux-cli-shims/ABC", "real"]) {
			await writeFile(bin(`${name}/claude`), "#!/bin/sh\n");
			await chmod(bin(`${name}/claude`), 0o755);
		}
		await writeFile(bin("plain/claude"), "");
	});

	after(() => rm(dir, { recursive: true, force: true }));

	it("takes the first executable claude on PATH, past a terminal's shim", () => {
		assert.equal(
			findClaude(
				[
					bin("cmux-cli-shims/ABC"),
					bin("empty"),
					bin("folder"),
					bin("plain"),
					bin("real"),
				].join(":"),
			),
			bin("real/claude"),
		);
	});

	it("falls back to the bare name", () => {
		assert.equal(findClaude(bin("empty")), "claude");
		assert.equal(findClaude(undefined), "claude");
	});
});
