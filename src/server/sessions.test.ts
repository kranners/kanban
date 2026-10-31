import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { describe, it } from "node:test";
import { maxImageBytes, maxPromptImages } from "../shared/promptImages.ts";
import {
	claudeLauncher,
	launchArgs,
	launchCommand,
	launchResult,
	parseBackgrounded,
	routedLauncher,
	saveImages,
	validateNewSession,
} from "./sessions.ts";

const valid = { cwd: tmpdir(), name: "acme-api fix", prompt: "say hi" };

describe("validateNewSession", () => {
	it("accepts a request for an existing directory", async () => {
		assert.deepEqual(await validateNewSession({ ...valid, name: "  acme  " }), {
			...valid,
			name: "acme",
			runsOn: "cloud",
		});
	});

	it("leaves the name to Claude Code when it is missing or blank", async () => {
		const { name: _name, ...unnamed } = valid;
		assert.deepEqual(await validateNewSession(unnamed), {
			...unnamed,
			runsOn: "cloud",
		});
		assert.deepEqual(await validateNewSession({ ...valid, name: "  " }), {
			...unnamed,
			runsOn: "cloud",
		});
		assert.deepEqual(launchArgs(unnamed, null, '{"hooks":{}}'), [
			"--bg",
			'--settings={"hooks":{}}',
			"--",
			"say hi",
		]);
		assert.deepEqual(launchArgs(unnamed), ["--bg", "--", "say hi"]);
		assert.deepEqual(
			launchArgs(unnamed, null, '{"hooks":{}}', '{"mcpServers":{}}'),
			[
				"--bg",
				'--settings={"hooks":{}}',
				'--mcp-config={"mcpServers":{}}',
				"--",
				"say hi",
			],
		);
		assert.deepEqual(launchArgs(valid), [
			"--bg",
			"--name=acme-api fix",
			"--",
			"say hi",
		]);
	});

	it("keeps the board point a session should spawn at", async () => {
		assert.deepEqual(
			await validateNewSession({ ...valid, at: { x: -40, y: 120, z: 1 } }),
			{ ...valid, at: { x: -40, y: 120 }, runsOn: "cloud" },
		);
	});

	it("keeps the account a session should run on, in the cloud or here", async () => {
		assert.deepEqual(await validateNewSession({ ...valid, account: 3 }), {
			...valid,
			account: 3,
			runsOn: "cloud",
		});
		assert.deepEqual(
			await validateNewSession({ ...valid, account: 3, runsOn: "local" }),
			{ ...valid, account: 3, runsOn: "local" },
		);
	});

	it("runs a session in the cloud unless asked or it needs this Mac", async () => {
		assert.deepEqual(await validateNewSession({ ...valid, runsOn: "cloud" }), {
			...valid,
			runsOn: "cloud",
		});
		assert.deepEqual(
			await validateNewSession({ ...valid, runsOn: "local", account: 2 }),
			{ ...valid, account: 2, runsOn: "local" },
		);
		assert.deepEqual(await validateNewSession(valid), {
			...valid,
			runsOn: "cloud",
		});
		for (const prompt of [
			"session_01abc",
			"https://claude.ai/code/session_01abc please",
		]) {
			const result = await validateNewSession({ ...valid, prompt });
			assert.match("error" in result ? result.error : "", /cloud session id/);
		}
		assert.deepEqual(
			await validateNewSession({
				...valid,
				prompt: "session_01abc",
				runsOn: "local",
			}),
			{ ...valid, prompt: "session_01abc", runsOn: "local" },
		);
	});

	it("accepts a remote-control host id as where it runs", async () => {
		assert.deepEqual(
			await validateNewSession({ ...valid, runsOn: "env_01T8abc", account: 2 }),
			{ ...valid, account: 2, runsOn: "env_01T8abc" },
		);
		assert.deepEqual(
			await validateNewSession({
				...valid,
				prompt: "session_01abc",
				runsOn: "env_01T8abc",
			}),
			{ ...valid, prompt: "session_01abc", runsOn: "env_01T8abc" },
		);
	});

	it("rejects bad input with a reason", async () => {
		const cases: [unknown, RegExp][] = [
			[null, /JSON object/],
			[{ ...valid, cwd: "dev/acme-api" }, /absolute/],
			[{ ...valid, cwd: "/Users/me/dev/acme-api-missing" }, /not an existing/],
			[{ ...valid, cwd: import.meta.filename }, /not an existing directory/],
			[{ ...valid, name: 7 }, /name must be a string/],
			[{ ...valid, name: "x".repeat(61) }, /at most 60/],
			[{ ...valid, name: "two\nlines" }, /one line/],
			[{ ...valid, prompt: "   " }, /prompt is required/],
			[{ ...valid, at: { x: 1 } }, /at must be a point/],
			[{ ...valid, at: { x: 1, y: Number.NaN } }, /at must be a point/],
			[{ ...valid, account: 0 }, /account must be a positive/],
			[{ ...valid, account: 1.5 }, /account must be a positive/],
			[{ ...valid, account: "2" }, /account must be a positive/],
			[
				{ ...valid, runsOn: "mars" },
				/runsOn must be cloud, local or a remote-control host id/,
			],
			[{ ...valid, runsOn: "env_" }, /remote-control host id/],
			[{ ...valid, runsOn: "env_01/../x" }, /remote-control host id/],
			[
				{
					...valid,
					runsOn: "env_01abc",
					images: [{ type: "image/png", data: "cG5n" }],
				},
				/Images can only be sent to sessions on this Mac/,
			],
			[
				{
					...valid,
					runsOn: "cloud",
					images: [{ type: "image/png", data: "cG5n" }],
				},
				/Images can only be sent to sessions on this Mac/,
			],
		];
		for (const [body, reason] of cases) {
			const result = await validateNewSession(body);
			assert.ok("error" in result, JSON.stringify(body));
			assert.match(result.error, reason);
		}
	});
});

