import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { Session } from "../shared/types.ts";
import {
	type Cmux,
	type CmuxSurface,
	cmuxCli,
	createCmuxTargets,
	explainFailure,
	parseSurfaces,
} from "./cmux.ts";

const workspace = "AAAAAAAA-0000-0000-0000-000000000001";
const pane = "BBBBBBBB-0000-0000-0000-000000000002";
const surface = "CCCCCCCC-0000-0000-0000-000000000003";
const browserPane = "DDDDDDDD-0000-0000-0000-000000000004";

const row = (kind: string, ref: string, parent: string, title = "") =>
	["0.0", "1", "1", kind, ref, parent, title].join("\t");

const topTsv = [
	row("total", "total", ""),
	row("window", "WINDOW", "total"),
	row("workspace", workspace, "WINDOW", "acme-api"),
	row("tag", `${workspace}:tag:claude_code`, workspace, "Waiting"),
	row("process", "100", `${workspace}:tag:claude_code`, "claude"),
	row("pane", pane, workspace),
	row("surface", surface, pane, "acme-api"),
	row("process", "100", surface, "claude"),
	row("process", "101", "100", "node"),
	row("process", "200", surface, "login"),
	row("process", "201", "200", "zsh"),
	row("process", "202", "201", "claude"),
	row("pane", browserPane, workspace),
	row("webview", "EEEE", browserPane, "docs"),
	row("process", "300", `${workspace}:tag:claude_code`, "claude"),
	"",
].join("\n");

const target: CmuxSurface = { workspace, surface };

describe("parseSurfaces", () => {
	it("maps each process in a surface's tree to that surface", () => {
		const surfaces = parseSurfaces(topTsv);
		assert.deepEqual(surfaces.get(100), target);
		assert.deepEqual(surfaces.get(101), target);
		assert.deepEqual(surfaces.get(202), target);
	});

	it("ignores processes attributed only to a status tag", () => {
		assert.equal(parseSurfaces(topTsv).has(300), false);
		assert.equal(parseSurfaces("").size, 0);
	});
});

describe("explainFailure", () => {
	it("says how to let kanban in when cmux refuses it", () => {
		assert.match(
			explainFailure("/bin/cmux", "Error: access denied"),
			/^cmux refused kanban \(access denied\)\. .*CMUX_SOCKET_PASSWORD/,
		);
		assert.equal(
			explainFailure("/nope/cmux", "spawn /nope/cmux ENOENT"),
			"cmux was not found at /nope/cmux; set CMUX_BIN",
		);
		assert.equal(explainFailure("/bin/cmux", ""), "cmux: no output");
	});

	it("explains an open question or a draft without mentioning cmux flags", () => {
		const dialog = explainFailure(
			"/bin/cmux",
			"Error: paste: 313A is waiting on a question or dialog, so nothing was sent. Retry once it is answered, or pass --force to send anyway.",
		);
		const draft = explainFailure(
			"/bin/cmux",
			"Error: paste: the agent prompt in 313A holds text someone is typing, so nothing was sent. Retry when the prompt is clear, or pass --force to send anyway.",
		);
		for (const message of [dialog, draft]) {
			assert.doesNotMatch(message, /--force|cmux/);
		}
		assert.match(dialog, /question open/);
		assert.match(draft, /typing/);
	});
});

