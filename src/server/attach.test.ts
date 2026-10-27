import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";
import {
	type AttachPty,
	createAttachHub,
	escapeGuard,
	isValidShort,
	parseClientFrame,
	parseSize,
} from "./attach.ts";
import type { AuditEvent } from "./audit.ts";

class FakePty implements AttachPty {
	written: string[] = [];
	resized: [number, number][] = [];
	killed: (string | undefined)[] = [];
	private data = new EventEmitter();
	private exit = new EventEmitter();
	readonly size: [number, number];
	constructor(size: [number, number]) {
		this.size = size;
	}
	onData(listener: (data: string) => void) {
		this.data.on("data", listener);
	}
	onExit(listener: (event: { exitCode: number }) => void) {
		this.exit.on("exit", listener);
	}
	write(data: string) {
		this.written.push(data);
	}
	resize(cols: number, rows: number) {
		this.resized.push([cols, rows]);
	}
	kill(signal?: string) {
		this.killed.push(signal);
	}
	emitData(data: string) {
		this.data.emit("data", data);
	}
	emitExit(exitCode: number) {
		this.exit.emit("exit", { exitCode });
	}
}

class FakeSocket extends EventEmitter {
	readyState = 1;
	sent: (string | Buffer)[] = [];
	closed: [number | undefined, string | undefined] | null = null;
	send(data: string | Buffer) {
		this.sent.push(data);
	}
	close(code?: number, reason?: string) {
		this.closed = [code, reason];
		this.readyState = 3;
		this.emit("close");
	}
	texts() {
		return this.sent.filter((frame) => typeof frame === "string");
	}
}

const setup = () => {
	const ptys: FakePty[] = [];
	const events: AuditEvent[] = [];
	const hub = createAttachHub(
		(_target, cols, rows) => {
			const fake = new FakePty([cols, rows]);
			ptys.push(fake);
			return fake;
		},
		(event) => events.push(event),
	);
	return { hub, ptys, events };
};

const size = { cols: 100, rows: 30 };
const target = (short: string) => ({ short, cwd: "/Users/me/dev/acme-api" });

describe("createAttachHub", () => {
	it("spawns at the requested size and pipes data both ways", () => {
		const { hub, ptys } = setup();
		const socket = new FakeSocket();
		hub.open(socket, target("abcd1234"), size, null);
		const [terminal] = ptys;
		assert.ok(terminal);
		assert.deepEqual(terminal.size, [100, 30]);
		terminal.emitData("hello");
		assert.deepEqual(socket.sent, [Buffer.from("hello")]);
		socket.emit("message", Buffer.from(JSON.stringify({ t: "in", d: "hi\r" })));
		socket.emit(
			"message",
			Buffer.from(JSON.stringify({ t: "resize", cols: 80, rows: 24 })),
		);
		socket.emit("message", Buffer.from("garbage"));
		assert.deepEqual(terminal.written, ["hi\r"]);
		assert.deepEqual(terminal.resized, [[80, 24]]);
	});

	it("takes over: the old socket hears taken-over and its pty is killed", () => {
		const { hub, ptys, events } = setup();
		const first = new FakeSocket();
		const second = new FakeSocket();
		hub.open(first, target("abcd1234"), size, "me@example.com");
		hub.open(second, target("abcd1234"), size, "me@example.com");
		const [oldPty, newPty] = ptys;
		assert.ok(oldPty && newPty);
		assert.deepEqual(first.texts(), [JSON.stringify({ t: "taken-over" })]);
		assert.equal(first.closed?.[0], 4000);
		assert.deepEqual(oldPty.killed, ["SIGHUP"]);
		assert.deepEqual(newPty.killed, []);
		assert.deepEqual(hub.attached(), ["abcd1234"]);
		oldPty.emitData("late");
		oldPty.emitExit(129);
		assert.equal(second.sent.length, 0);
		assert.deepEqual(
			events.map((event) => [
				event.action,
				"reason" in event ? event.reason : null,
			]),
			[
				["attach-open", null],
				["attach-close", "taken-over"],
				["attach-open", null],
			],
		);
	});

	it("keeps a readable screen of each attach and announces opens and closes", async () => {
		const changes: string[] = [];
		const ptys: FakePty[] = [];
		const hub = createAttachHub(
			(_target, cols, rows) => {
				const fake = new FakePty([cols, rows]);
				ptys.push(fake);
				return fake;
			},
			() => {},
			(short) => changes.push(short),
		);
		const socket = new FakeSocket();
		hub.open(socket, target("abcd1234"), size, null);
		assert.deepEqual(changes, ["abcd1234"]);
		ptys[0]?.emitData("❯ ready");
		const screen = hub.screen("abcd1234");
		assert.ok(screen);
		await new Promise<void>((resolve) => screen.terminal.write("", resolve));
		assert.equal(
			screen.terminal.buffer.active.getLine(0)?.translateToString(true),
			"❯ ready",
		);
		assert.equal(screen.terminal.cols, 100);
		socket.emit(
			"message",
			Buffer.from(JSON.stringify({ t: "resize", cols: 80, rows: 24 })),
		);
		assert.equal(screen.terminal.cols, 80);
		socket.close();
		assert.equal(hub.screen("abcd1234"), null);
		assert.deepEqual(changes, ["abcd1234", "abcd1234"]);
	});

	it("keeps attaches to different sessions apart", () => {
		const { hub, ptys } = setup();
		hub.open(new FakeSocket(), target("abcd1234"), size, null);
		hub.open(new FakeSocket(), target("1234abcd"), size, null);
		assert.deepEqual(
			ptys.map((terminal) => terminal.killed),
			[[], []],
		);
		assert.deepEqual(hub.attached().sort(), ["1234abcd", "abcd1234"]);
	});

	it("sends exited with the code and closes when the pty exits", () => {
		const { hub, ptys } = setup();
		const socket = new FakeSocket();
		hub.open(socket, target("abcd1234"), size, null);
		ptys[0]?.emitExit(0);
		assert.deepEqual(socket.texts(), [
			JSON.stringify({ t: "exited", code: 0 }),
		]);
		assert.equal(socket.closed?.[0], 1000);
		assert.deepEqual(ptys[0]?.killed, []);
		assert.deepEqual(hub.attached(), []);
	});

	it("hangs up the pty when the socket closes", () => {
		const { hub, ptys, events } = setup();
		const socket = new FakeSocket();
		hub.open(socket, target("abcd1234"), size, null);
		socket.close();
		assert.deepEqual(ptys[0]?.killed, ["SIGHUP"]);
		assert.deepEqual(hub.attached(), []);
		assert.equal(events.at(-1)?.action, "attach-close");
	});

	it("returns from the agent view by sending Enter", () => {
		const { hub, ptys } = setup();
		hub.open(new FakeSocket(), target("abcd1234"), size, null);
		ptys[0]?.emitData(
			"\x1b]0;claude agents\x07\x1b[1mDescribe\x1b[2Ca task for a new\x1b[0m session\r\n\x1b[38;2;1;2;3menter to return · space to reply",
		);
		assert.deepEqual(ptys[0]?.written, ["\r"]);
	});

	it("cancels the workspace trust dialog with Escape", () => {
		const { hub, ptys } = setup();
		hub.open(new FakeSocket(), target("abcd1234"), size, null);
		ptys[0]?.emitData(
			"\x1b]0;claude agents\x07Accessing workspace:\r\n /Users/me\r\n\x1b[7m❯ No, exit\x1b[0m\r\n   Yes, I trust this folder",
		);
		assert.deepEqual(ptys[0]?.written, ["\x1b"]);
	});
});

