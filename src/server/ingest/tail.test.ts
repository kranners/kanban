import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { advanceTail, createTail, readFacts } from "./tail.ts";

const dir = mkdtempSync(join(tmpdir(), "kanban-tail-"));
after(() => rmSync(dir, { recursive: true, force: true }));
const resolve = () => null;

const line = (text: string) =>
	`${JSON.stringify({ type: "user", timestamp: "2026-10-24T10:00:00Z", message: { content: text } })}\n`;

test("reads appended bytes only and buffers a partial trailing line", () => {
	const path = join(dir, "a.jsonl");
	writeFileSync(path, line("one"));
	const tail = createTail(path);
	assert.equal(advanceTail(tail, resolve), true);
	assert.equal(advanceTail(tail, resolve), false);

	const second = line("twö");
	const bytes = Buffer.from(second);
	appendFileSync(path, bytes.subarray(0, 30));
	advanceTail(tail, resolve);
	assert.deepEqual(
		tail.facts.entries.map((entry) => entry.text),
		["one"],
	);
	appendFileSync(path, bytes.subarray(30));
	advanceTail(tail, resolve);
	assert.deepEqual(
		tail.facts.entries.map((entry) => entry.text),
		["one", "twö"],
	);
});

test("starts over when the file shrinks", () => {
	const path = join(dir, "b.jsonl");
	writeFileSync(path, line("old") + line("older"));
	const tail = createTail(path);
	advanceTail(tail, resolve);
	writeFileSync(path, line("new"));
	advanceTail(tail, resolve);
	assert.deepEqual(
		tail.facts.entries.map((entry) => entry.text),
		["new"],
	);
});

test("survives a missing file and malformed lines", async () => {
	const tail = createTail(join(dir, "missing.jsonl"));
	assert.equal(advanceTail(tail, resolve), false);
	const path = join(dir, "c.jsonl");
	writeFileSync(path, `not json\n${line("ok")}`);
	const facts = await readFacts(path, resolve);
	assert.deepEqual(
		facts.entries.map((entry) => entry.text),
		["ok"],
	);
});

test("skips a record over the cap and reads the rest in small chunks", async () => {
	const path = join(dir, "d.jsonl");
	writeFileSync(path, line("before") + line("x".repeat(400)) + line("after"));
	const limits = { cap: 200, chunkBytes: 17 };
	const tail = createTail(path);
	assert.equal(advanceTail(tail, resolve, limits), true);
	assert.deepEqual(
		tail.facts.entries.map((entry) => entry.text),
		["before", "after"],
	);
	assert.equal(tail.lines.skipped, 1);
	appendFileSync(path, line("later"));
	advanceTail(tail, resolve, limits);
	assert.deepEqual(
		tail.facts.entries.map((entry) => entry.text),
		["before", "after", "later"],
	);
	const facts = await readFacts(path, resolve, limits);
	assert.deepEqual(
		facts.entries.map((entry) => entry.text),
		["before", "after", "later"],
	);
});
