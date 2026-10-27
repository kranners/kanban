import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { MirrorKey, Session } from "../shared/types.ts";
import type { AttachPty, AttachTarget } from "./attach.ts";
import type { Cmux, CmuxSurface } from "./cmux.ts";
import {
	attachColumns,
	attachRows,
	attachTty,
	bracketedPaste,
	cmuxTty,
	keySequence,
} from "./terminals.ts";

const fakePty = () => {
	const written: string[] = [];
	const spawned: [AttachTarget, number, number][] = [];
	let dataListener: (data: string) => void = () => {};
	let exitListener: (event: { exitCode: number }) => void = () => {};
	let killed = 0;
	const pty: AttachPty = {
		onData(listener) {
			dataListener = listener;
		},
		onExit(listener) {
			exitListener = listener;
		},
		write(data) {
			written.push(data);
		},
		resize() {},
		kill() {
			killed += 1;
		},
	};
	return {
		written,
		spawned,
		killed: () => killed,
		emit: (data: string) => dataListener(data),
		exit: () => exitListener({ exitCode: 0 }),
		factory: (target: AttachTarget, cols: number, rows: number) => {
			spawned.push([target, cols, rows]);
			setTimeout(
				() => dataListener("\x1b[2J\x1b[H❯ ready\r\n  ⏸ plan mode on"),
				1,
			);
			return pty;
		},
	};
};

describe("terminal keys", () => {
	it("maps keys to the bytes a terminal sends", () => {
		assert.deepEqual(
			keySequence(["Enter", "Escape", "Shift+Tab", "Up", "Down"]),
			["\r", "\x1b", "\x1b[Z", "\x1b[A", "\x1b[B"],
		);
		assert.equal(bracketedPaste("hi"), "\x1b[200~hi\x1b[201~");
	});
});

describe("attached terminal", () => {
	it("attaches lazily at a fixed size and renders the screen", async () => {
		const pty = fakePty();
		const tty = attachTty({
			spawnPty: pty.factory,
			short: "abcd1234",
			cwd: "/work/demo",
			settleMs: 4,
			readyMs: 500,
			keyGapMs: 0,
		});
		assert.equal(tty.isOpen(), false);
		assert.deepEqual(pty.spawned, []);
		const screen = await tty.screen();
		assert.equal(screen.ok && screen.value.split("\n")[0], "❯ ready");
		assert.equal(screen.ok && screen.value.split("\n").length, attachRows);
		assert.deepEqual(pty.spawned, [
			[{ short: "abcd1234", cwd: "/work/demo" }, attachColumns, attachRows],
		]);
		assert.equal(tty.isOpen(), true);
		await tty.keys(["Down", "Enter"] as MirrorKey[]);
		await tty.send("hello");
		assert.deepEqual(pty.written, [
			"\x1b[B",
			"\r",
			"\x1b[200~hello\x1b[201~",
			"\r",
		]);
		tty.close();
		assert.equal(pty.killed(), 1);
		assert.equal(tty.isOpen(), false);
	});

	it("reports a session it could not attach to", async () => {
		const pty = fakePty();
		const tty = attachTty({
			spawnPty: (target, cols, rows) => {
				const spawned = pty.factory(target, cols, rows);
				setTimeout(() => pty.exit(), 0);
				return spawned;
			},
			short: "abcd1234",
			cwd: "/work/demo",
			settleMs: 4,
			readyMs: 200,
		});
		const screen = await tty.screen();
		assert.equal(screen.ok, false);
	});
});

describe("cmux terminal", () => {
	it("reads, types and pastes through one resolved surface", async () => {
		const calls: string[] = [];
		const target: CmuxSurface = { workspace: "W", surface: "S" };
		const cmux: Cmux = {
			surfaces: async () => ({ ok: true, value: new Map() }),
			readScreen: async () => {
				calls.push("read");
				return { ok: true, value: "screen" };
			},
			paste: async (_target, text, submit, force) => {
				calls.push(`paste ${text} ${submit} ${force ?? false}`);
				return { ok: true, value: null };
			},
			sendKey: async (_target, key) => {
				calls.push(`key ${key}`);
				return { ok: true, value: null };
			},
		};
		let resolved = 0;
		const tty = cmuxTty({
			cmux,
			resolve: async () => {
				resolved += 1;
				return { ok: true, value: target };
			},
			session: {} as Session,
			keyGapMs: 0,
		});
		await tty.screen();
		await tty.keys(["Down", "Enter"]);
		await tty.paste("Teal");
		await tty.send("hello");
		assert.deepEqual(calls, [
			"read",
			"key Down",
			"key Enter",
			"paste Teal false true",
			"paste hello true false",
		]);
		assert.equal(resolved, 2);
	});
});
