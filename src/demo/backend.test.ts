import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { test } from "node:test";
import { summariesOfBoard } from "../server/boardTools.ts";
import type { ConversationServerFrame } from "../shared/conversation.ts";
import type { BoardFeed } from "../shared/types.ts";
import { type Backend, createBackend, type Peer } from "./backend.ts";
import { calm } from "./calm.ts";
import { headline } from "./headline.ts";
import { install } from "./shim.ts";

const web = new URL("../web/", import.meta.url);

const canonical = (path: string) =>
	path
		.slice(path.indexOf("/api/"))
		.replace(/\?.*$/, "")
		.replace(/\$\{[^}]*\}/g, ":param");

async function clientPaths(): Promise<string[]> {
	const files = (await readdir(web, { recursive: true })).filter(
		(file) => /\.tsx?$/.test(file) && !file.includes(".test."),
	);
	const paths = new Set<string>();
	for (const file of files) {
		const source = await readFile(new URL(file, web), "utf8");
		const helpers = new Map<string, string>();
		for (const [, name = "", path = ""] of source.matchAll(
			/const (\w+) = \([^)]*\) =>\s*`([^`\n]*\/api\/[^`\n]*)`/g,
		))
			helpers.set(name, path);
		for (const [, literal = ""] of source.matchAll(
			/`([^`\n]*\/api\/[^`\n]*)`/g,
		))
			paths.add(canonical(literal));
		for (const [, literal = ""] of source.matchAll(/"(\/api\/[^"\n]*)"/g))
			paths.add(canonical(literal));
		for (const [, name = "", suffix = ""] of source.matchAll(
			/`\$\{(\w+)\([^)\n]*\)\}([^`\n]*)`/g,
		)) {
			const base = helpers.get(name);
			if (base) paths.add(canonical(`${base}${suffix}`));
		}
	}
	paths.delete("");
	return [...paths].sort();
}

type Probe = (backend: Backend) => Promise<void>;

const sessionId = "a1f0c2d4e5";

const answers = async (
	backend: Backend,
	method: string,
	path: string,
	body: unknown = null,
	query = "",
): Promise<Response> => {
	const response = backend.fetch(
		method,
		path,
		new URLSearchParams(query),
		body,
	);
	assert.ok(
		response.status < 400,
		`${method} ${path} answered ${response.status}`,
	);
	return response;
};

const opens = async (backend: Backend, path: string): Promise<void> => {
	assert.ok(backend.socket(path), `no demo socket for ${path}`);
};

const region = async (backend: Backend): Promise<string> => {
	const created = await answers(backend, "POST", "/api/regions", {
		cwd: "/Users/me/dev/acme-api",
		x: 0,
		y: 0,
		w: 480,
		h: 336,
	});
	return ((await created.json()) as { id: string }).id;
};

const thread = async (backend: Backend): Promise<string> => {
	const created = await answers(backend, "POST", "/api/comments", {
		x: 10,
		y: 20,
		text: "What needs me?",
	});
	return ((await created.json()) as { id: string }).id;
};

const probes: Record<string, Probe> = {
	"/api/feed": (backend) => opens(backend, "/api/feed"),
	"/api/attach/:param": (backend) => opens(backend, "/api/attach/a1f0c2d4"),
	"/api/mirror/:param": (backend) => opens(backend, "/api/mirror/d4c3f5a6b8"),
	"/api/:param/:param/conversation:param": async (backend) => {
		await opens(backend, `/api/sessions/${sessionId}/conversation`);
		await opens(backend, "/api/subagents/sa-explore/conversation");
	},
	"/api/sessions": async (backend) => {
		await answers(backend, "POST", "/api/sessions", {
			cwd: "/Users/me/dev/acme-api",
			prompt: "Tidy the README",
		});
	},
	"/api/sessions/:param/exit": async (backend) => {
		await answers(backend, "POST", `/api/sessions/${sessionId}/exit`, {
			force: false,
		});
	},
	"/api/sessions/:param/report": async (backend) => {
		await answers(backend, "POST", `/api/sessions/${sessionId}/report`);
	},
	"/api/sessions/:param/files": async (backend) => {
		const response = await answers(
			backend,
			"GET",
			`/api/sessions/${sessionId}/files`,
			null,
			"q=auth",
		);
		const listing = (await response.json()) as { files: string[] };
		assert.ok(listing.files.length > 0);
	},
	"/api/sessions/:param/commands": async (backend) => {
		await answers(backend, "GET", `/api/sessions/${sessionId}/commands`);
	},
	"/api/accounts/default": async (backend) => {
		await answers(backend, "POST", "/api/accounts/default", { account: 2 });
	},
	"/api/cloud-blocker": async (backend) => {
		await answers(backend, "GET", "/api/cloud-blocker", null, "cwd=/Users/me");
	},
	"/api/remote-hosts": async (backend) => {
		await answers(backend, "GET", "/api/remote-hosts", null, "account=2");
	},
	"/api/folder-picker": async (backend) => {
		await answers(backend, "POST", "/api/folder-picker");
	},
	"/api/permissions/survey": async (backend) => {
		await answers(backend, "POST", "/api/permissions/survey");
	},
	"/api/permissions/grant": async (backend) => {
		await answers(backend, "POST", "/api/permissions/grant", [
			{ sessionId, rules: ["Bash(npm test)"] },
		]);
	},
	"/api/announce": async (backend) => {
		await answers(backend, "POST", "/api/announce", { text: "Pull main" });
	},
	"/api/layout": async (backend) => {
		await answers(backend, "PUT", "/api/layout", {
			key: `session:${sessionId}`,
			placement: { x: 24, y: 48 },
		});
	},
	"/api/annotations/:param": async (backend) => {
		await answers(backend, "PUT", "/api/annotations/n1", {
			kind: "note",
			text: "hi",
			color: "pink",
			x: 0,
			y: 0,
			w: 192,
			h: 144,
			z: 2,
		});
		await answers(backend, "DELETE", "/api/annotations/n1");
	},
	"/api/colours": async (backend) => {
		await answers(backend, "PUT", "/api/colours", {
			cwd: "/Users/me/dev/acme-api",
			colour: "teal",
		});
	},
	"/api/ignores": async (backend) => {
		await answers(backend, "PUT", "/api/ignores", {
			cwd: "/Users/me/dev/acme-api",
			until: Date.now() + 60_000,
		});
	},
	"/api/regions": async (backend) => {
		await region(backend);
	},
	"/api/regions/:param": async (backend) => {
		const id = await region(backend);
		await answers(backend, "PATCH", `/api/regions/${id}`, { name: "API" });
		await answers(backend, "DELETE", `/api/regions/${id}`);
	},
	"/api/regions/:param/report": async (backend) => {
		const id = await region(backend);
		await answers(backend, "POST", `/api/regions/${id}/report`);
	},
	"/api/comments": async (backend) => {
		await thread(backend);
	},
	"/api/comments/:param": async (backend) => {
		const id = await thread(backend);
		await answers(backend, "PATCH", `/api/comments/${id}`, { resolved: true });
		await answers(backend, "DELETE", `/api/comments/${id}`);
	},
	"/api/comments/:param/messages": async (backend) => {
		const id = await thread(backend);
		await answers(backend, "POST", `/api/comments/${id}/messages`, {
			text: "And then?",
		});
	},
	"/api/comments/:param/cancel": async (backend) => {
		const id = await thread(backend);
		await answers(backend, "POST", `/api/comments/${id}/cancel`);
	},
};

const listening = () => {
	const frames: unknown[] = [];
	const peer: Peer = {
		send: (data) => {
			if (typeof data === "string") frames.push(JSON.parse(data));
		},
		close() {},
	};
	return { frames, peer };
};

const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

test("every /api route the web client uses has a demo probe", async () => {
	assert.deepEqual(
		await clientPaths(),
		Object.keys(probes).sort(),
		"The web client's /api routes changed: handle the new route in src/demo/backend.ts and add a probe here",
	);
});

test("the demo backend answers every /api route the web client uses", async () => {
	for (const [route, probe] of Object.entries(probes)) {
		const backend = createBackend(calm);
		try {
			await probe(backend);
		} catch (error) {
			assert.fail(`${route}: ${error}`);
		} finally {
			backend.stop();
		}
	}
});

test("writes reach every feed socket as the real server's frames", async () => {
	const backend = createBackend(calm);
	const { frames, peer } = listening();
	backend.socket("/api/feed")?.(peer);
	await answers(backend, "PUT", "/api/colours", {
		cwd: "/Users/me/dev/acme-web",
		colour: "pink",
	});
	await answers(backend, "PUT", "/api/ignores", {
		cwd: "/Users/me/dev/acme-web",
		until: Date.now() + 60_000,
	});
	await region(backend);
	await answers(backend, "PUT", "/api/layout", {
		key: `session:${sessionId}`,
		placement: { x: 24, y: 48 },
	});
	backend.stop();
	const types = (frames as BoardFeed[]).map((frame) => frame.type);
	assert.deepEqual(types.slice(0, 8), [
		"layout",
		"annotations",
		"colours",
		"ignores",
		"regions",
		"comments",
		"digests",
		"board",
	]);
	assert.deepEqual(types.slice(8), ["colours", "ignores", "regions", "layout"]);
});

test("a top-bar button keeps one thread and refuses a rerun while it works", async () => {
	const backend = createBackend(calm);
	const tidy = { x: 0, y: 0, button: "tidy", text: "Tidy up" };
	const first = (await (
		await answers(backend, "POST", "/api/comments", tidy)
	).json()) as { id: string };
	assert.equal(
		backend.fetch("POST", "/api/comments", new URLSearchParams(), tidy).status,
		409,
	);
	await answers(backend, "POST", `/api/comments/${first.id}/cancel`);
	await answers(backend, "POST", "/api/comments", tidy);
	const { frames, peer } = listening();
	backend.socket("/api/feed")?.(peer);
	backend.stop();
	const comments = (frames as BoardFeed[]).find(
		(frame) => frame.type === "comments",
	);
	assert.deepEqual(
		comments?.comments.filter((thread) => thread.button === "tidy").length,
		1,
	);
});

test("the shim answers /api requests in memory and passes the rest through", async () => {
	const backend = createBackend(calm);
	const fetched: string[] = [];
	const realFetch = globalThis.fetch;
	const realSocket = globalThis.WebSocket;
	globalThis.fetch = async (input) => {
		fetched.push(String(input));
		return new Response("page");
	};
	try {
		install(backend, "https://example.test/kanban/demo/");
		const layout = await fetch("/api/layout", {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				key: `session:${sessionId}`,
				placement: { x: 0, y: 0 },
			}),
		});
		assert.equal(layout.status, 204);
		assert.equal((await fetch("api/unknown")).status, 404);
		assert.equal(await (await fetch("favicon.svg")).text(), "page");
		assert.deepEqual(fetched, ["favicon.svg"]);

		const socket = new WebSocket("wss://example.test/api/feed");
		const received: string[] = [];
		let opened = false;
		socket.onopen = () => {
			opened = true;
		};
		socket.addEventListener("message", (event) =>
			received.push((JSON.parse(event.data) as BoardFeed).type),
		);
		await settled();
		await settled();
		assert.ok(opened);
		assert.equal(socket.readyState, WebSocket.OPEN);
		assert.ok(received.includes("board"));
		socket.close();

		const refused = new WebSocket("wss://example.test/api/mirror/nobody");
		let closed = false;
		refused.onclose = () => {
			closed = true;
		};
		await settled();
		assert.ok(closed);
	} finally {
		globalThis.fetch = realFetch;
		globalThis.WebSocket = realSocket;
		backend.stop();
	}
});

for (const [name, scenario] of Object.entries({ calm, headline })) {
	test(`every ${name} session and subagent has a conversation`, async () => {
		const backend = createBackend(scenario);
		const feed = listening();
		backend.socket("/api/feed")?.(feed.peer);
		const board = (feed.frames as BoardFeed[]).find(
			(frame) => frame.type === "board",
		);
		assert.ok(board?.type === "board");
		const nodes = [
			...board.board.sessions.map((s) => `sessions/${s.id}`),
			...board.board.subagents.map((a) => `subagents/${a.id}`),
		];
		for (const node of nodes) {
			const { frames, peer } = listening();
			const open = backend.socket(`/api/${node}/conversation`);
			assert.ok(open, node);
			open(peer);
			const items = (frames as ConversationServerFrame[]).find(
				(frame) => frame.type === "items",
			);
			assert.ok(items?.type === "items" && items.items.length > 1, node);
		}
		const waiting = board.board.sessions.filter(
			(s) => s.activity === "needs-you",
		);
		assert.ok(waiting.length > 0);
		for (const session of waiting) {
			const { frames, peer } = listening();
			backend.socket(`/api/sessions/${session.id}/conversation`)?.(peer);
			const dialog = (frames as ConversationServerFrame[]).find(
				(frame) => frame.type === "dialog",
			);
			assert.ok(dialog?.type === "dialog" && dialog.dialog, session.name);
		}
		backend.stop();
	});
}

test("the headline scenario is big, covers every activity and never rolls dice", async () => {
	const random = Math.random;
	Math.random = () => {
		throw new Error("the headline scenario must be deterministic");
	};
	try {
		const world = headline.world(Date.now());
		const projects = new Set(world.sessions.map((s) => s.project));
		const activities = new Set(world.sessions.map((s) => s.activity));
		assert.ok(world.sessions.length >= 25 && world.sessions.length <= 35);
		assert.ok(projects.size >= 5 && projects.size <= 6);
		assert.deepEqual([...activities].sort(), [
			"done",
			"failed",
			"idle",
			"needs-you",
			"stopped",
			"working",
		]);
		const steps = headline.timeline.length;
		assert.ok(steps >= 40 && steps <= 80, `${steps} steps`);
		const end = Math.max(...headline.timeline.map((step) => step.at));
		assert.ok(end >= 30_000 && end <= 40_000, `${end} ms`);
		const backend = createBackend(headline);
		for (const step of headline.timeline) step.run(backend.stage);
		backend.stop();
	} finally {
		Math.random = random;
	}
});

test("the calm digests describe the frames and sessions the board shows", () => {
	const backend = createBackend(calm);
	const { frames, peer } = listening();
	backend.socket("/api/feed")?.(peer);
	backend.stop();
	const sent = frames as BoardFeed[];
	const board = sent.flatMap((f) => (f.type === "board" ? [f.board] : []))[0];
	const digests = sent.flatMap((f) =>
		f.type === "digests" ? [f.digests] : [],
	)[0];
	assert.ok(board && digests);
	const keys = summariesOfBoard(board, {
		layout: { current: () => ({}) },
		annotations: { current: () => ({}) },
		regions: { current: () => [] },
	} as never).map((summary) => summary.key);
	assert.deepEqual(Object.keys(digests.projects).sort(), [...keys].sort());
	const ids = new Set(board.sessions.map((session) => session.id));
	for (const id of Object.keys(digests.sessions)) assert.ok(ids.has(id), id);
});
