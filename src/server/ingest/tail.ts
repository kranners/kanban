import { statSync } from "node:fs";
import { stat } from "node:fs/promises";
import type { TranscriptEntry } from "../../shared/types.ts";
import { parseJson } from "./json.ts";
import {
	createLineState,
	type LineState,
	readChunks,
	splitLines,
} from "./lines.ts";
import {
	applyRecord,
	createFacts,
	type ResolvePeer,
	type TranscriptFacts,
} from "./records.ts";

export type Tail = {
	path: string;
	offset: number;
	/** The partial line the last read ended in, and how many records were too large to read. */
	lines: LineState;
	mtimeMs: number;
	facts: TranscriptFacts;
};

/** Overrides of the record cap and read size, for tests. */
export type ReadLimits = { cap?: number; chunkBytes?: number };

/**
 * A transcript that failed partway through reading, holding the entries
 * read before it failed, so a reader can still show what it could.
 */
export class TranscriptUnreadable extends Error {
	readonly entries: TranscriptEntry[];
	constructor(message: string, entries: TranscriptEntry[]) {
		super(message);
		this.entries = entries;
	}
}

export function createTail(path: string): Tail {
	return {
		path,
		offset: 0,
		lines: createLineState(),
		mtimeMs: 0,
		facts: createFacts(),
	};
}

export function advanceTail(
	tail: Tail,
	resolve: ResolvePeer,
	limits: ReadLimits = {},
): boolean {
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
	readChunks(
		tail.path,
		tail.offset,
		size,
		(chunk) => {
			consume(tail, chunk, resolve, limits.cap);
			tail.offset += chunk.length;
		},
		limits.chunkBytes,
	);
	return true;
}

export async function readFacts(
	path: string,
	resolve: ResolvePeer,
	limits: ReadLimits = {},
): Promise<TranscriptFacts> {
	const tail = createTail(path);
	const { size } = await stat(path);
	try {
		readChunks(
			path,
			0,
			size,
			(chunk) => consume(tail, chunk, resolve, limits.cap),
			limits.chunkBytes,
		);
	} catch (error) {
		throw new TranscriptUnreadable(
			(error as Error).message,
			tail.facts.entries,
		);
	}
	return tail.facts;
}

function consume(
	tail: Tail,
	chunk: Buffer,
	resolve: ResolvePeer,
	cap?: number,
) {
	splitLines(
		tail.lines,
		chunk,
		(line) => applyRecord(tail.facts, parseJson(line), resolve),
		cap,
	);
}
