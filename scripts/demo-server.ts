import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { subagentCountsBySession } from "../src/shared/subagents.ts";
import type {
	Board,
	BoardFeed,
	ExitRequest,
	ExitResult,
	Layout,
	LayoutUpdate,
	Link,
	Message,
	NewSessionRequest,
	NodeRef,
	Session,
	Subagent,
	TranscriptEntry,
} from "../src/shared/types.ts";

const dist = fileURLToPath(new URL("../dist/", import.meta.url));
const port = Number(process.env.PORT ?? 7421);
const minute = 60_000;
const start = Date.now();

const contentTypes: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript",
	".css": "text/css",
	".map": "application/json",
	".svg": "image/svg+xml",
	".woff2": "font/woff2",
	".woff": "font/woff",
	".webmanifest": "application/manifest+json",
};

const s = (id: string): NodeRef => ({ kind: "session", id });
const a = (id: string): NodeRef => ({ kind: "subagent", id });

function session(
	partial: Partial<Session> & Pick<Session, "id" | "name" | "project">,
): Session {
	return {
		short: partial.id.slice(0, 8),
		pid: 40000 + partial.id.length,
		cwd: `/Users/me/dev/${partial.project}`,
		kind: "background",
		activity: "idle",
		doing: null,
		needs: null,
		goal: null,
		startedAt: start - 90 * minute,
		updatedAt: start - 2 * minute,
		attachable: true,
		cmux: false,
		artifacts: [],
		...partial,
	};
}

function subagent(
	partial: Partial<Subagent> & Pick<Subagent, "id" | "sessionId" | "type">,
): Subagent {
	return {
		parentAgentId: null,
		description: "",
		live: false,
		done: false,
		startedAt: start - 30 * minute,
		updatedAt: start - 5 * minute,
		...partial,
	};
}

const sessions: Session[] = [
	session({
		id: "a1f0c2d4e5",
		goal: "Expire stale auth sessions",
		name: "acme-api",
		project: "acme-api",
		activity: "working",
		doing: "Running npm test -- --filter auth",
		updatedAt: start - 20_000,
	}),
	session({
		id: "b2e1d3c4f6",
		goal: "Migrate the orders table to the new schema",
		name: "migrate orders table",
		project: "acme-api",
		activity: "needs-you",
		doing: "Waiting for approval",
		needs: "Approve running db:migrate against staging?",
		updatedAt: start - 3 * minute,
	}),
	session({
		id: "c3d2e4f5a7",
		goal: "Fix the auth token refresh race",
		name: "auth hotfix",
		project: "acme-api",
		activity: "done",
		doing: "Opened pull request #482",
		updatedAt: start - 26 * minute,
	}),
	session({
		id: "d4c3f5a6b8",
		goal: "Redesign the checkout summary",
		name: "acme-web",
		project: "acme-web",
		kind: "interactive",
		short: null,
		attachable: false,
		activity: "working",
		doing: "Editing src/checkout/Summary.tsx",
		updatedAt: start - 45_000,
	}),
	session({
		id: "e5b4a6c7d9",
		goal: "Fix accessibility violations across the web app",
		name: "a11y sweep",
		project: "acme-web",
		activity: "failed",
		doing: "axe found 14 violations; build failed",
		updatedAt: start - 12 * minute,
	}),
	session({
		id: "f6a5b7d8e0",
		goal: "Plan the staging network changes",
		artifacts: [
			{
				url: "https://claude.ai/artifact/demoStagingNetwork04",
				title: "Staging network plan",
				at: start - 3 * 60 * minute,
			},
		],
		name: "acme-infra",
		project: "acme-infra",
		activity: "stopped",
		doing: "Stopped after terraform plan",
		updatedAt: start - 3 * 60 * minute,
	}),
	session({
		id: "a7f6c8e9f1",
		name: "cost report",
		project: "acme-infra",
		activity: "idle",
		doing: null,
		updatedAt: start - 50 * minute,
		artifacts: [
			{
				url: "https://claude.ai/artifact/demoCostDashboard01",
				title: "Q3 cloud cost dashboard",
				at: start - 52 * minute,
			},
			{
				url: "https://claude.ai/artifact/demoCostBreakdown02",
				title: "Cost by service",
				at: start - 58 * minute,
			},
			{
				url: "https://claude.ai/artifact/demoCostSavings03",
				title: "Savings plan options",
				at: start - 64 * minute,
			},
		],
	}),
	session({
		id: "b8e7d9f0a2",
		goal: "Draft release notes for 2.4 from the changelog",
		name: "release notes",
		project: "acme-docs",
		kind: "interactive",
		short: null,
		attachable: false,
		activity: "idle",
		doing: "Read CHANGELOG.md",
		updatedAt: start - 8 * minute,
	}),
];