describe("doc stores at spawn", () => {
	it("runs a session with doc stores on this Mac", async () => {
		assert.deepEqual(
			await validateNewSession({ ...valid, docs: ["d1", "d2"] }),
			{
				...valid,
				docs: ["d1", "d2"],
				runsOn: "local",
			},
		);
		assert.deepEqual(
			await validateNewSession({ ...valid, docs: ["d1"], runsOn: "local" }),
			{ ...valid, docs: ["d1"], runsOn: "local" },
		);
	});

	it("treats an empty list as no doc stores", async () => {
		assert.deepEqual(await validateNewSession({ ...valid, docs: [] }), {
			...valid,
			runsOn: "cloud",
		});
	});

	it("refuses doc stores for sessions elsewhere", async () => {
		for (const runsOn of ["cloud", "env_01T8abc"]) {
			const result = await validateNewSession({
				...valid,
				docs: ["d1"],
				runsOn,
			});
			assert.ok("error" in result, runsOn);
			assert.equal(
				result.error,
				"Doc stores can only be linked to sessions on this Mac",
			);
		}
	});

	it("refuses malformed, duplicate or too many ids", async () => {
		for (const docs of [
			"d1",
			[7],
			[""],
			["../d1"],
			["-d1"],
			["d1", "d1"],
			Array.from({ length: 21 }, (_, index) => `d${index}`),
		]) {
			const result = await validateNewSession({ ...valid, docs });
			assert.ok("error" in result, JSON.stringify(docs));
			assert.equal(result.error, "docs must be up to 20 doc store ids");
		}
		assert.ok(
			!(
				"error" in
				(await validateNewSession({
					...valid,
					docs: Array.from({ length: 20 }, (_, index) => `d${index}`),
				}))
			),
		);
	});

	it("tells the session about its doc stores after the prompt", () => {
		assert.deepEqual(launchArgs({ ...valid, docs: ["d1"] }), [
			"--bg",
			"--name=acme-api fix",
			"--",
			"say hi\n\nThe kanban board linked this session to doc store d1: shared docs for this area of work. Call mcp__kanban__list_docs before you start and read what's relevant with mcp__kanban__read_doc; keep it current with mcp__kanban__write_doc as you learn things others working here will need.",
		]);
		const saved = { folder: "/tmp/p", paths: ["/tmp/p/image-1.png"] };
		assert.deepEqual(
			launchArgs({ ...valid, docs: ["d1", "d2"] }, saved).at(-1),
			"say hi\n\nThe kanban board linked this session to doc stores d1, d2: shared docs for this area of work. Call mcp__kanban__list_docs before you start and read what's relevant with mcp__kanban__read_doc; keep them current with mcp__kanban__write_doc as you learn things others working here will need.\n\n/tmp/p/image-1.png",
		);
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

	it("parses a coloured short", () => {
		assert.equal(
			parseBackgrounded("backgrounded · \x1b[36ma2471401\x1b[39m · probe\n"),
			"a2471401",
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

	it("asks for trust under the chosen account's profile", () => {
		const result = launchResult(
			"/x",
			"Launching Account-2\n",
			"Workspace not trusted",
			2,
		);
		assert.match(
			result.ok ? "" : result.error,
			/^Workspace not trusted: run cswap run 2 in \/x once/,
		);
	});

	it("surfaces the last line of other failures", () => {
		assert.deepEqual(launchResult("/x", "", "warming up\nboom\n"), {
			ok: false,
			error: "claude --bg failed: boom",
		});
	});
});

describe("launchCommand", () => {
	const env = { PATH: "/usr/bin", HOME: "/home/me" };

	it("runs claude directly on the default account", () => {
		assert.deepEqual(
			launchCommand("/nix/bin/claude", "cswap", valid, null, env),
			{
				file: "/nix/bin/claude",
				args: ["--bg", "--name=acme-api fix", "--", "say hi"],
				env,
			},
		);
	});

	it("runs claude through cswap for another account", () => {
		assert.deepEqual(
			launchCommand(
				"/nix/bin/claude",
				"cswap",
				{ ...valid, account: 2 },
				null,
				env,
			),
			{
				file: "cswap",
				args: [
					"run",
					"2",
					"--share-history",
					"--",
					"--bg",
					"--name=acme-api fix",
					"--",
					"say hi",
				],
				env: { PATH: "/nix/bin:/usr/bin", HOME: "/home/me" },
			},
		);
	});

	it("leaves PATH alone when claude is found on it", () => {
		assert.deepEqual(
			launchCommand("claude", "cswap", { ...valid, account: 2 }, null, env).env,
			env,
		);
	});
});

describe("prompt images", () => {
	const png = {
		type: "image/png",
		data: Buffer.from("png bytes").toString("base64"),
	};

	it("keeps attached images", async () => {
		assert.deepEqual(await validateNewSession({ ...valid, images: [png] }), {
			...valid,
			images: [png],
			runsOn: "local",
		});
		assert.deepEqual(await validateNewSession({ ...valid, images: [] }), {
			...valid,
			runsOn: "cloud",
		});
	});

	it("rejects images it can't hand to Claude", async () => {
		const tooBig = "AAAA".repeat(Math.ceil(maxImageBytes / 3) + 1);
		const cases: [unknown, RegExp][] = [
			["png", /images must be/],
			[[{ ...png, type: "image/svg+xml" }], /images must be/],
			[[{ ...png, data: "not base64!" }], /images must be/],
			[[{ ...png, data: "" }], /images must be/],
			[Array(maxPromptImages + 1).fill(png), /at most 8 images/],
			[[{ ...png, data: tooBig }], /at most 5 MB/],
		];
		for (const [images, reason] of cases) {
			const result = await validateNewSession({ ...valid, images });
			assert.ok("error" in result, JSON.stringify(images).slice(0, 80));
			assert.match(result.error, reason);
		}
	});

	it("saves images where the session may read them", async () => {
		const dir = await mkdtemp(join(tmpdir(), "kanban-images-"));
		try {
			const saved = await saveImages(join(dir, "images"), [
				png,
				{ type: "image/jpeg", data: png.data },
			]);
			assert.deepEqual(
				saved.paths.map((path) => relative(saved.folder, path)),
				["image-1.png", "image-2.jpg"],
			);
			assert.equal(
				await readFile(saved.paths[0] as string, "utf8"),
				"png bytes",
			);
			assert.deepEqual(launchArgs({ ...valid, images: [png] }, saved), [
				"--bg",
				"--name=acme-api fix",
				`--add-dir=${saved.folder}`,
				"--",
				`say hi\n\n${saved.paths[0]}\n\n${saved.paths[1]}`,
			]);
		} finally {
			await rm(dir, { recursive: true });
		}
	});

	it("reports images it can't save instead of launching", async () => {
		const launch = claudeLauncher("/bin/false", import.meta.filename);
		const result = await launch({ ...valid, images: [png] });
		assert.equal(result.ok, false);
		assert.match(result.ok ? "" : result.error, /Couldn't save the images/);
	});

	it("mirrors the default login's trust into an account profile and retries", async () => {
		const dir = await mkdtemp(join(tmpdir(), "trust-launch-"));
		try {
			const cwd = join(dir, "work");
			await mkdir(cwd);
			const profile = join(dir, "profile");
			await mkdir(profile);
			await writeFile(join(profile, ".claude.json"), "{}");
			const defaultConfig = join(dir, "default.json");
			await writeFile(
				defaultConfig,
				JSON.stringify({
					projects: { [dir]: { hasTrustDialogAccepted: true } },
				}),
			);
			const cswap = join(dir, "cswap");
			await writeFile(
				cswap,
				`#!/bin/sh\ngrep -q hasTrustDialogAccepted "${profile}/.claude.json" && echo "backgrounded · deadbeef · x" || echo "Workspace not trusted"\n`,
				{ mode: 0o755 },
			);
			const launch = claudeLauncher("/bin/false", dir, {
				cswapBin: cswap,
				defaultConfig,
				profileOf: () => profile,
			});
			assert.deepEqual(await launch({ ...valid, cwd, account: 2 }), {
				ok: true,
				short: "deadbeef",
			});
		} finally {
			await rm(dir, { recursive: true });
		}
	});
});

describe("routedLauncher", () => {
	const records: unknown[] = [];
	const launch = routedLauncher(
		async () => ({ ok: true, short: "feedbeef" }),
		async (request) =>
			request.prompt === "fail"
				? { ok: false, error: "claude --cloud failed: nope" }
				: request.account === 2
					? { ok: true, id: "session_01other", configDir: "/profiles/2" }
					: { ok: true, id: "session_01cloud" },
		async (request) => ({
			ok: true,
			id: `session_01${request.runsOn?.slice(4)}`,
			configDir: "/profiles/3",
		}),
		(record) => records.push(record),
		(account) => (account === 4 ? "/profiles/4" : undefined),
	);

	it("creates a cloud session and records it", async () => {
		const before = Date.now();
		assert.deepEqual(await launch({ ...valid, runsOn: "cloud" }), {
			ok: true,
			id: "session_01cloud",
		});
		const [record] = records as { createdAt: number }[];
		assert.ok(record && record.createdAt >= before);
		assert.deepEqual(records, [
			{
				id: "session_01cloud",
				cwd: valid.cwd,
				name: valid.name,
				createdAt: record?.createdAt,
				prompt: valid.prompt,
			},
		]);
	});

	it("records the account profile a cloud session runs on", async () => {
		records.length = 0;
		assert.deepEqual(await launch({ ...valid, runsOn: "cloud", account: 2 }), {
			ok: true,
			id: "session_01other",
		});
		assert.deepEqual(
			(records as { configDir?: string }[]).map(({ configDir }) => configDir),
			["/profiles/2"],
		);
	});

	it("binds a cloud session on the default account to that account's profile", async () => {
		records.length = 0;
		await launch({ ...valid, runsOn: "cloud", account: 4 });
		assert.deepEqual(
			(records as { configDir?: string }[]).map(({ configDir }) => configDir),
			["/profiles/4"],
		);
	});

	it("starts a session on a remote-control host and records it like a cloud one", async () => {
		records.length = 0;
		assert.deepEqual(await launch({ ...valid, runsOn: "env_01host" }), {
			ok: true,
			id: "session_0101host",
		});
		assert.deepEqual(
			(records as { id: string; configDir?: string }[]).map(
				({ id, configDir }) => [id, configDir],
			),
			[["session_0101host", "/profiles/3"]],
		);
		assert.equal((records[0] as { prompt?: string }).prompt, undefined);
	});

	it("leaves local sessions and failed cloud launches alone", async () => {
		records.length = 0;
		assert.deepEqual(await launch({ ...valid, runsOn: "local" }), {
			ok: true,
			short: "feedbeef",
		});
		assert.deepEqual(
			await launch({ ...valid, prompt: "fail", runsOn: "cloud" }),
			{ ok: false, error: "claude --cloud failed: nope" },
		);
		assert.deepEqual(records, []);
	});
});
