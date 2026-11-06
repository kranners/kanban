import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createSelfUpdate, fileVersion, versionOf } from "./update.ts";

const fresh = new TextEncoder().encode("// the board's new runner\n");

const setup = async (
	options: { idle?: () => boolean; served?: Uint8Array; status?: number } = {},
) => {
	const dir = await mkdtemp(join(tmpdir(), "runner-update-"));
	const script = join(dir, "runner.js");
	await writeFile(script, "// old runner\n");
	const current = (await fileVersion(script)) ?? "";
	let exits = 0;
	let fetches = 0;
	const logs: string[] = [];
	const updater = createSelfUpdate({
		script,
		current,
		hub: "https://board.example",
		token: "t".repeat(40),
		idle: options.idle ?? (() => true),
		exit: () => {
			exits += 1;
		},
		fetch: (async (url: string, init: RequestInit) => {
			fetches += 1;
			assert.equal(url, "https://board.example/runner.js");
			assert.deepEqual(init.headers, {
				authorization: `Bearer ${"t".repeat(40)}`,
			});
			return new Response(Buffer.from(options.served ?? fresh), {
				status: options.status ?? 200,
			});
		}) as typeof fetch,
		log: (line) => logs.push(line),
		retryMs: 5,
	});
	return {
		script,
		current,
		updater,
		exits: () => exits,
		fetches: () => fetches,
		logs,
	};
};

const settle = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

describe("runner self-update", () => {
	it("does nothing while the hub serves the code it runs", async () => {
		const { updater, current, fetches, exits } = await setup();
		updater.offer(current);
		await settle();
		assert.equal(fetches(), 0);
		assert.equal(exits(), 0);
	});

	it("replaces its own file with the board's runner and restarts", async () => {
		const { updater, script, exits, logs } = await setup();
		updater.offer(versionOf(fresh));
		await settle();
		assert.deepEqual(await readFile(script), Buffer.from(fresh));
		assert.equal(exits(), 1);
		assert.match(logs.join("\n"), /updated, restarting/);
	});

	it("waits until no session is live", async () => {
		let idle = false;
		const { updater, exits, fetches } = await setup({ idle: () => idle });
		updater.offer(versionOf(fresh));
		await settle();
		assert.equal(fetches(), 0, "never mid-session");
		idle = true;
		await settle();
		assert.equal(exits(), 1);
	});

	it("keeps its code and tries a version once when the download is wrong", async () => {
		const { updater, script, exits, fetches, logs } = await setup({
			served: new TextEncoder().encode("something else"),
		});
		updater.offer(versionOf(fresh));
		await settle();
		updater.offer(versionOf(fresh));
		await settle();
		assert.equal(await readFile(script, "utf8"), "// old runner\n");
		assert.equal(exits(), 0);
		assert.equal(fetches(), 1);
		assert.match(logs.join("\n"), /couldn't update/);
	});

	it("keeps its code when the hub refuses", async () => {
		const { updater, script, exits } = await setup({ status: 403 });
		updater.offer(versionOf(fresh));
		await settle();
		assert.equal(await readFile(script, "utf8"), "// old runner\n");
		assert.equal(exits(), 0);
	});
});