const subagents: Subagent[] = [
	subagent({
		id: "sa-explore",
		sessionId: "a1f0c2d4e5",
		type: "Explore",
		description: "Map the auth middleware",
		live: true,
		updatedAt: start - 30_000,
	}),
	subagent({
		id: "sa-tests",
		sessionId: "a1f0c2d4e5",
		type: "general-purpose",
		description: "Write session expiry tests",
		done: true,
	}),
	subagent({
		id: "sa-sql",
		sessionId: "b2e1d3c4f6",
		type: "Plan",
		description: "Draft the backfill in batches",
	}),
	subagent({
		id: "sa-review",
		sessionId: "d4c3f5a6b8",
		type: "code-reviewer",
		description: "Review checkout flow changes",
		live: true,
		updatedAt: start - 60_000,
	}),
];

const links: Link[] = [
	{ from: s("a1f0c2d4e5"), to: a("sa-explore"), kind: "subagent" },
	{ from: s("a1f0c2d4e5"), to: a("sa-tests"), kind: "subagent" },
	{ from: s("a1f0c2d4e5"), to: s("b2e1d3c4f6"), kind: "spawned" },
	{ from: s("a1f0c2d4e5"), to: s("c3d2e4f5a7"), kind: "forked" },
	{ from: s("b2e1d3c4f6"), to: a("sa-sql"), kind: "subagent" },
	{ from: s("d4c3f5a6b8"), to: a("sa-review"), kind: "subagent" },
	{ from: s("d4c3f5a6b8"), to: s("e5b4a6c7d9"), kind: "spawned" },
	{ from: s("f6a5b7d8e0"), to: s("a7f6c8e9f1"), kind: "forked" },
];

const messages: Message[] = [
	{
		id: "m1",
		from: s("a1f0c2d4e5"),
		to: s("d4c3f5a6b8"),
		at: start - 40 * minute,
		summary:
			"The session cookie is now SameSite=Lax; update the checkout fetches.",
	},
	{
		id: "m2",
		from: s("a1f0c2d4e5"),
		to: s("d4c3f5a6b8"),
		at: start - 18 * minute,
		summary: "New /v2/orders shape is live on staging.",
	},
	{
		id: "m3",
		from: s("d4c3f5a6b8"),
		to: s("a1f0c2d4e5"),
		at: start - 15 * minute,
		summary: "Thanks. Can you add the currency field to the order summary?",
	},
	{
		id: "m4",
		from: s("e5b4a6c7d9"),
		to: s("d4c3f5a6b8"),
		at: start - 12 * minute,
		summary:
			"Build failed on 14 axe violations, mostly missing labels in checkout.",
	},
	{
		id: "m5",
		from: s("b2e1d3c4f6"),
		to: s("f6a5b7d8e0"),
		at: start - 4 * minute,
		summary: "Need the staging RDS snapshot id before migrating.",
	},
	{
		id: "m6",
		from: s("a1f0c2d4e5"),
		to: s("d4c3f5a6b8"),
		at: start - 20_000,
		summary: "Currency field added to OrderSummary; tests are running.",
	},
];

if (process.env.DEMO_EMPTY) {
	sessions.length = 0;
	subagents.length = 0;
	links.length = 0;
	messages.length = 0;
}

const board: Board = {
	sessions,
	subagents,
	subagentCounts: subagentCountsBySession(subagents),
	links,
	messages,
	generatedAt: start,
};

const said = (
	minutesAgo: number,
	role: TranscriptEntry["role"],
	text: string,
): TranscriptEntry => ({ at: start - minutesAgo * minute, role, text });

