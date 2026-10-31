import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { kanbanEnvPath, parseEnvFile, readKanbanEnv } from "./env-file.ts";

describe("parseEnvFile", () => {
	it("reads keys, skipping comments and blanks", () => {
		assert.deepEqual(
			parseEnvFile(
				"# kanban\n\nKANBAN_ACCESS_TEAM=acme\nexport KANBAN_SYNC=off\r\n",
			),
			{ KANBAN_ACCESS_TEAM: "acme", KANBAN_SYNC: "off" },
		);
	});

	it("strips matching quotes and keeps = in values", () => {
		assert.deepEqual(parseEnvFile(`A="x y"\nB='z'\nC=a=b\nD="open`), {
			A: "x y",
			B: "z",
			C: "a=b",
			D: '"open',
		});
	});

	it("ignores malformed lines", () => {
		assert.deepEqual(parseEnvFile("=x\nno equals\n1BAD=y\nOK=\n"), {
			OK: "",
		});
	});
});

describe("readKanbanEnv", () => {
	it("returns nothing for a missing file", () => {
		assert.deepEqual(readKanbanEnv("/nonexistent/kanban/env"), {});
	});

	it("reads the file", async () => {
		const dir = await mkdtemp(join(tmpdir(), "kanban-env-"));
		const file = join(dir, "env");
		await writeFile(file, "KANBAN_SYNC=off\n");
		assert.deepEqual(readKanbanEnv(file), { KANBAN_SYNC: "off" });
	});

	it("lives under ~/.config/kanban", () => {
		assert.equal(kanbanEnvPath("/Users/me"), "/Users/me/.config/kanban/env");
	});
});
