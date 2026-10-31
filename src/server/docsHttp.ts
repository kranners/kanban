import { randomUUID } from "node:crypto";
import {
	type IncomingMessage,
	type ServerResponse,
	STATUS_CODES,
} from "node:http";
import {
	type DocToolCall,
	parseDocToolCall,
	type StoreCall,
} from "../agent/docTools.ts";
import {
	docContentType,
	isDocPath,
	isTextPath,
	maxDocBytes,
	maxDocTextBytes,
} from "../shared/docPaths.ts";
import { linkRefusal, live } from "../shared/reach.ts";
import { linkedTo, samePair } from "../shared/relations.ts";
import type {
	DocFile,
	DocStore,
	Point,
	RelationDraft,
	Session,
} from "../shared/types.ts";
import { docStoreSize, topZ } from "../web/notes.ts";
import { fromLoopback } from "./agentAuth.ts";
import type { AnnotationStore } from "./annotations.ts";
import { skipReason } from "./announce.ts";
import type { DocNotices } from "./docNotices.ts";
import type { DocFiles } from "./docs.ts";
import type { RelationStore } from "./relations.ts";

export type DocsHttp = {
	tool(req: IncomingMessage, res: ServerResponse, tool: string): Promise<void>;
	file(
		req: IncomingMessage,
		res: ServerResponse,
		store: string,
		path: string,
	): Promise<void>;
};

export type DocsHttpDeps = {
	files: DocFiles;
	relations: Pick<RelationStore, "current" | "create" | "remove">;
	annotations: Pick<AnnotationStore, "current" | "put">;
	sessions(): readonly Session[];
	place(session: string, size: { w: number; h: number }): Point;
	notices: Pick<DocNotices, "post">;
	wake(session: Session, text: string): Promise<unknown>;
	newId?: () => string;
};

export const wakeText =
	"Another session on the kanban board shared a doc store with you. Its message is in the board's note on this prompt: read it, and act on it if it fits your work.";

const wakeable = new Set<Session["activity"]>(["idle", "done", "watching"]);

export const maxDocToolBytes = Math.ceil((maxDocBytes * 4) / 3) + 64 * 1024;

const sessionPattern = /^[A-Za-z0-9_-]{1,128}$/;

const docHeaders = {
	"cache-control": "no-cache",
	"x-content-type-options": "nosniff",
	"content-security-policy":
		"sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'",
};

type Outcome = { text: string } | { error: string };

const sendJson = (res: ServerResponse, status: number, body: unknown) => {
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"cache-control": "no-store",
	});
	res.end(JSON.stringify(body));
};

const sendError = (res: ServerResponse, status: number) =>
	sendJson(res, status, { error: STATUS_CODES[status] });

const readJson = (req: IncomingMessage, limit: number): Promise<unknown> =>
	new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		let size = 0;
		req.on("data", (chunk: Buffer) => {
			size += chunk.length;
			if (size > limit) {
				reject(new Error("body too large"));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => {
			try {
				resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
			} catch (error) {
				reject(error);
			}
		});
		req.on("error", reject);
	});

const storeTools = new Set<string>([
	"find_doc_stores",
	"create_doc_store",
	"join_doc_store",
	"leave_doc_store",
	"share_doc_store",
]);

const isStoreCall = (call: DocToolCall): call is StoreCall =>
	storeTools.has(call.tool);

const named = (store: DocStore) => `"${store.title}" (${store.id})`;

const counted = (n: number, noun: string) =>
	`${n} ${noun}${n === 1 ? "" : "s"}`;

const sizeOf = (bytes: number) => counted(bytes, "byte");

const fileLine = (file: DocFile) =>
	`- ${file.path} (${sizeOf(file.size)}, ${new Date(file.updatedAt).toISOString()})`;

const noneLinked = {
	error:
		"No doc stores are linked to this session. Make one with create_doc_store, or find one with find_doc_stores and join it with join_doc_store.",
};

const linkOf = (session: string, store: string): RelationDraft => ({
	from: { kind: "session", id: session },
	to: { kind: "docs", id: store },
});