const transcripts: Record<string, TranscriptEntry[]> = {
	a1f0c2d4e5: [
		said(
			9,
			"peer",
			"acme-web: Can you add the currency field to the order summary?",
		),
		said(8, "assistant", "I'll add the currency field and run the auth tests."),
		said(7, "tool", "Read: src/orders/summary.ts"),
		said(6, "tool", "Edit: src/orders/summary.ts"),
		said(5, "tool", "SendMessage"),
		said(
			4,
			"assistant",
			"Currency is in. Running the auth suite before I hand back.",
		),
		said(1, "tool", "Bash: npm test -- --filter auth"),
	],
	b2e1d3c4f6: [
		said(20, "user", "Backfill the orders table on staging, in batches."),
		said(12, "tool", "Write: migrations/0042_orders_currency.sql"),
		said(
			6,
			"assistant",
			"The backfill is ready. It runs in batches of 5,000 rows.",
		),
		said(3, "tool", "Bash: npm run db:migrate -- --env staging"),
	],
	c3d2e4f5a7: [
		said(40, "tool", "Edit: src/auth/middleware.ts"),
		said(30, "tool", "Bash: npm test"),
		said(28, "tool", "Bash: gh pr create --fill"),
		said(
			26,
			"assistant",
			"Opened #482: fix token refresh race in the auth middleware.\n\nThe refresh now holds a per-session lock, so two tabs can no longer both rotate the token.",
		),
	],
	d4c3f5a6b8: [
		said(16, "user", "Make the checkout summary show the currency."),
		said(15, "assistant", "I'll read the summary component first."),
		said(15, "tool", "Read: src/checkout/Summary.tsx"),
		said(
			2,
			"peer",
			"acme-api: Currency field added to OrderSummary; tests are running.",
		),
		said(1, "tool", "Edit: src/checkout/Summary.tsx"),
		said(
			1,
			"assistant",
			"Summary.tsx now renders the currency code next to the total.",
		),
	],
	e5b4a6c7d9: [
		said(14, "tool", "Bash: npx axe-cli http://localhost:5173/checkout"),
		said(
			12,
			"assistant",
			"14 violations: 9 missing form labels and 5 contrast failures, all in checkout.",
		),
		said(12, "tool", "SendMessage"),
		said(12, "assistant", "The accessibility gate failed; stopping here."),
	],
	f6a5b7d8e0: [
		said(185, "user", "Plan the NAT gateway change but do not apply it."),
		said(182, "tool", "Bash: terraform plan -out plan.tfplan"),
		said(
			180,
			"assistant",
			"Plan saved: 2 to add, 1 to change, 0 to destroy. Review it before I apply.",
		),
	],
	a7f6c8e9f1: [
		said(55, "user", "Why did last month's bill go up?"),
		said(52, "tool", "Bash: aws ce get-cost-and-usage --granularity MONTHLY"),
		said(
			50,
			"assistant",
			"Last month's spend is up 8%, mostly NAT gateway traffic from the image proxy.",
		),
	],
	b8e7d9f0a2: [
		said(10, "user", "Draft release notes for 2.4 from the changelog."),
		said(8, "tool", "Read: CHANGELOG.md"),
		said(
			8,
			"assistant",
			"Drafting now. 2.4 has three user-facing changes and one fix.",
		),
	],
};

const layout: Layout = {};

const notReady: Record<string, string> = {
	a1f0c2d4e5:
		"Still running the auth test suite; two specs have not finished yet.",
	b2e1d3c4f6: "Waiting for you to approve the staging migration.",
	d4c3f5a6b8: "There are uncommitted changes to the checkout labels.",
};

const readBody = async (req: AsyncIterable<Buffer>): Promise<unknown> => {
	let body = "";
	for await (const chunk of req) body += chunk;
	return JSON.parse(body || "{}");
};

const terminalText = (entries: TranscriptEntry[]): string =>
	entries
		.map(({ role, text }) => `${role === "user" ? ">" : "●"} ${text}`)
		.join("\r\n\r\n");

const server = createServer(async (req, res) => {
	const url = new URL(req.url ?? "/", "http://localhost");
	if (req.method === "POST" && url.pathname === "/api/sessions") {
		const request = (await readBody(req)) as Partial<NewSessionRequest>;
		const id = Math.random().toString(16).slice(2, 12);
		const cwd = request.cwd ?? "/Users/me/dev/acme-api";
		const created = session({
			id,
			name: request.name || (request.prompt ?? "new session").slice(0, 40),
			project: cwd.split("/").pop() ?? "acme-api",
			cwd,
			activity: "working",
			doing: "Starting",
			startedAt: Date.now(),
			updatedAt: Date.now(),
		});
		setTimeout(() => {
			sessions.push(created);
			if (request.at) {
				layout[`session:${id}`] = { x: request.at.x, y: request.at.y };
				broadcast({ type: "layout", layout });
			}
			broadcast({ type: "board", board: snapshot() });
		}, 1500);
		res.writeHead(201, { "content-type": "application/json" });
		res.end(JSON.stringify({ ok: true, short: created.short }));
		return;
	}
	if (req.method === "PUT" && url.pathname === "/api/layout") {
		const update = (await readBody(req)) as LayoutUpdate;
		layout[update.key] = update.placement;
		broadcast({ type: "layout", layout });
		res.writeHead(204).end();
		return;
	}
	const exit = url.pathname.match(/^\/api\/sessions\/([^/]+)\/exit$/);
	if (req.method === "POST" && exit) {
		const { force } = (await readBody(req)) as ExitRequest;
		const id = exit[1] ?? "";
		if (!sessions.some((item) => item.id === id)) {
			res.writeHead(404, { "content-type": "application/json" });
			res.end(JSON.stringify({ ok: false, error: "Not Found" }));
			return;
		}
		res.writeHead(202, { "content-type": "application/json" });
		res.end(JSON.stringify({ ok: true }));
		await new Promise((resolve) => setTimeout(resolve, 1500));
		const reason = notReady[id];
		const index = sessions.findIndex((item) => item.id === id);
		const result: ExitResult =
			index === -1
				? { ok: false, error: "This session is no longer on the board" }
				: reason && !force
					? { ok: true, exited: false, reason }
					: { ok: true, exited: true };
		if (result.ok && result.exited) {
			sessions.splice(index, 1);
			broadcast({ type: "board", board: snapshot() });
		}
		setTimeout(() => broadcast({ type: "exit", sessionId: id, result }), 400);
		return;
	}
	const transcript = url.pathname.match(
		/^\/api\/sessions\/([^/]+)\/transcript$/,
	);
	if (transcript) {
		const entries = transcripts[transcript[1] ?? ""] ?? [];
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify(entries));
		return;
	}
	const path = normalize(url.pathname === "/" ? "/index.html" : url.pathname);
	try {
		const file = await readFile(join(dist, path));
		res.writeHead(200, {
			"content-type": contentTypes[extname(path)] ?? "application/octet-stream",
		});
		res.end(file);
	} catch {
		res.writeHead(404).end("not found");
	}
});

