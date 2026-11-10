import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { maxButlerQueue } from "../shared/types.ts";
import {
	createButlerInbox,
	loadCardReplies,
	maxSends,
	relayStaleMs,
} from "./butlerInbox.ts";
import { legacyThreadReplies } from "./butlerThreads.ts";
import { createCommentStore, parseComments } from "./comments.ts";

const setup = async () => {
	const dir = await mkdtemp(join(tmpdir(), "kanban-inbox-"));
	let clock = 1_000_000;
	let ids = 0;
	let relayChanges = 0;
	const store = createCommentStore({
		file: join(dir, "comments.json"),
		initial: [],
		onChange: () => {},
		onRemove: () => {},
		newId: () => `thread-${++ids}`,
		now: () => clock,
	});
	const inbox = createButlerInbox({
		store,
		contextAt: (point) => ({
			card: { id: "s1", kind: "session", name: `card at ${point.x}` },
		}),
		onRelay: () => {
			relayChanges += 1;
		},
		newId: () => `msg-${++ids}`,
		now: () => clock,
	});
	return {
		store,
		inbox,
		tick: (ms: number) => {
			clock += ms;
		},
		relayChanges: () => relayChanges,
	};
};

describe("Butler's inbox on the board", () => {
	it("keeps a message queued until spike takes it, then waits for the answer", async () => {
		const { inbox, store } = await setup();
		const thread = inbox.start({ x: 5, y: 6, text: "what needs me?" });
		assert.ok(!("error" in thread));
		assert.equal(thread.context?.card?.name, "card at 5");
		const taken = inbox.take();
		assert.equal(taken.length, 1);
		// Taking without acking leaves it queued, so a crash on spike loses nothing.
		assert.equal(inbox.take().length, 1);
		assert.equal(inbox.ack([taken[0]?.id ?? ""]), 1);
		assert.equal(inbox.take().length, 0);
		assert.equal(store.get(thread.id)?.running, true);
		inbox.reply(thread.id, taken[0]?.id ?? "", "Nothing needs you.", true);
		const answered = store.get(thread.id);
		assert.equal(answered?.running, false);
		assert.deepEqual(
			answered?.events.map((e) => e.kind),
			["user", "reply"],
		);
	});

	it("survives a restart with what is queued and what spike already has", async () => {
		const { inbox, store } = await setup();
		const thread = inbox.start({ x: 0, y: 0, text: "one" });
		assert.ok(!("error" in thread));
		inbox.send(thread.id, "two");
		inbox.ack([inbox.take()[0]?.id ?? ""]);
		const [loaded] = parseComments(JSON.parse(JSON.stringify(store.current())));
		assert.equal(loaded?.to, "butler");
		assert.equal(loaded?.queued?.length, 1);
		assert.equal(loaded?.waiting?.length, 1);
		assert.equal(loaded?.running, true);
		assert.equal(loaded?.context?.card?.id, "s1");
	});

	it("limits how many messages reach Butler", async () => {
		const { inbox, tick } = await setup();
		const first = inbox.start({ x: 0, y: 0, text: "go" });
		assert.ok(!("error" in first));
		for (let i = 1; i < maxSends; i++) {
			assert.deepEqual(inbox.send(first.id, `again ${i}`), { ok: true });
		}
		const refused = inbox.send(first.id, "too many");
		assert.ok("error" in refused && refused.status === 429);
		tick(11 * 60_000);
		inbox.ack(inbox.take().map((m) => m.id));
		assert.deepEqual(inbox.send(first.id, "later"), { ok: true });
	});

	it("says spike is unreachable once it stops polling", async () => {
		const { inbox, tick, relayChanges } = await setup();
		assert.equal(inbox.relay(), undefined);
		inbox.take();
		assert.equal(inbox.relay(), "up");
		tick(relayStaleMs - 1);
		inbox.check();
		assert.equal(inbox.relay(), "up");
		tick(2);
		inbox.check();
		assert.equal(inbox.relay(), "down");
		inbox.take();
		assert.equal(inbox.relay(), "up");
		assert.equal(relayChanges(), 3);
	});

	it("stops waiting without sending what was still queued", async () => {
		const { inbox, store } = await setup();
		const thread = inbox.start({ x: 0, y: 0, text: "never mind" });
		assert.ok(!("error" in thread));
		assert.equal(inbox.cancel(thread.id), true);
		assert.equal(inbox.take().length, 0);
		assert.equal(store.get(thread.id)?.events.at(-1)?.kind, "error");
	});

	it("never takes the retired board agent's threads", async () => {
		const dir = await mkdtemp(join(tmpdir(), "kanban-inbox-"));
		const [retired] = parseComments([
			{
				id: "old",
				x: 0,
				y: 0,
				createdAt: 1,
				updatedAt: 1,
				resolved: false,
				sessionId: "00000000-0000-4000-8000-000000000001",
				events: [{ kind: "user", at: 1, text: "tidy" }],
			},
		]);
		assert.ok(retired);
		const store = createCommentStore({
			file: join(dir, "comments.json"),
			initial: [retired],
			onChange: () => {},
			onRemove: () => {},
		});
		const inbox = createButlerInbox({
			store,
			contextAt: () => ({}),
			onRelay: () => {},
		});
		const sent = inbox.send("old", "hello");
		assert.ok("error" in sent && sent.status === 409);
		assert.equal(inbox.reply("old", "x", "hi", true), null);
		assert.equal(inbox.take().length, 0);
	});

	it("queues a thread card's reply with every other message, under one cap and one take", async () => {
		const { inbox, tick } = await setup();
		const started = inbox.start({ x: 0, y: 0, text: "from the popup" });
		assert.ok(!("error" in started));
		tick(1);
		const reply = inbox.queueReply({
			thread: "card-11111111",
			target: "11111111",
			text: "yes, send",
		});
		assert.ok(!("error" in reply));
		assert.equal(inbox.replyTarget(reply.id), "11111111");
		assert.deepEqual(
			inbox.take().map((m) => [m.thread, m.target, m.text]),
			[
				[started.id, undefined, "from the popup"],
				["card-11111111", "11111111", "yes, send"],
			],
		);
		assert.equal(inbox.ack([reply.id]), 1);
		assert.deepEqual(
			inbox.take().map((m) => m.text),
			["from the popup"],
		);
	});

	it("counts card replies and board threads against the same queue limit", async () => {
		const dir = await mkdtemp(join(tmpdir(), "kanban-inbox-cap-"));
		const store = createCommentStore({
			file: join(dir, "comments.json"),
			initial: [],
			onChange: () => {},
			onRemove: () => {},
		});
		const inbox = createButlerInbox({
			store,
			contextAt: () => ({}),
			onRelay: () => {},
			initialReplies: Array.from({ length: maxButlerQueue }, (_, i) => ({
				id: `r-${i}`,
				thread: "card-11111111",
				target: "11111111",
				at: i,
				text: `reply ${i}`,
			})),
		});
		const refused = inbox.start({ x: 0, y: 0, text: "one more" });
		assert.ok("error" in refused && refused.status === 429);
		const reply = inbox.queueReply({
			thread: "card-11111111",
			target: "11111111",
			text: "and another",
		});
		assert.ok("error" in reply && reply.status === 429);
	});

	it("keeps card replies across a restart, and takes in an older board's from its thread logs", async () => {
		const dir = await mkdtemp(join(tmpdir(), "kanban-inbox-replies-"));
		const file = join(dir, "butler-replies.json");
		const store = createCommentStore({
			file: join(dir, "comments.json"),
			initial: [],
			onChange: () => {},
			onRemove: () => {},
		});
		const legacy = legacyThreadReplies({
			"thread-22222222": {
				events: [],
				queued: [{ id: "old-1", at: 5, text: "queued before the update" }],
			},
			"not-a-card": { queued: [{ id: "x", at: 1, text: "ignored" }] },
		});
		assert.deepEqual(legacy, [
			{
				card: "thread-22222222",
				message: { id: "old-1", at: 5, text: "queued before the update" },
			},
		]);
		const first = createButlerInbox({
			store,
			contextAt: () => ({}),
			onRelay: () => {},
			repliesFile: file,
			initialReplies: [
				{
					id: "old-1",
					thread: "card-22222222",
					target: "22222222",
					at: 5,
					text: "queued before the update",
				},
			],
		});
		const added = first.queueReply({
			thread: "card-11111111",
			target: "11111111",
			text: "go ahead",
		});
		assert.ok(!("error" in added));
		await first.saved();
		const second = createButlerInbox({
			store,
			contextAt: () => ({}),
			onRelay: () => {},
			repliesFile: file,
			initialReplies: await loadCardReplies(file),
		});
		assert.deepEqual(
			second.take().map((m) => [m.target, m.text]),
			[
				["22222222", "queued before the update"],
				["11111111", "go ahead"],
			],
		);
	});
});