describe("escapeGuard", () => {
	const agentViewTitle = "\x1b]0;claude agents\x07";
	const agentViewFooter = "describe a task for a new session enter to return";

	it("needs every marker and debounces for a second", () => {
		let clock = 0;
		let enters = 0;
		const guard = escapeGuard(
			(key) => {
				assert.equal(key, "\r");
				enters++;
			},
			() => clock,
		);
		guard(`${agentViewTitle}describe a task for a new session`);
		assert.equal(enters, 0);
		guard(" enter to return");
		assert.equal(enters, 1);
		clock = 1600;
		guard(agentViewFooter);
		assert.equal(enters, 2);
	});

	it("keeps a debounced screen and sends once the second has passed", () => {
		let clock = 0;
		let enters = 0;
		const guard = escapeGuard(
			() => enters++,
			() => clock,
		);
		guard(`${agentViewTitle}${agentViewFooter}`);
		guard("\x1b]0;session\x07");
		clock = 500;
		guard(`${agentViewTitle}${agentViewFooter}`);
		assert.equal(enters, 1);
		clock = 1200;
		guard("✻");
		assert.equal(enters, 2);
	});

	it("ignores the markers outside the agent view", () => {
		let keys = 0;
		const guard = escapeGuard(() => keys++);
		guard(agentViewFooter);
		guard("Accessing workspace: /x Yes, I trust this folder");
		guard(`${agentViewTitle}\x1b]0;session\x07${agentViewFooter}`);
		assert.equal(keys, 0);
	});

	it("starts a fresh screen on entering the agent view", () => {
		let enters = 0;
		const guard = escapeGuard(() => enters++);
		guard("describe a task for a new session");
		guard(`${agentViewTitle}enter to return`);
		assert.equal(enters, 0);
	});

	it("forgets output older than the rolling tail", () => {
		let enters = 0;
		const guard = escapeGuard(() => enters++);
		guard(`${agentViewTitle}describe a task for a new session`);
		guard("x".repeat(5000));
		guard("enter to return");
		assert.equal(enters, 0);
	});
});

describe("parsing", () => {
	it("validates shorts", () => {
		assert.ok(isValidShort("abcd1234"));
		assert.ok(!isValidShort("ABCD1234"));
		assert.ok(!isValidShort("abcd123"));
		assert.ok(!isValidShort("../etc/x"));
	});

	it("parses sizes with fallbacks and limits", () => {
		assert.deepEqual(parseSize("90", "30"), { cols: 90, rows: 30 });
		assert.deepEqual(parseSize(null, "abc"), { cols: 120, rows: 40 });
		assert.deepEqual(parseSize("9000", "1"), { cols: 500, rows: 40 });
	});

	it("parses client frames strictly", () => {
		assert.deepEqual(parseClientFrame('{"t":"in","d":"x"}'), {
			t: "in",
			d: "x",
		});
		assert.deepEqual(parseClientFrame('{"t":"resize","cols":80,"rows":24}'), {
			t: "resize",
			cols: 80,
			rows: 24,
		});
		assert.equal(parseClientFrame('{"t":"resize","cols":0,"rows":24}'), null);
		assert.equal(parseClientFrame('{"t":"in","d":5}'), null);
		assert.equal(parseClientFrame("null"), null);
		assert.equal(parseClientFrame("{"), null);
	});
});