const feed = new WebSocketServer({ noServer: true });
const attach = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
	const url = new URL(req.url ?? "/", "http://localhost");
	if (url.pathname === "/api/feed") {
		feed.handleUpgrade(req, socket, head, (ws) => feed.emit("connection", ws));
	} else if (url.pathname.startsWith("/api/attach/")) {
		attach.handleUpgrade(req, socket, head, (ws) =>
			attach.emit("connection", ws),
		);
	} else {
		socket.destroy();
	}
});

function snapshot(): Board {
	const live = new Set(sessions.map((item) => item.id));
	const shown = board.subagents.filter((item) => live.has(item.sessionId));
	const nodes = new Set([...live, ...shown.map((item) => item.id)]);
	const connects = (edge: { from: NodeRef; to: NodeRef }) =>
		nodes.has(edge.from.id) && nodes.has(edge.to.id);
	return {
		sessions: [...sessions],
		subagents: shown,
		subagentCounts: subagentCountsBySession(shown),
		links: board.links.filter(connects),
		messages: messages.filter(connects),
		generatedAt: Date.now(),
	};
}

function send(ws: { send(data: string): void }, frame: BoardFeed): void {
	ws.send(JSON.stringify(frame));
}

function broadcast(frame: BoardFeed): void {
	for (const client of feed.clients) send(client, frame);
}

feed.on("connection", (ws) => {
	send(ws, { type: "board", board: snapshot() });
	send(ws, { type: "layout", layout });
});

attach.on("connection", (ws) => {
	ws.send(
		Buffer.from(`${terminalText(transcripts.a1f0c2d4e5 ?? [])}\r\n\r\n> `),
	);
	ws.on("message", (data, binary) => {
		if (binary) return;
		const frame = JSON.parse(String(data)) as { t: string; d?: string };
		if (frame.t === "in" && frame.d)
			ws.send(Buffer.from(frame.d.replace(/\r/g, "\r\n")));
	});
});

const chatter = [
	"Staging snapshot is rds:acme-staging-2026-10-24.",
	"Checkout labels fixed; rerun the a11y sweep?",
	"Auth tests are green. Merging after review.",
	"Cost report: NAT traffic traced to the image proxy.",
];
let tick = 0;
const pairs: [NodeRef, NodeRef][] = [
	[s("f6a5b7d8e0"), s("b2e1d3c4f6")],
	[s("d4c3f5a6b8"), s("e5b4a6c7d9")],
	[s("a1f0c2d4e5"), s("d4c3f5a6b8")],
	[s("a7f6c8e9f1"), s("b8e7d9f0a2")],
];

if (!process.env.DEMO_STATIC && !process.env.DEMO_EMPTY) {
	setInterval(() => {
		const index = tick % chatter.length;
		const [from, to] = pairs[index] ??
			pairs[0] ?? [s("a1f0c2d4e5"), s("d4c3f5a6b8")];
		messages.push({
			id: `live-${tick}`,
			from,
			to,
			at: Date.now(),
			summary: chatter[index] ?? "",
		});
		const api = sessions[0];
		if (api) api.updatedAt = Date.now();
		tick += 1;
		broadcast({ type: "board", board: snapshot() });
	}, 15_000);
}

server.listen(port, "127.0.0.1", () => {
	console.log(`demo board on http://127.0.0.1:${port}`);
});
