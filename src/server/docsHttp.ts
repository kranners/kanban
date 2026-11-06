import {
	type IncomingMessage,
	type ServerResponse,
	STATUS_CODES,
} from "node:http";
import { type DocToolCall, parseDocToolCall } from "../agent/docTools.ts";
import {
	docContentType,
	isDocPath,
	isTextPath,
	maxDocBytes,
	maxDocTextBytes,
} from "../shared/docPaths.ts";
import type { DocFile, DocStore } from "../shared/types.ts";
import type { DocStoreRegistry } from "./docStores.ts";
import type { DocFiles } from "./docs.ts";
import { fromLoopback } from "./loopback.ts";

export type DocsReply = { status: number; body?: unknown };

export type DocsHttp = {
	tool(req: IncomingMessage, res: ServerResponse, tool: string): Promise<void>;
	/** The same tools for a session on a runner, whose call the caller has already checked carries the runner token. */
	runnerTool(
		req: IncomingMessage,
		res: ServerResponse,
		tool: string,
	): Promise<void>;
	file(
		req: IncomingMessage,
		res: ServerResponse,
		store: string,
		path: string,
	): Promise<void>;
	createStore(body: unknown): DocsReply;
	renameStore(store: string, body: unknown): DocsReply;
	deleteStore(store: string): Promise<DocsReply>;
	putFile(store: string, path: string, body: unknown): Promise<DocsReply>;
	deleteFile(store: string, path: string): Promise<DocsReply>;
};

export type DocsHttpDeps = {
	files: DocFiles;
	stores: Pick<
		DocStoreRegistry,
		"current" | "get" | "create" | "rename" | "remove" | "touch"
	>;
};

export const maxDocToolBytes = Math.ceil((maxDocBytes * 4) / 3) + 64 * 1024;
export const maxDocPutBytes = maxDocTextBytes * 6 + 64 * 1024;
export const maxSearchLines = 40;
export const maxSearchLinesPerFile = 3;
const maxSnippet = 160;
const maxDescription = 120;

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

const failed = (status: number, error?: string): DocsReply => ({
	status,
	body: { ok: false, error: error ?? STATUS_CODES[status] },
});

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

const named = (store: DocStore) => `"${store.title}" (${store.id})`;

const counted = (n: number, noun: string) =>
	`${n} ${noun}${n === 1 ? "" : /(?:s|ch|sh|x)$/.test(noun) ? "es" : "s"}`;

const sizeOf = (bytes: number) => counted(bytes, "byte");

const iso = (time: number) => new Date(time).toISOString();

const fileLine = (file: DocFile) =>
	`- ${file.path} (${sizeOf(file.size)}, ${iso(file.updatedAt)})`;

const clipped = (text: string, max: number) =>
	text.length > max ? `${text.slice(0, max - 1)}…` : text;

