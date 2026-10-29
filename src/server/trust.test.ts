import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { mirrorTrust, trustedRoot } from "./trust.ts";

const trusted = (...paths: string[]) => ({
	projects: Object.fromEntries(
		paths.map((path) => [path, { hasTrustDialogAccepted: true }]),
	),
});

describe("trustedRoot", () => {
	it("finds the directory itself or its nearest trusted ancestor", () => {
		assert.equal(trustedRoot(trusted("/work/app"), "/work/app"), "/work/app");
		assert.equal(trustedRoot(trusted("/work"), "/work/app/src"), "/work");
	});

	it("ignores untrusted entries and odd shapes", () => {
		assert.equal(
			trustedRoot(
				{ projects: { "/work": { hasTrustDialogAccepted: false } } },
				"/work/app",
			),
			null,
		);
		assert.equal(trustedRoot({}, "/work"), null);
		assert.equal(trustedRoot(null, "/work"), null);
	});
});

describe("mirrorTrust", () => {
	let dir = "";
	let from = "";
	let to = "";
	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "trust-"));
		from = join(dir, "default.json");
		to = join(dir, "profile.json");
	});
	afterEach(() => rm(dir, { recursive: true, force: true }));

	it("copies the trusted root into the profile, keeping its other settings", async () => {
		await writeFile(from, JSON.stringify(trusted("/work")));
		await writeFile(
			to,
			JSON.stringify({
				userID: "u",
				projects: { "/work": { allowedTools: ["Read"] } },
			}),
		);
		assert.equal(await mirrorTrust(from, to, "/work/app"), true);
		assert.deepEqual(JSON.parse(await readFile(to, "utf8")), {
			userID: "u",
			projects: {
				"/work": { allowedTools: ["Read"], hasTrustDialogAccepted: true },
			},
		});
		assert.equal((await stat(to)).mode & 0o777, 0o600);
	});

	it("changes nothing when the default login never trusted the directory", async () => {
		await writeFile(from, JSON.stringify(trusted("/elsewhere")));
		await writeFile(to, "{}");
		assert.equal(await mirrorTrust(from, to, "/work"), false);
		assert.equal(await readFile(to, "utf8"), "{}");
	});

	it("changes nothing when the profile already trusts it", async () => {
		await writeFile(from, JSON.stringify(trusted("/work")));
		await writeFile(to, JSON.stringify(trusted("/work")));
		assert.equal(await mirrorTrust(from, to, "/work"), false);
	});
});
