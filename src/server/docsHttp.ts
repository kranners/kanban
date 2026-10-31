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
import { linkedTo } from "../shared/relations.ts";
import type { DocFile, DocStore } from "../shared/types.ts";
import { fromLoopback } from "./agentAuth.ts";
import type { AnnotationStore } from "./annotations.ts";
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
	relations: Pick<RelationStore, "current">;
	annotations: Pick<AnnotationStore, "current">;
};

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

const named = (store: DocStore) => `"${store.title}" (${store.id})`;

const counted = (n: number, noun: string) =>
	`${n} ${noun}${n === 1 ? "" : "s"}`;

const sizeOf = (bytes: number) => counted(bytes, "byte");

const fileLine = (file: DocFile) =>
	`- ${file.path} (${sizeOf(file.size)}, ${new Date(file.updatedAt).toISOString()})`;

const noneLinked = {
	error:
		"No doc stores are linked to this session. Ask the user to link one on the kanban board: drag from a handle on this session's card to a doc store.",
};

export const createDocsHttp = ({
	files,
	relations,
	annotations,
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

	const run = async (call: DocToolCall, store: DocStore): Promise<Outcome> => {
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
