import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { createLineState, readChunks, splitLines } from "./lines.ts";

const dir = mkdtempSync(join(tmpdir(), "kanban-lines-"));
after(() => rmSync(dir, { recursive: true, force: true }));

const feed = (chunks: string[], cap?: number) => {
	const state = createLineState();
	const lines: string[] = [];
	for (const chunk of chunks) {
		splitLines(state, Buffer.from(chunk), (line) => lines.push(line), cap);
	}
	return { lines, state };
};

describe("splitLines", () => {
	it("decodes each line on its own, across chunk boundaries", () => {
		const bytes = Buffer.from("one\ntwö\n\nthree\npart");
		const state = createLineState();
		const lines: string[] = [];
		for (let at = 0; at < bytes.length; at += 3) {
			splitLines(state, bytes.subarray(at, at + 3), (line) => lines.push(line));
		}
		assert.deepEqual(lines, ["one", "twö", "three"]);
		assert.equal(state.leftover.toString(), "part");
	});

	it("skips a line over the cap while the lines around it parse", () => {
		const { lines, state } = feed([`a\n${"x".repeat(50)}\nb\n`], 10);
		assert.deepEqual(lines, ["a", "b"]);
		assert.equal(state.skipped, 1);
	});

	it("skips a line that grows past the cap over several chunks, once", () => {
		const { lines, state } = feed(
			["a\nxxxx", "xxxx", "xxxx", "xxxx\nb", "\n"],
			10,
		);
		assert.deepEqual(lines, ["a", "b"]);
		assert.equal(state.skipped, 1);
		assert.equal(state.skipping, false);
	});

	it("keeps a line exactly at the cap", () => {
		const { lines, state } = feed(["12345", "67890\n"], 10);
		assert.deepEqual(lines, ["1234567890"]);
		assert.equal(state.skipped, 0);
	});
});

describe("readChunks", () => {
	it("reads a file from an offset in bounded chunks", () => {
		const path = join(dir, "a.txt");
		writeFileSync(path, "0123456789abcdef");
		const chunks: string[] = [];
		const read = readChunks(
			path,
			2,
			16,
			(chunk) => chunks.push(chunk.toString()),
			5,
		);
		assert.equal(read, 14);
		assert.deepEqual(chunks, ["23456", "789ab", "cdef"]);
		assert.equal(
			readChunks(path, 16, 16, () => assert.fail()),
			0,
		);
	});
});