export const createDocsHttp = ({
	files,
	relations,
	annotations,
	sessions,
	place,
	notices,
	wake,
	newId = randomUUID,
}: DocsHttpDeps): DocsHttp => {
	const docStore = (id: string): DocStore | null => {
		const annotation = annotations.current()[id];
		return annotation?.kind === "docs" ? annotation : null;
	};

	const linkedStores = (session: string): DocStore[] =>
		linkedTo(relations.current(), { kind: "session", id: session }).flatMap(
			(end) => {
				const store = end.kind === "docs" ? docStore(end.id) : null;
				return store ? [store] : [];
			},
		);

	const chosen = (
		session: string,
		requested: string | undefined,
	): DocStore | { error: string } => {
		const linked = linkedStores(session);
		if (requested !== undefined) {
			return (
				linked.find((store) => store.id === requested) ?? {
					error: `Doc store ${requested} isn't linked to this session`,
				}
			);
		}
		const [only, ...others] = linked;
		if (!only) return noneLinked;
		if (others.length > 0) {
			return {
				error: `Several doc stores are linked to this session, so name one with store: ${linked.map(named).join(", ")}`,
			};
		}
		return only;
	};

	const filesOf = (store: DocStore) => files.index()[store.id] ?? [];

	const listing = (store: DocStore) => {
		const list = filesOf(store);
		return list.length === 0
			? `${named(store)} is empty.`
			: [`Files in ${named(store)}:`, ...list.map(fileLine)].join("\n");
	};

	const missing = (path: string, store: DocStore) => ({
		error: `No file ${path} in ${named(store)}`,
	});

	const run = async (
		call: Exclude<DocToolCall, StoreCall>,
		store: DocStore,
	): Promise<Outcome> => {
		switch (call.tool) {
			case "list_docs":
				return { text: listing(store) };
			case "read_doc": {
				const known = filesOf(store).find((file) => file.path === call.path);
				if (known && !isTextPath(call.path)) {
					return {
						text: `${call.path} is an image (${sizeOf(known.size)}); show it with ![alt](<path relative to the page>)`,
					};
				}
				const bytes = known && (await files.read(store.id, call.path));
				if (!bytes) return missing(call.path, store);
				const text = bytes.subarray(0, maxDocTextBytes).toString("utf8");
				return bytes.length > maxDocTextBytes
					? {
							text: `${text}\n\n[${call.path} is ${bytes.length} bytes; this shows the first ${maxDocTextBytes}]`,
						}
					: { text };
			}
			case "write_doc": {
				const written = await files.write(
					store.id,
					call.path,
					Buffer.from(call.content, "utf8"),
				);
				return "error" in written
					? written
					: {
							text: `Wrote ${call.path} in "${store.title}" (${sizeOf(written.size)})`,
						};
			}
			case "delete_doc":
				return (await files.remove(store.id, call.path))
					? { text: `Deleted ${call.path} from "${store.title}"` }
					: missing(call.path, store);
			case "put_doc_asset": {
				const written = await files.write(
					store.id,
					call.path,
					Buffer.from(call.data, "base64"),
				);
				return "error" in written
					? written
					: {
							text: `Saved ${call.path} in "${store.title}" (${sizeOf(written.size)}). Show it from a page with ![alt](${call.path}), relative to the page's folder.`,
						};
			}
		}
	};

	const sessionOf = (id: string) =>
		sessions().find((session) => session.id === id) ?? null;

	const allStores = (): DocStore[] =>
		Object.values(annotations.current()).filter(
			(annotation): annotation is DocStore => annotation.kind === "docs",
		);

	const isLinked = (session: string, store: string) =>
		relations
			.current()
			.some((relation) => samePair(relation, linkOf(session, store)));

	const link = (session: string, store: string): Outcome => {
		if (isLinked(session, store)) return { text: "" };
		const made = relations.create(linkOf(session, store));
		return "error" in made ? made : { text: "" };
	};

	const storeLine = (store: DocStore, caller: string) => {
		const names = linkedTo(relations.current(), { kind: "docs", id: store.id })
			.flatMap((end) => {
				if (end.kind !== "session") return [];
				if (end.id === caller) return ["you"];
				const session = sessionOf(end.id);
				return session ? [session.name] : [];
			})
			.sort((a, b) => (a === "you" ? -1 : b === "you" ? 1 : 0));
		const linked =
			names.length === 0
				? "linked to no session"
				: `linked to ${names.join(", ")}`;
		return `- ${named(store)}: ${counted(filesOf(store).length, "file")} · ${linked}`;
	};

	const targetOf = (
		caller: Session,
		ref: string,
	): Session | { error: string } => {
		const all = sessions();
		const exact =
			all.find((session) => session.id === ref) ??
			all.find((session) => session.short === ref);
		const wanted = ref.trim().toLowerCase();
		const named_ = all.filter(
			(session) => session.name.toLowerCase() === wanted,
		);
		const running = named_.filter(live);
		const candidates = running.length > 0 ? running : named_;
		if (!exact && candidates.length > 1) {
			return {
				error: `Several sessions are named ${ref}, so give its id: ${candidates.map((session) => session.id).join(", ")}`,
			};
		}
		const found = exact ?? candidates[0];
		if (!found) {
			const others = all
				.filter((session) => session.id !== caller.id && live(session))
				.map((session) => `${session.name} (${session.id})`);
			return {
				error: `No session ${ref} on the board.${others.length > 0 ? ` Live sessions: ${others.join(", ")}` : ""}`,
			};
		}
		if (found.id === caller.id) return { error: "That's your own session" };
		const refused = linkRefusal(found);
		if (refused) return { error: refused };
		if (!live(found)) return { error: `${found.name} isn't running` };
		return found;
	};

	const noticeOf = (
		caller: Session,
		store: DocStore,
		call: Extract<StoreCall, { tool: "share_doc_store" }>,
	) =>
		[
			call.contribute
				? `${caller.name} (session ${caller.id}) linked the doc store ${named(store)} to you and asks you to contribute to it.`
				: `${caller.name} (session ${caller.id}) linked the doc store ${named(store)} to you for reference.`,
			call.note ? `Their note: ${call.note}` : null,
			call.contribute
				? `Read it with mcp__kanban__list_docs and mcp__kanban__read_doc, then add what they ask with mcp__kanban__write_doc, reading a page again before you change it. If it doesn't fit your work, or when you're done, tell ${caller.name} with SendMessage where you can.`
				: "Read what's relevant with mcp__kanban__list_docs and mcp__kanban__read_doc.",
		]
			.filter(Boolean)
			.join(" ");

	const runStore = async (
		call: StoreCall,
		caller: Session,
	): Promise<Outcome> => {
		switch (call.tool) {
			case "find_doc_stores": {
				const stores = allStores().sort((a, b) =>
					a.title.localeCompare(b.title),
				);
				return stores.length === 0
					? {
							text: "There are no doc stores on the board. Make one with create_doc_store.",
						}
					: {
							text: [
								"Doc stores on the board:",
								...stores.map((store) => storeLine(store, caller.id)),
							].join("\n"),
						};
			}
			case "create_doc_store": {
				const id = newId();
				const store: DocStore = {
					id,
					kind: "docs",
					...place(caller.id, docStoreSize),
					...docStoreSize,
					z: topZ(annotations.current()) + 1,
					title: call.title,
				};
				const put = annotations.put(store);
				if ("error" in put) return put;
				const linked = link(caller.id, id);
				if ("error" in linked) return linked;
				return {
					text: `Made the doc store ${named(store)} beside your card and linked it to you. Start it with an index.md that explains what it covers, and tell sessions that need it with share_doc_store.`,
				};
			}
			case "join_doc_store": {
				const store = docStore(call.store);
				if (!store)
					return {
						error: `No doc store ${call.store} on the board; see find_doc_stores`,
					};
				if (isLinked(caller.id, store.id)) {
					return { text: `${named(store)} is already linked to you.` };
				}
				const linked = link(caller.id, store.id);
				return "error" in linked
					? linked
					: { text: `Joined ${named(store)}.\n\n${listing(store)}` };
			}
			case "leave_doc_store": {
				const relation = relations
					.current()
					.find((relation) =>
						samePair(relation, linkOf(caller.id, call.store)),
					);
				if (!relation) {
					return {
						error: `Doc store ${call.store} isn't linked to this session`,
					};
				}
				relations.remove(relation.id);
				const store = docStore(call.store);
				return { text: `Left ${store ? named(store) : call.store}.` };
			}
			case "share_doc_store": {
				const store = chosen(caller.id, call.store);
				if ("error" in store) return store;
				const target = targetOf(caller, call.session);
				if ("error" in target) return target;
				const already = isLinked(target.id, store.id);
				const linked = link(target.id, store.id);
				if ("error" in linked) return linked;
				notices.post(target.id, noticeOf(caller, store, call));
				const woken =
					wakeable.has(target.activity) && skipReason(target) === null
						? await wake(target, wakeText).then(
								() => true,
								() => false,
							)
						: false;
				const linkedText = already
					? "was already linked to"
					: "is now linked to";
				const when = woken
					? "It was idle, so the board woke it to read your note."
					: "It gets your note at its next step.";
				return {
					text: `${named(store)} ${linkedText} ${target.name}. ${when}`,
				};
			}
		}
	};

	const listLinked = (session: string): Outcome => {
		const linked = linkedStores(session);
		const [only, ...others] = linked;
		if (!only) return noneLinked;
		const stores = [
			"Doc stores linked to this session:",
			...linked.map(
				(store) =>
					`- ${named(store)}: ${counted(filesOf(store).length, "file")}`,
			),
		].join("\n");
		return others.length === 0
			? { text: `${stores}\n\n${listing(only)}` }
			: { text: stores };
	};

	return {
		async tool(req, res, tool) {
			if (!fromLoopback(req) || req.headers.origin !== undefined) {
				return sendError(res, 403);
			}
			const session = req.headers["x-kanban-session"];
			if (typeof session !== "string" || !sessionPattern.test(session)) {
				return sendError(res, 401);
			}
			if (!req.headers["content-type"]?.startsWith("application/json")) {
				return sendError(res, 415);
			}
			let body: unknown;
			try {
				body = await readJson(req, maxDocToolBytes);
			} catch {
				return sendJson(res, 400, { ok: false, error: "Invalid JSON body" });
			}
			const call = parseDocToolCall(tool, body);
			if ("error" in call) {
				return sendJson(res, 400, { ok: false, error: call.error });
			}
			if (isStoreCall(call)) {
				const caller = sessionOf(session);
				const outcome = caller
					? await runStore(call, caller)
					: { error: "This session isn't on the kanban board" };
				return "error" in outcome
					? sendJson(res, 422, { ok: false, error: outcome.error })
					: sendJson(res, 200, { ok: true, text: outcome.text });
			}
			const store =
				call.tool === "list_docs" && call.store === undefined
					? null
					: chosen(session, call.store);
			if (store && "error" in store) {
				return sendJson(res, 422, { ok: false, error: store.error });
			}
			const outcome = store ? await run(call, store) : listLinked(session);
			if ("error" in outcome) {
				return sendJson(res, 422, { ok: false, error: outcome.error });
			}
			sendJson(res, 200, { ok: true, text: outcome.text });
		},
		async file(req, res, store, encoded) {
			let path: string;
			try {
				path = decodeURIComponent(encoded);
			} catch {
				return sendError(res, 400);
			}
			if (!isDocPath(path) || !docStore(store)) return sendError(res, 404);
			const bytes = await files.read(store, path);
			if (!bytes) return sendError(res, 404);
			res.writeHead(200, {
				...docHeaders,
				"content-type": docContentType(path),
				"content-length": bytes.length,
			});
			res.end(req.method === "HEAD" ? undefined : bytes);
		},
	};
};

export const sessionMcpConfig = (
	node: string,
	script: string,
	boardUrl: string,
): string | null =>
	JSON.stringify({
		mcpServers: {
			kanban: {
				type: "stdio",
				command: node,
				args: [script],
				env: { KANBAN_AGENT_URL: boardUrl },
			},
		},
	});