describe("cmuxCli against a fake cmux", () => {
	let dir = "";
	let bin = "";
	let log = "";
	const inherited = process.env.CMUX_SURFACE_ID;

	before(async () => {
		dir = await mkdtemp(join(tmpdir(), "kanban-cmux-"));
		bin = join(dir, "cmux");
		log = join(dir, "calls.log");
		await writeFile(join(dir, "top.tsv"), topTsv);
		await writeFile(
			bin,
			[
				"#!/bin/sh",
				`printf '%s|' "$@" >> '${log}'`,
				`printf 'surface-env=%s\\n' "\${CMUX_SURFACE_ID:-unset}" >> '${log}'`,
				`if [ -f '${dir}/refuse' ]; then echo 'Error: socket access denied' >&2; exit 1; fi`,
				'case "$1" in',
				`  top) cat '${dir}/top.tsv' ;;`,
				"  read-screen) printf '❯ hello\\n' ;;",
				"  *) echo OK ;;",
				"esac",
				"",
			].join("\n"),
		);
		await chmod(bin, 0o755);
		process.env.CMUX_SURFACE_ID = "SERVER-OWN-SURFACE";
	});

	after(async () => {
		if (inherited === undefined) delete process.env.CMUX_SURFACE_ID;
		else process.env.CMUX_SURFACE_ID = inherited;
		await rm(dir, { recursive: true, force: true });
	});

	const calls = async () =>
		(await readFile(log, "utf8").catch(() => "")).trim().split("\n");

	it("lists surfaces, reads screens and types into one named surface", async () => {
		const cmux = cmuxCli(bin);
		const surfaces = await cmux.surfaces();
		assert.ok(surfaces.ok);
		assert.deepEqual(surfaces.value.get(202), target);
		assert.deepEqual(await cmux.readScreen(target), {
			ok: true,
			value: "❯ hello\n",
		});
		assert.deepEqual(await cmux.paste(target, "-n ship it", true), {
			ok: true,
			value: null,
		});
		await cmux.sendKey(target, "Shift+Tab");
		assert.deepEqual(await calls(), [
			"top|--all|--processes|--format|tsv|--id-format|uuids|surface-env=unset",
			`read-screen|--workspace|${workspace}|--surface|${surface}|surface-env=unset`,
			`paste|--workspace|${workspace}|--surface|${surface}|--submit|--|-n ship it|surface-env=unset`,
			`send-key|--workspace|${workspace}|--surface|${surface}|--force|--|shift+tab|surface-env=unset`,
		]);
	});

	it("explains a refusal instead of hanging", async () => {
		await writeFile(join(dir, "refuse"), "");
		const result = await cmuxCli(bin).paste(target, "hi", false);
		assert.equal(result.ok, false);
		assert.match(
			result.ok ? "" : result.error,
			/^cmux refused kanban \(socket access denied\)/,
		);
		await rm(join(dir, "refuse"));
	});

	it("names a missing binary", async () => {
		const result = await cmuxCli(join(dir, "missing")).surfaces();
		assert.deepEqual(result, {
			ok: false,
			error: `cmux was not found at ${join(dir, "missing")}; set CMUX_BIN`,
		});
	});
});

const session: Session = {
	id: "11111111-2222-3333-4444-555555555555",
	short: null,
	pid: 202,
	name: "acme-api",
	cwd: "/Users/me/dev/acme-api",
	project: "acme-api",
	kind: "interactive",
	activity: "idle",
	doing: null,
	needs: null,
	goal: null,
	startedAt: 0,
	updatedAt: 0,
	attachable: false,
	cmux: true,
	artifacts: [],
};

const fakeCmux = (surfaces: Map<number, CmuxSurface> | string): Cmux => ({
	surfaces: async () =>
		typeof surfaces === "string"
			? { ok: false, error: surfaces }
			: { ok: true, value: surfaces },
	readScreen: async () => ({ ok: true, value: "" }),
	paste: async () => ({ ok: true, value: null }),
	sendKey: async () => ({ ok: true, value: null }),
});

describe("createCmuxTargets", () => {
	it("resolves a live session to its surface and caches it for the board", async () => {
		const targets = createCmuxTargets({
			cmux: fakeCmux(parseSurfaces(topTsv)),
			live: async () => true,
		});
		assert.equal(targets.has(202), false);
		assert.equal(await targets.refresh(), true);
		assert.equal(await targets.refresh(), false);
		assert.equal(targets.has(202), true);
		assert.deepEqual(await targets.resolve(session), {
			ok: true,
			value: target,
		});
	});

	it("never resolves a reused pid or a session outside cmux", async () => {
		const reused = createCmuxTargets({
			cmux: fakeCmux(parseSurfaces(topTsv)),
			live: async () => false,
		});
		assert.deepEqual(await reused.resolve(session), {
			ok: false,
			error: "The session's process is no longer the one on the board",
		});
		const elsewhere = createCmuxTargets({
			cmux: fakeCmux(new Map()),
			live: async () => true,
		});
		assert.equal((await elsewhere.resolve(session)).ok, false);
		assert.equal(
			(await elsewhere.resolve({ ...session, kind: "background" })).ok,
			false,
		);
	});

	it("reports a refusal once and drops cached surfaces", async () => {
		const errors: string[] = [];
		let refuse = false;
		const cmux = fakeCmux(parseSurfaces(topTsv));
		const targets = createCmuxTargets({
			cmux: {
				...cmux,
				surfaces: async () =>
					refuse ? { ok: false, error: "refused" } : cmux.surfaces(),
			},
			live: async () => true,
			onError: (error) => errors.push(error),
		});
		await targets.refresh();
		refuse = true;
		assert.equal(await targets.refresh(), true);
		await targets.refresh();
		assert.equal(targets.has(202), false);
		assert.deepEqual(errors, ["refused"]);
		assert.deepEqual(await targets.resolve(session), {
			ok: false,
			error: "refused",
		});
	});
});
