import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { MirrorServerFrame, Session } from "../shared/types.ts";
import type { AttachSocket } from "./attach.ts";
import type { AuditEvent } from "./audit.ts";
import type { Cmux, CmuxResult, CmuxSurface } from "./cmux.ts";
import { createMirrorHub, maxMirrorText, parseMirrorFrame } from "./mirror.ts";

const session: Session = {
	id: "11111111-2222-3333-4444-555555555555",
	short: null,
	pid: 202,
	name: "acme-api",
	cwd: "/Users/me/dev/acme-api",
	project: "acme-api",
	kind: "interactive",
	activity: "idle",
	doing: null,
	needs: null,
	startedAt: 0,
	updatedAt: 0,
	attachable: false,
	cmux: true,
};

const target: CmuxSurface = { workspace: "WS", surface: "SF" };

describe("parseMirrorFrame", () => {
	const parse = (frame: unknown) => parseMirrorFrame(JSON.stringify(frame));

	it("accepts text and allowlisted keys", () => {
		assert.deepEqual(parse({ type: "text", text: "hi", submit: true }), {
			type: "text",
			text: "hi",
			submit: true,
		});
		assert.deepEqual(parse({ type: "text", text: "", submit: true }), {
			type: "text",
			text: "",
			submit: true,
		});
		assert.deepEqual(parse({ type: "key", key: "Ctrl+C" }), {
			type: "key",
			key: "Ctrl+C",
		});
	});

	it("refuses other keys, oversized or empty text and junk", () => {
		assert.equal(parse({ type: "key", key: "Ctrl+D" }), null);
		assert.equal(parse({ type: "key", key: "ctrl+c" }), null);
		assert.equal(
			parse({
				type: "text",
				text: "x".repeat(maxMirrorText + 1),
				submit: true,
			}),
			null,
		);
		assert.equal(parse({ type: "text", text: "", submit: false }), null);
		assert.equal(parse({ type: "text", text: "hi" }), null);
		assert.equal(parseMirrorFrame("not json"), null);
		assert.equal(parseMirrorFrame("null"), null);
	});
});

type FakeSocket = AttachSocket & {
	frames: MirrorServerFrame[];
	closed: boolean;
	receive(frame: unknown): void;
	hangUp(): void;
};

const fakeSocket = (): FakeSocket => {
	const listeners: Record<string, ((data?: unknown) => void)[]> = {};
	const socket: FakeSocket = {
		readyState: 1,
		frames: [],
		closed: false,
		send(data) {
			socket.frames.push(JSON.parse(String(data)));
		},
		close() {
			socket.closed = true;
		},
		on(event: string, listener: (data?: unknown) => void) {
			listeners[event] = [...(listeners[event] ?? []), listener];
		},
		receive(frame) {
			for (const listener of listeners.message ?? []) {
				listener(JSON.stringify(frame));
			}
		},
		hangUp() {
			for (const listener of listeners.close ?? []) listener();
		},
	};
	return socket;
};

