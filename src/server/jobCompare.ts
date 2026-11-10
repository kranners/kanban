// How the hub judges a shadow job's result against today's path for the same
// input: a picture by its size and a perceptual hash, a test run by whether it
// passed, anything else byte for byte. The verdict is only logged.
import { createHash } from "node:crypto";
import { inflateSync } from "node:zlib";
import type { JobShadow, ShadowVerdict } from "./jobQueue.ts";

const pngSignature = [137, 80, 78, 71, 13, 10, 26, 10];
const hashSide = 16;
/** Bits of the 256-bit hash two pictures may differ in and still read as the same. */
export const pngHashTolerance = 20;

export type Png = {
	width: number;
	height: number;
	/** Luminance 0-255 per pixel, row by row; null for a layout this reader doesn't decode. */
	luma: Uint8Array | null;
};

const channelsOf: Record<number, number> = { 0: 1, 2: 3, 4: 2, 6: 4 };

const paeth = (a: number, b: number, c: number) => {
	const p = a + b - c;
	const pa = Math.abs(p - a);
	const pb = Math.abs(p - b);
	const pc = Math.abs(p - c);
	return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
};

export const readPng = (bytes: Uint8Array): Png | null => {
	if (pngSignature.some((byte, at) => bytes[at] !== byte)) return null;
	const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	let at = 8;
	let width = 0;
	let height = 0;
	let depth = 0;
	let colour = -1;
	let interlace = 0;
	const data: Buffer[] = [];
	while (at + 8 <= view.length) {
		const length = view.readUInt32BE(at);
		const type = view.toString("latin1", at + 4, at + 8);
		const body = view.subarray(at + 8, at + 8 + length);
		if (type === "IHDR") {
			width = body.readUInt32BE(0);
			height = body.readUInt32BE(4);
			depth = body[8] ?? 0;
			colour = body[9] ?? -1;
			interlace = body[12] ?? 0;
		} else if (type === "IDAT") {
			data.push(body);
		} else if (type === "IEND") {
			break;
		}
		at += 12 + length;
	}
	if (width === 0 || height === 0) return null;
	const channels = channelsOf[colour];
	if (depth !== 8 || interlace !== 0 || channels === undefined) {
		return { width, height, luma: null };
	}
	const raw = inflateSync(Buffer.concat(data));
	const stride = width * channels;
	const luma = new Uint8Array(width * height);
	let previous = new Uint8Array(stride);
	for (let y = 0; y < height; y++) {
		const start = y * (stride + 1);
		const filter = raw[start];
		const line = new Uint8Array(raw.subarray(start + 1, start + 1 + stride));
		for (let x = 0; x < stride; x++) {
			const left = x >= channels ? (line[x - channels] ?? 0) : 0;
			const up = previous[x] ?? 0;
			const corner = x >= channels ? (previous[x - channels] ?? 0) : 0;
			const value = line[x] ?? 0;
			line[x] =
				(filter === 1
					? value + left
					: filter === 2
						? value + up
						: filter === 3
							? value + ((left + up) >> 1)
							: filter === 4
								? value + paeth(left, up, corner)
								: value) & 255;
		}
		for (let x = 0; x < width; x++) {
			const p = x * channels;
			const [r, g, b] =
				channels >= 3
					? [line[p] ?? 0, line[p + 1] ?? 0, line[p + 2] ?? 0]
					: [line[p] ?? 0, line[p] ?? 0, line[p] ?? 0];
			luma[y * width + x] = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
		}
		previous = line;
	}
	return { width, height, luma };
};

/** An average hash: each cell of a 16 by 16 grid lighter or darker than the mean. */
export const averageHash = (png: Png): boolean[] | null => {
	const { luma, width, height } = png;
	if (!luma) return null;
	const cells: number[] = [];
	for (let cy = 0; cy < hashSide; cy++) {
		for (let cx = 0; cx < hashSide; cx++) {
			const x0 = Math.floor((cx * width) / hashSide);
			const x1 = Math.max(x0 + 1, Math.floor(((cx + 1) * width) / hashSide));
			const y0 = Math.floor((cy * height) / hashSide);
			const y1 = Math.max(y0 + 1, Math.floor(((cy + 1) * height) / hashSide));
			let sum = 0;
			let n = 0;
			for (let y = y0; y < y1 && y < height; y++) {
				for (let x = x0; x < x1 && x < width; x++) {
					sum += luma[y * width + x] ?? 0;
					n++;
				}
			}
			cells.push(n === 0 ? 0 : sum / n);
		}
	}
	const mean = cells.reduce((a, b) => a + b, 0) / cells.length;
	return cells.map((cell) => cell > mean);
};

const comparePng = (
	output: Uint8Array,
	reference: Uint8Array | null,
): ShadowVerdict => {
	const got = readPng(output);
	if (!got) return { match: false, detail: "the runner's result is not a PNG" };
	if (!reference) {
		return {
			match: false,
			detail: `${got.width}x${got.height}, nothing to compare with`,
		};
	}
	const want = readPng(reference);
	if (!want) return { match: false, detail: "today's picture is not a PNG" };
	const size = `${got.width}x${got.height} against ${want.width}x${want.height}`;
	if (got.width !== want.width || got.height !== want.height) {
		return { match: false, detail: `size ${size}` };
	}
	const a = averageHash(got);
	const b = averageHash(want);
	if (!a || !b) return { match: true, detail: `size ${size}, hash not read` };
	const distance = a.filter((bit, at) => bit !== b[at]).length;
	return {
		match: distance <= pngHashTolerance,
		detail: `size ${size}, ${distance} of ${a.length} hash bits differ`,
	};
};

const testPassed = (bytes: Uint8Array): boolean | null => {
	try {
		const body = JSON.parse(Buffer.from(bytes).toString("utf8")) as unknown;
		const pass = (body as { pass?: unknown } | null)?.pass;
		return typeof pass === "boolean" ? pass : null;
	} catch {
		return null;
	}
};

const compareTest = (
	output: Uint8Array,
	reference: Uint8Array | null,
): ShadowVerdict => {
	const pass = testPassed(output);
	if (pass === null)
		return { match: false, detail: "the runner sent no pass or fail" };
	const want = reference ? testPassed(reference) : null;
	if (want === null) return { match: true, detail: pass ? "passed" : "failed" };
	return {
		match: pass === want,
		detail: `${pass ? "passed" : "failed"}, today's path ${want ? "passed" : "failed"}`,
	};
};

const digest = (bytes: Uint8Array) =>
	createHash("sha256").update(bytes).digest("hex").slice(0, 12);

export const compareShadow = (
	kind: JobShadow["kind"],
	output: Uint8Array,
	reference: Uint8Array | null,
): ShadowVerdict => {
	if (kind === "png") return comparePng(output, reference);
	if (kind === "test") return compareTest(output, reference);
	if (!reference)
		return {
			match: false,
			detail: `${digest(output)}, nothing to compare with`,
		};
	const same =
		Buffer.compare(Buffer.from(output), Buffer.from(reference)) === 0;
	return {
		match: same,
		detail: same
			? `same ${output.byteLength} bytes`
			: `${digest(output)} against ${digest(reference)}`,
	};
};
