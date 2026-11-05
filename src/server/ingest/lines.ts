import { closeSync, openSync, readSync } from "node:fs";

/**
 * A JSONL reader's state between reads: the partial line the last read
 * ended in, and whether it is inside a record too large to keep. One
 * record over the cap is skipped rather than decoded, since a transcript
 * holding a huge tool result once crashed the board decoding it whole.
 */
export type LineState = {
	leftover: Buffer;
	skipping: boolean;
	skipped: number;
};

/** The longest single record decoded; anything longer is skipped and counted. */
export const maxRecordBytes = 64 * 1024 * 1024;

/** How much of a file one read takes at a time. */
export const readChunkBytes = 32 * 1024 * 1024;

const newline = 0x0a;

export const createLineState = (): LineState => ({
	leftover: Buffer.alloc(0),
	skipping: false,
	skipped: 0,
});

/**
 * Feeds `chunk` through `state`, calling `onLine` with each complete,
 * non-blank line decoded on its own; a line longer than `cap` bytes is
 * counted in `state.skipped` and never decoded, while the lines around
 * it still are.
 */
export function splitLines(
	state: LineState,
	chunk: Buffer,
	onLine: (line: string) => void,
	cap = maxRecordBytes,
): void {
	let start = 0;
	for (;;) {
		const end = chunk.indexOf(newline, start);
		if (end === -1) break;
		const piece = chunk.subarray(start, end);
		start = end + 1;
		if (state.skipping) {
			state.skipping = false;
			continue;
		}
		const length = state.leftover.length + piece.length;
		if (length > cap) {
			state.skipped += 1;
			state.leftover = Buffer.alloc(0);
			continue;
		}
		const line =
			state.leftover.length > 0
				? Buffer.concat([state.leftover, piece], length)
				: piece;
		state.leftover = Buffer.alloc(0);
		const text = line.toString("utf8");
		if (text.trim() !== "") onLine(text);
	}
	if (state.skipping || start >= chunk.length) return;
	const rest = chunk.subarray(start);
	if (state.leftover.length + rest.length > cap) {
		state.skipping = true;
		state.skipped += 1;
		state.leftover = Buffer.alloc(0);
		return;
	}
	state.leftover = Buffer.concat([state.leftover, rest]);
}

/**
 * Reads `path` from `offset` up to `size` in chunks of at most
 * `chunkBytes`, handing each to `onChunk`, so a transcript of any size
 * never needs one buffer the size of the file. Returns the bytes read.
 */
export function readChunks(
	path: string,
	offset: number,
	size: number,
	onChunk: (chunk: Buffer) => void,
	chunkBytes = readChunkBytes,
): number {
	if (size <= offset) return 0;
	const buffer = Buffer.alloc(Math.min(chunkBytes, size - offset));
	const fd = openSync(path, "r");
	let total = 0;
	try {
		while (offset + total < size) {
			const want = Math.min(buffer.length, size - offset - total);
			const read = readSync(fd, buffer, 0, want, offset + total);
			if (read === 0) break;
			total += read;
			onChunk(buffer.subarray(0, read));
		}
	} finally {
		closeSync(fd);
	}
	return total;
}