const settle = async (done: () => boolean) => {
	for (let tries = 0; tries < 400 && !done(); tries += 1) {
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
};

const harness = (opts: {
	screens?: string[];
	resolve?: () => CmuxResult<CmuxSurface>;
	refuse?: string;
	pollMs?: number;
}) => {
	const sent: string[] = [];
	const events: AuditEvent[] = [];
	let reads = 0;
	const screens = [...(opts.screens ?? ["one"])];
	const refused = (): CmuxResult<null> =>
		opts.refuse ? { ok: false, error: opts.refuse } : { ok: true, value: null };
	const cmux: Cmux = {
		surfaces: async () => ({ ok: true, value: new Map() }),
		readScreen: async () => {
			reads += 1;
			return {
				ok: true,
				value: (screens.length > 1 ? screens.shift() : screens[0]) ?? "",
			};
		},
		paste: async (at, text, submit) => {
			sent.push(`paste ${at.surface} ${text} ${submit}`);
			return refused();
		},
		sendKey: async (at, key) => {
			sent.push(`key ${at.surface} ${key}`);
			return refused();
		},
	};
	const hub = createMirrorHub({
		cmux,
		resolve: async () => opts.resolve?.() ?? { ok: true, value: target },
		audit: (event) => events.push(event),
		pollMs: opts.pollMs ?? 1,
	});
	return { hub, sent, events, reads: () => reads };
};

describe("createMirrorHub", () => {
	it("streams the screen only when it changes", async () => {
		const { hub } = harness({ screens: ["one", "one", "two", "two"] });
		const socket = fakeSocket();
		hub.open(socket, session, "me@example.com");
		await settle(() => socket.frames.length >= 2);
		socket.hangUp();
		assert.deepEqual(socket.frames, [
			{ type: "screen", text: "one" },
			{ type: "screen", text: "two" },
		]);
	});

	it("shares one poll between viewers of a session", async () => {
		const { hub, reads } = harness({ screens: ["one"], pollMs: 60_000 });
		const first = fakeSocket();
		hub.open(first, session, null);
		await settle(() => first.frames.length >= 1);
		const second = fakeSocket();
		hub.open(second, session, null);
		await new Promise((resolve) => setTimeout(resolve, 20));
		first.hangUp();
		second.hangUp();
		assert.equal(reads(), 1);
		assert.deepEqual(second.frames, [{ type: "screen", text: "one" }]);
	});

	it("stops polling once every viewer has left", async () => {
		const { hub, reads } = harness({ screens: ["one"] });
		const socket = fakeSocket();
		hub.open(socket, session, null);
		await settle(() => reads() >= 3);
		socket.hangUp();
		await new Promise((resolve) => setTimeout(resolve, 10));
		const after = reads();
		await new Promise((resolve) => setTimeout(resolve, 30));
		assert.equal(reads(), after);
	});

	it("types text and keys into the resolved surface and audits each", async () => {
		const { hub, sent, events } = harness({});
		const socket = fakeSocket();
		hub.open(socket, session, "me@example.com");
		socket.receive({ type: "text", text: "run the tests", submit: true });
		socket.receive({ type: "key", key: "Escape" });
		socket.receive({ type: "text", text: "", submit: true });
		socket.receive({ type: "key", key: "F13" });
		await settle(() => events.length >= 4);
		socket.hangUp();
		assert.deepEqual(sent, [
			"paste SF run the tests true",
			"key SF Escape",
			"key SF Enter",
		]);
		assert.deepEqual(events[0], {
			action: "mirror-open",
			sessionId: session.id,
			identity: "me@example.com",
		});
		assert.deepEqual(events[1], {
			action: "mirror-send",
			sessionId: session.id,
			surface: "SF",
			key: null,
			chars: 13,
			submit: true,
			identity: "me@example.com",
			result: "sent",
		});
		assert.ok(
			socket.frames.some(
				(frame) =>
					frame.type === "error" && frame.error === "Unsupported input",
			),
		);
	});

	it("passes a cmux refusal to the page", async () => {
		const { hub, events } = harness({ refuse: "cmux refused kanban" });
		const socket = fakeSocket();
		hub.open(socket, session, null);
		socket.receive({ type: "key", key: "Enter" });
		await settle(() => events.length >= 2);
		socket.hangUp();
		assert.ok(
			socket.frames.some(
				(frame) =>
					frame.type === "error" && frame.error === "cmux refused kanban",
			),
		);
		assert.equal(events.at(-1)?.action, "mirror-send");
	});

	it("ends without sending when the session is no longer that process", async () => {
		const { hub, sent } = harness({
			resolve: () => ({ ok: false, error: "gone" }),
		});
		const socket = fakeSocket();
		hub.open(socket, session, null);
		socket.receive({ type: "text", text: "hi", submit: true });
		await settle(() => socket.closed);
		assert.deepEqual(sent, []);
		assert.deepEqual(socket.frames[0], { type: "ended", reason: "gone" });
		assert.ok(socket.closed);
	});
});