export const describeIndex = (text: string): string | null => {
	for (const raw of text.split("\n")) {
		const line = raw
			.replace(/^\s*#+\s*/, "")
			.replace(/\s+/g, " ")
			.trim();
		if (line !== "") return clipped(line, maxDescription);
	}
	return null;
};

const wordsOf = (query: string) =>
	query.toLowerCase().split(/\s+/).filter(Boolean);

const matchesAll = (text: string, words: readonly string[]) => {
	const lower = text.toLowerCase();
	return words.every((word) => lower.includes(word));
};

const snippetOf = (line: string, word: string) => {
	const flat = line.replace(/\s+/g, " ").trim();
	if (flat.length <= maxSnippet) return flat;
	const at = Math.max(0, flat.toLowerCase().indexOf(word) - maxSnippet / 4);
	const piece = flat.slice(at, at + maxSnippet - 2);
	return `${at > 0 ? "…" : ""}${piece}…`;
};

type FileHits = {
	store: DocStore;
	path: string;
	pathMatched: boolean;
	lines: { line: number; text: string }[];
};

export const createDocsHttp = ({ files, stores }: DocsHttpDeps): DocsHttp => {
	const filesOf = (store: DocStore) => files.index()[store.id] ?? [];

	const updatedOf = (store: DocStore) =>
		Math.max(store.updatedAt, ...filesOf(store).map((file) => file.updatedAt));

	const resolve = (ref: string): DocStore | { error: string } => {
		const byId = stores.get(ref);
		if (byId) return byId;
		const wanted = ref.trim().toLowerCase();
		const titled = stores
			.current()
			.filter((store) => store.title.toLowerCase() === wanted);
		const [only, ...others] = titled;
		if (only && others.length === 0) return only;
		if (only) {
			return {
				error: `Several doc stores are titled "${ref}", so give its id: ${titled.map((store) => store.id).join(", ")}`,
			};
		}
		return {
			error: `No doc store ${ref}. See list_doc_stores for every store's id and title.`,
		};
	};

	const listing = (store: DocStore) => {
		const list = filesOf(store);
		return list.length === 0
			? `${named(store)} is empty. Start it with an index.md that explains what it covers.`
			: [`Files in ${named(store)}:`, ...list.map(fileLine)].join("\n");
	};

	const missing = (path: string, store: DocStore) => ({
		error: `No file ${path} in ${named(store)}`,
	});

	const readText = async (store: DocStore, path: string) => {
		const bytes = await files.read(store.id, path);
		return bytes ? bytes.subarray(0, maxDocTextBytes).toString("utf8") : null;
	};

	const descriptionOf = async (store: DocStore) => {
		const index = filesOf(store).find((file) => file.path === "index.md");
		const text = index && (await readText(store, index.path));
		return text ? describeIndex(text) : null;
	};

	const storeLine = async (store: DocStore) => {
		const description = await descriptionOf(store);
		return `- ${named(store)}: ${counted(filesOf(store).length, "file")}, updated ${iso(updatedOf(store))}${description ? ` · ${description}` : ""}`;
	};

	const listStores = async (): Promise<Outcome> => {
		const all = stores.current();
		if (all.length === 0) {
			return {
				text: "There are no doc stores yet. Make one with create_doc_store when you have something other sessions should know.",
			};
		}
		return {
			text: [
				"Doc stores shared by every session on the board:",
				...(await Promise.all(all.map(storeLine))),
			].join("\n"),
		};
	};

	const search = async (
		query: string,
		within: DocStore | null,
	): Promise<Outcome> => {
		const words = wordsOf(query);
		const scope = within ? [within] : stores.current();
		const titled = scope.filter((store) => matchesAll(store.title, words));
		const hits: FileHits[] = [];
		for (const store of scope) {
			for (const file of filesOf(store)) {
				const pathMatched = matchesAll(file.path, words);
				const lines: FileHits["lines"] = [];
				if (isTextPath(file.path)) {
					const text = (await readText(store, file.path)) ?? "";
					text.split("\n").forEach((line, n) => {
						if (matchesAll(line, words))
							lines.push({ line: n + 1, text: line });
					});
				}
				if (pathMatched || lines.length > 0) {
					hits.push({ store, path: file.path, pathMatched, lines });
				}
			}
		}
		if (titled.length === 0 && hits.length === 0) {
			return {
				text: `Nothing matches "${query}"${within ? ` in ${named(within)}` : " in any doc store"}.${within ? "" : " See list_doc_stores for what there is."}`,
			};
		}
		const score = (hit: FileHits) =>
			hit.lines.length + (hit.pathMatched ? 1 : 0);
		hits.sort(
			(a, b) =>
				score(b) - score(a) ||
				a.store.title.localeCompare(b.store.title) ||
				(a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
		);
		const out: string[] = [];
		if (titled.length > 0) {
			out.push(
				`Doc stores whose title matches: ${titled.map(named).join(", ")}`,
			);
		}
		const total = hits.reduce((sum, hit) => sum + hit.lines.length, 0);
		if (hits.length > 0) {
			out.push(
				`${counted(total, "matching line")} in ${counted(hits.length, "file")}, most matches first:`,
			);
		}
		let shown = 0;
		let capped = false;
		for (const hit of hits) {
			if (shown >= maxSearchLines) {
				capped = true;
				break;
			}
			const lines = hit.lines.slice(
				0,
				Math.min(maxSearchLinesPerFile, maxSearchLines - shown),
			);
			if (lines.length < hit.lines.length) capped = true;
			const what = hit.lines.length
				? counted(hit.lines.length, "match")
				: "path matches";
			out.push(`- ${named(hit.store)} ${hit.path}: ${what}`);
			for (const { line, text } of lines) {
				out.push(`  ${line}: ${snippetOf(text, words[0] ?? "")}`);
			}
			shown += Math.max(lines.length, 1);
		}
		if (capped) {
			out.push(
				`[Results capped at ${maxSearchLines} lines and ${maxSearchLinesPerFile} per file: read a page with read_doc, or narrow the search with more words or store.]`,
			);
		}
		return { text: out.join("\n") };
	};

	const run = async (call: DocToolCall): Promise<Outcome> => {
		if (call.tool === "list_doc_stores") return listStores();
		if (call.tool === "create_doc_store") {
			const made = stores.create(call.title);
			return "error" in made
				? made
				: {
						text: `Made the doc store ${named(made)}, shared with every session on the board. Start it with an index.md that explains what it covers, using store ${made.id}.`,
					};
		}
		if (call.tool === "search_docs") {
			if (call.store === undefined) return search(call.query, null);
			const within = resolve(call.store);
			return "error" in within ? within : search(call.query, within);
		}
		const store = resolve(call.store);
		if ("error" in store) return store;
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
				if ("error" in written) return written;
				stores.touch(store.id);
				return {
					text: `Wrote ${call.path} in ${named(store)} (${sizeOf(written.size)})`,
				};
			}
			case "delete_doc":
				if (!(await files.remove(store.id, call.path))) {
					return missing(call.path, store);
				}
				stores.touch(store.id);
				return { text: `Deleted ${call.path} from ${named(store)}` };
			case "put_doc_asset": {
				const written = await files.write(
					store.id,
					call.path,
					Buffer.from(call.data, "base64"),
				);
				if ("error" in written) return written;
				stores.touch(store.id);
				return {
					text: `Saved ${call.path} in ${named(store)} (${sizeOf(written.size)}). Show it from a page with ![alt](${call.path}), relative to the page's folder.`,
				};
			}
			case "rename_doc_store": {
				const renamed = stores.rename(store.id, call.title);
				if (!renamed) return { error: `No doc store ${store.id}` };
				return "error" in renamed
					? renamed
					: { text: `Renamed ${store.id} to "${renamed.title}".` };
			}
			case "delete_doc_store": {
				const count = filesOf(store).length;
				await stores.remove(store.id);
				return {
					text: `Deleted the doc store ${named(store)} and its ${counted(count, "file")}.`,
				};
			}
		}
	};

	const decoded = (encoded: string): string | null => {
		try {
			return decodeURIComponent(encoded);
		} catch {
			return null;
		}
	};

	const titleOf = (body: unknown): unknown =>
		typeof body === "object" && body !== null
			? (body as Record<string, unknown>).title
			: undefined;

	const handle = async (
		req: IncomingMessage,
		res: ServerResponse,
		tool: string,
	) => {
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
		const outcome = await run(call);
		if ("error" in outcome) {
			return sendJson(res, 422, { ok: false, error: outcome.error });
		}
		sendJson(res, 200, { ok: true, text: outcome.text });
	};

	return {
		tool(req, res, tool) {
			if (!fromLoopback(req) || req.headers.origin !== undefined) {
				sendError(res, 403);
				return Promise.resolve();
			}
			return handle(req, res, tool);
		},
		runnerTool(req, res, tool) {
			if (req.headers.origin !== undefined) {
				sendError(res, 403);
				return Promise.resolve();
			}
			return handle(req, res, tool);
		},
		async file(req, res, store, encoded) {
			const path = decoded(encoded);
			if (path === null) return sendError(res, 400);
			if (!isDocPath(path) || !stores.get(store)) return sendError(res, 404);
			const bytes = await files.read(store, path);
			if (!bytes) return sendError(res, 404);
			res.writeHead(200, {
				...docHeaders,
				"content-type": docContentType(path),
				"content-length": bytes.length,
			});
			res.end(req.method === "HEAD" ? undefined : bytes);
		},
		createStore(body) {
			const made = stores.create(titleOf(body));
			if ("error" in made) {
				return failed(made.error.startsWith("title") ? 400 : 422, made.error);
			}
			return { status: 201, body: made };
		},
		renameStore(store, body) {
			const renamed = stores.rename(store, titleOf(body));
			if (!renamed) return failed(404);
			return "error" in renamed
				? failed(400, renamed.error)
				: { status: 200, body: renamed };
		},
		async deleteStore(store) {
			return (await stores.remove(store)) ? { status: 204 } : failed(404);
		},
		async putFile(id, encoded, body) {
			const store = stores.get(id);
			if (!store) return failed(404);
			const path = decoded(encoded);
			if (path === null || !isDocPath(path) || !isTextPath(path)) {
				return failed(
					400,
					"path must be a text page (.md .txt .json .csv .svg) of letters, digits, dots, dashes and underscores in relative folders",
				);
			}
			const content =
				typeof body === "object" && body !== null
					? (body as Record<string, unknown>).content
					: undefined;
			if (typeof content !== "string") {
				return failed(400, "content must be a string");
			}
			if (Buffer.byteLength(content) > maxDocTextBytes) {
				return failed(400, `content must be at most ${maxDocTextBytes} bytes`);
			}
			const written = await files.write(
				store.id,
				path,
				Buffer.from(content, "utf8"),
			);
			if ("error" in written) return failed(422, written.error);
			stores.touch(store.id);
			return { status: 200, body: written };
		},
		async deleteFile(id, encoded) {
			const store = stores.get(id);
			const path = decoded(encoded);
			if (!store || path === null || !isDocPath(path)) return failed(404);
			if (!(await files.remove(store.id, path))) return failed(404);
			stores.touch(store.id);
			return { status: 204 };
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
