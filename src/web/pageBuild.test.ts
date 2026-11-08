import assert from "node:assert/strict";
import { test } from "node:test";
import { sendWithToken } from "./comments.ts";
import { createReloader, holdReload } from "./pageBuild.ts";

const reloaderFor = (busy: () => boolean = () => false) => {
	const reloads: string[] = [];
	let reloadedFor: string | null = null;
	const reloader = createReloader({
		page: "page-1",
		busy,
		reloadedFor: () => reloadedFor,
		reload: (server) => {
			reloads.push(server);
			reloadedFor = server;
		},
	});
	return { reloader, reloads };
};

test("a mismatched build id reloads the page once", () => {
	const { reloader, reloads } = reloaderFor();
	assert.equal(reloader.noteServer("page-2"), true);
	assert.equal(reloader.tick(), true);
	// The hello on reconnect and every reply's header say the same again.
	reloader.noteServer("page-2");
	reloader.tick();
	reloader.noteServer("page-2");
	reloader.tick();
	assert.deepEqual(reloads, ["page-2"]);
});

test("a page reloaded for a build never reloads for it again", () => {
	const reloads: string[] = [];
	const reloader = createReloader({
		page: "page-1",
		busy: () => false,
		reloadedFor: () => "page-2",
		reload: (server) => reloads.push(server),
	});
	assert.equal(reloader.noteServer("page-2"), false);
	assert.equal(reloader.tick(), false);
	assert.deepEqual(reloads, []);
});

test("a matching or missing build id never reloads", () => {
	const { reloader, reloads } = reloaderFor();
	assert.equal(reloader.noteServer("page-1"), false);
	assert.equal(reloader.noteServer(null), false);
	assert.equal(reloader.noteServer(undefined), false);
	assert.equal(reloader.tick(), false);
	assert.deepEqual(reloads, []);
});

test("the reload waits while Approve is held and fires once it is let go", () => {
	let held = 0;
	const { reloader, reloads } = reloaderFor(() => held > 0);
	held += 1;
	reloader.noteServer("page-2");
	assert.equal(reloader.tick(), false);
	assert.equal(reloader.tick(), false);
	assert.deepEqual(reloads, []);
	held -= 1;
	assert.equal(reloader.tick(), true);
	assert.deepEqual(reloads, ["page-2"]);
});

test("holdReload releases once however often it is called", () => {
	const release = holdReload();
	release();
	release();
	const again = holdReload();
	again();
});

const reply = (status: number, body: unknown) =>
	new Response(body === undefined ? null : JSON.stringify(body), { status });

test("a press refused for a stale token refreshes it once and is sent again", async () => {
	const sent: (string | null)[] = [];
	let token = "old";
	let forgot = 0;
	const got = await sendWithToken<{ ok: true; text: string }>(
		"POST",
		async (t) => {
			sent.push(t);
			return t === "new"
				? reply(202, { ok: true, text: "Approved" })
				: reply(403, { ok: false, error: "reload it", code: "stale-page" });
		},
		async () => token,
		() => {
			forgot += 1;
			token = "new";
		},
	);
	assert.deepEqual(got, { ok: true, value: { ok: true, text: "Approved" } });
	assert.deepEqual(sent, ["old", "new"]);
	assert.equal(forgot, 1);
});

test("a press still refused after the refresh says so with a reload, and is not sent a third time", async () => {
	let sends = 0;
	const got = await sendWithToken(
		"POST",
		async () => {
			sends += 1;
			return reply(403, { ok: false, error: "reload it", code: "stale-page" });
		},
		async () => "token",
		() => {},
	);
	assert.equal(sends, 2);
	assert.equal(got.ok, false);
	assert.equal(!got.ok && got.reload, true);
});

test("a refusal for any other reason is not retried", async () => {
	let sends = 0;
	const got = await sendWithToken(
		"POST",
		async () => {
			sends += 1;
			return reply(409, { ok: false, error: "Already answered" });
		},
		async () => "token",
		() => {},
	);
	assert.equal(sends, 1);
	assert.deepEqual(got, { ok: false, error: "Already answered" });
});
