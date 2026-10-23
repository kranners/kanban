import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { renderPreview } from "../src/server/preview.ts";
import type {
	Board,
	BoardFeed,
	Link,
	Message,
	NodeRef,
	Preview,
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
		startedAt: start - 90 * minute,
		updatedAt: start - 2 * minute,
		attachable: true,
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
		startedAt: start - 30 * minute,
		updatedAt: start - 5 * minute,
		...partial,
	};
}

const sessions: Session[] = [
	session({
		id: "a1f0c2d4e5",
		name: "acme-api",
		project: "acme-api",
		activity: "working",
		doing: "Running npm test -- --filter auth",
		updatedAt: start - 20_000,
	}),
	session({
		id: "b2e1d3c4f6",
		name: "migrate orders table",
		project: "acme-api",
		activity: "needs-you",
		doing: "Waiting for approval",
		needs: "Approve running db:migrate against staging?",
		updatedAt: start - 3 * minute,
	}),
	session({
		id: "c3d2e4f5a7",
		name: "auth hotfix",
		project: "acme-api",
		activity: "done",
		doing: "Opened pull request #482",
		updatedAt: start - 26 * minute,
	}),
	session({
		id: "d4c3f5a6b8",
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
		name: "a11y sweep",
		project: "acme-web",
		activity: "failed",
		doing: "axe found 14 violations; build failed",
		updatedAt: start - 12 * minute,
	}),
	session({
		id: "f6a5b7d8e0",
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
	}),
	session({
		id: "b8e7d9f0a2",
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
	links,
	messages,
	generatedAt: start,
};

const ansi = {
	reset: "\x1b[0m",
	dim: "\x1b[2m",
	bold: "\x1b[1m",
	green: "\x1b[32m",
	red: "\x1b[31m",
	yellow: "\x1b[33m",
	orange: "\x1b[38;5;173m",
	grey: "\x1b[38;5;245m",
};

const transcripts: Record<string, string[]> = {
	a1f0c2d4e5: [
		`${ansi.orange}●${ansi.reset} I'll add the currency field and run the auth tests.`,
		"",
		`${ansi.green}●${ansi.reset} ${ansi.bold}Update${ansi.reset}(src/orders/summary.ts)`,
		`  ${ansi.grey}⎿  Updated src/orders/summary.ts with 6 additions${ansi.reset}`,
		`     ${ansi.green}+   currency: order.currency ?? "USD",${ansi.reset}`,
		"",
		`${ansi.green}●${ansi.reset} ${ansi.bold}Bash${ansi.reset}(npm test -- --filter auth)`,
		`  ${ansi.grey}⎿  ▶ session expiry${ansi.reset}`,
		`       ${ansi.green}✔${ansi.reset} refreshes a token within the grace window ${ansi.dim}(4ms)${ansi.reset}`,
		`       ${ansi.green}✔${ansi.reset} rejects a token past expiry ${ansi.dim}(2ms)${ansi.reset}`,
		`       ${ansi.green}✔${ansi.reset} rotates the refresh token ${ansi.dim}(3ms)${ansi.reset}`,
		`       ${ansi.yellow}…${ansi.reset} running 41 more`,
		"",
		`${ansi.orange}✻${ansi.reset} ${ansi.orange}Testing…${ansi.reset} ${ansi.dim}(38s · ↓ 2.1k tokens)${ansi.reset}`,
	],
	b2e1d3c4f6: [
		`${ansi.green}●${ansi.reset} The backfill is ready. It runs in batches of 5,000 rows.`,
		"",
		`${ansi.green}●${ansi.reset} ${ansi.bold}Bash${ansi.reset}(npm run db:migrate -- --env staging)`,
		"",
		` ${ansi.yellow}Do you want to proceed?${ansi.reset}`,
		` ${ansi.orange}❯ 1. Yes${ansi.reset}`,
		"   2. Yes, and don't ask again for npm run db:migrate",
		"   3. No, and tell Claude what to do differently",
	],
	c3d2e4f5a7: [
		`${ansi.green}●${ansi.reset} ${ansi.bold}Bash${ansi.reset}(gh pr create --fill)`,
		`  ${ansi.grey}⎿  https://github.com/acme/acme-api/pull/482${ansi.reset}`,
		"",
		`${ansi.green}●${ansi.reset} Opened #482: fix token refresh race in the auth middleware.`,
		"",
		`${ansi.dim}Job finished in 14m 2s${ansi.reset}`,
	],
	e5b4a6c7d9: [
		`${ansi.green}●${ansi.reset} ${ansi.bold}Bash${ansi.reset}(npx axe-cli http://localhost:5173/checkout)`,
		`  ${ansi.grey}⎿${ansi.reset}  ${ansi.red}✖ 14 violations found${ansi.reset}`,
		`     ${ansi.red}label${ansi.reset}: Form elements must have labels (9)`,
		`     ${ansi.red}color-contrast${ansi.reset}: Elements must meet contrast (5)`,
		"",
		`${ansi.red}●${ansi.reset} The accessibility gate failed; stopping here.`,
	],
	f6a5b7d8e0: [
		`${ansi.green}●${ansi.reset} ${ansi.bold}Bash${ansi.reset}(terraform plan -out plan.tfplan)`,
		`  ${ansi.grey}⎿  Plan: 2 to add, 1 to change, 0 to destroy.${ansi.reset}`,
		"",
		`${ansi.green}●${ansi.reset} Plan saved. Review it before I apply.`,
	],
	a7f6c8e9f1: [
		`${ansi.green}●${ansi.reset} Last month's spend is up 8%, mostly NAT gateway traffic.`,
		"",
		`${ansi.orange}>${ansi.reset} ${ansi.dim}Try "summarise by service"${ansi.reset}`,
	],
};

async function previewsFor(): Promise<Preview[]> {
	return Promise.all(
		Object.entries(transcripts).map(async ([sessionId, lines]) => ({
			sessionId,
			html: await renderPreview(lines.join("\r\n")),
			capturedAt: Date.now(),
		})),
	);
}

const previews = await previewsFor();

const server = createServer(async (req, res) => {
	const url = new URL(req.url ?? "/", "http://localhost");
	if (req.method === "POST" && url.pathname === "/api/sessions") {
		let body = "";
		for await (const chunk of req) body += chunk;
		const request = JSON.parse(body || "{}") as { cwd?: string; name?: string };
		const id = Math.random().toString(16).slice(2, 12);
		const created = session({
			id,
			name: request.name || "new session",
			project:
				(request.cwd ?? "/Users/me/dev/acme-api").split("/").pop() ??
				"acme-api",
			cwd: request.cwd ?? "/Users/me/dev/acme-api",
			activity: "working",
			doing: "Starting",
			startedAt: Date.now(),
			updatedAt: Date.now(),
		});
		setTimeout(() => {
			sessions.push(created);
			broadcast({ type: "board", board: snapshot() });
		}, 600);
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify({ ok: true, short: created.short }));
		return;
	}
	const transcript = url.pathname.match(
		/^\/api\/sessions\/([^/]+)\/transcript$/,
	);
	if (transcript) {
		const entries: TranscriptEntry[] = [
			{
				at: Date.now() - 4 * minute,
				role: "user",
				text: "Make the checkout summary show the currency.",
			},
			{
				at: Date.now() - 3 * minute,
				role: "assistant",
				text: "I'll read the summary component first.",
			},
			{
				at: Date.now() - 3 * minute,
				role: "tool",
				text: "Read src/checkout/Summary.tsx",
			},
			{
				at: Date.now() - 2 * minute,
				role: "peer",
				text: "Currency field added to OrderSummary.",
			},
			{
				at: Date.now() - minute,
				role: "assistant",
				text: "Updated Summary.tsx to render the currency code.",
			},
		];
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
	return {
		...board,
		sessions: [...sessions],
		messages: [...messages],
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
	for (const preview of previews) send(ws, { type: "preview", preview });
});

attach.on("connection", (ws) => {
	ws.send(
		Buffer.from(
			`${(transcripts.a1f0c2d4e5 ?? []).join("\r\n")}\r\n\r\n${ansi.orange}>${ansi.reset} `,
		),
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
