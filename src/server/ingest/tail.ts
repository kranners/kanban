import { closeSync, openSync, readSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { parseJson } from "./json.ts";
import {
	applyRecord,
	createFacts,
	type ResolvePeer,
	type TranscriptFacts,
} from "./records.ts";

export type Tail = {
	path: string;
	offset: number;
	leftover: Buffer;
	mtimeMs: number;
	facts: TranscriptFacts;
};

const newline = 0x0a;

export function createTail(path: string): Tail {
	return {
		path,
		offset: 0,
		leftover: Buffer.alloc(0),
		mtimeMs: 0,
		facts: createFacts(),
	};
}

export function advanceTail(tail: Tail, resolve: ResolvePeer): boolean {
	let size: number;
	try {
		const stat = statSync(tail.path);
		size = stat.size;
		tail.mtimeMs = stat.mtimeMs;
	} catch {
		return false;
	}
	if (size < tail.offset) Object.assign(tail, createTail(tail.path));
	if (size === tail.offset) return false;
	const chunk = Buffer.alloc(size - tail.offset);
	const fd = openSync(tail.path, "r");
	let read: number;
	try {
		read = readSync(fd, chunk, 0, chunk.length, tail.offset);
	} finally {
		closeSync(fd);
	}
	tail.offset += read;
	consume(tail, chunk.subarray(0, read), resolve);
	return true;
}

export async function readFacts(
	path: string,
	resolve: ResolvePeer,
): Promise<TranscriptFacts> {
	const tail = createTail(path);
	consume(tail, await readFile(path), resolve);
	return tail.facts;
}

function consume(tail: Tail, chunk: Buffer, resolve: ResolvePeer) {
	const data =
		tail.leftover.length > 0 ? Buffer.concat([tail.leftover, chunk]) : chunk;
	const end = data.lastIndexOf(newline);
	if (end === -1) {
		tail.leftover = Buffer.from(data);
		return;
	}
	tail.leftover = Buffer.from(data.subarray(end + 1));
	for (const line of data.toString("utf8", 0, end).split("\n")) {
		if (line.trim() !== "") applyRecord(tail.facts, parseJson(line), resolve);
	}
}
