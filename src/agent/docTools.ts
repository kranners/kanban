import { isAbsolute } from "node:path";
import {
	extensionOf,
	isDocPath,
	isImagePath,
	isTextPath,
	maxDocBytes,
	maxDocTextBytes,
} from "../shared/docPaths.ts";
import { maxDocTitle } from "../shared/types.ts";

export type DocToolName =
	| "list_docs"
	| "read_doc"
	| "write_doc"
	| "delete_doc"
	| "put_doc_asset"
	| "find_doc_stores"
	| "create_doc_store"
	| "join_doc_store"
	| "leave_doc_store"
	| "share_doc_store";

type Located = { store?: string; path: string };

export type DocToolCall =
	| { tool: "list_docs"; store?: string }
	| ({ tool: "read_doc" } & Located)
	| ({ tool: "write_doc"; content: string } & Located)
	| ({ tool: "delete_doc" } & Located)
	| ({ tool: "put_doc_asset"; data: string } & Located)
	| StoreCall;

export type StoreCall =
	| { tool: "find_doc_stores" }
	| { tool: "create_doc_store"; title: string }
	| { tool: "join_doc_store"; store: string }
	| { tool: "leave_doc_store"; store: string }
	| {
			tool: "share_doc_store";
			store?: string;
			session: string;
			note?: string;
			contribute: boolean;
	  };

export const maxShareNote = 2000;

export type DocToolInput =
	| Exclude<DocToolCall, { tool: "put_doc_asset" }>
	| ({ tool: "put_doc_asset"; file: string } & Located);

export type DocToolDefinition = {
	name: DocToolName;
	description: string;
	inputSchema: {
		type: "object";
		properties: Record<string, unknown>;
		required?: string[];
		additionalProperties: false;
	};
};

const store = {
	type: "string",
	description:
		"The doc store id from list_docs. Leave it out when only one store is linked to this session.",
};
const path = {
	type: "string",
	description: "The file's path in the store, like guides/setup.md",
};

const storeId = {
	type: "string",
	description: "A doc store id from find_doc_stores or list_docs",
};

const object = (
	properties: Record<string, unknown>,
	required: string[] = [],
): DocToolDefinition["inputSchema"] => ({
	type: "object",
	properties,
	...(required.length > 0 ? { required } : {}),
	additionalProperties: false,
});

export const docToolDefinitions: DocToolDefinition[] = [
	{
		name: "list_docs",
		description:
			"List the doc stores linked to this session on the kanban board, or the files in one of them with their sizes and update times.",
		inputSchema: object({ store }),
	},
	{
		name: "read_doc",
		description:
			"Read a markdown or text page from a linked doc store. For an image it says how to show it from a page.",
		inputSchema: object({ store, path }, ["path"]),
	},
	{
		name: "write_doc",
		description:
			"Create or replace a markdown or text page in a linked doc store. Paths are relative, like `guides/setup.md`, and folders are created as needed. Link pages with relative links, draw diagrams in fenced `mermaid` blocks, and add images with put_doc_asset. Read a page before you change it: other sessions write here too.",
		inputSchema: object(
			{
				store,
				path: {
					...path,
					description:
						"Where the page goes, like guides/setup.md (.md .txt .json .csv .svg)",
				},
				content: {
					type: "string",
					description: "The whole new text of the page, at most 1 MB",
				},
			},
			["path", "content"],
		),
	},
	{
		name: "delete_doc",
		description: "Delete one file from a linked doc store.",
		inputSchema: object({ store, path }, ["path"]),
	},
	{
		name: "put_doc_asset",
		description:
			"Copy an image from this Mac into a linked doc store (.png .jpg .jpeg .gif .webp .svg, at most 10 MB). `file` is an absolute path; `path` is where it goes, such as `assets/flow.png`, with the same extension. Link it from a page by its relative path.",
		inputSchema: object(
			{
				store,
				path: {
					...path,
					description: "Where the image goes, like assets/flow.png",
				},
				file: {
					type: "string",
					description: "The absolute path of the image on this Mac",
				},
			},
			["path", "file"],
		),
	},
	{
		name: "find_doc_stores",
		description:
			"List every doc store on the kanban board, not just yours: its id, title, file count, which sessions it is linked to, and whether it is linked to you. Join one with join_doc_store to read and write it.",
		inputSchema: object({}),
	},
	{
		name: "create_doc_store",
		description:
			"Make a new, empty doc store on the kanban board, placed beside your card and linked to you, so you can write docs to it right away. Start it with an index.md that explains what it covers. Returns its id.",
		inputSchema: object(
			{
				title: {
					type: "string",
					maxLength: maxDocTitle,
					description: "A short name for what the docs cover, one line",
				},
			},
			["title"],
		),
	},
	{
		name: "join_doc_store",
		description:
			"Link an existing doc store to your session, so the doc tools can read and write it. Find ids with find_doc_stores.",
		inputSchema: object({ store: storeId }, ["store"]),
	},
	{
		name: "leave_doc_store",
		description:
			"Unlink a doc store from your session. The store and its files stay on the board for others.",
		inputSchema: object({ store: storeId }, ["store"]),
	},
	{
		name: "share_doc_store",
		description:
			"Tell another session on the board about one of your doc stores. It links the store to that session, so it can use the doc tools on it, and passes your note on at its next step (an idle session is woken to read it). With contribute it is asked to add to the docs, not only read them. Say in the note what the docs hold and, when asking for help, exactly what you want it to write.",
		inputSchema: object(
			{
				store,
				session: {
					type: "string",
					description:
						"The other session's name, as other sessions are named to you, or its id",
				},
				note: {
					type: "string",
					maxLength: maxShareNote,
					description: "What to tell it about the docs, or what to add",
				},
				contribute: {
					type: "boolean",
					description:
						"Ask it to write to the docs too, not only read them; default false",
				},
			},
			["session"],
		),
	},
];

class Invalid extends Error {}

type Fields = Record<string, unknown>;

const fail = (message: string): never => {
	throw new Invalid(message);
};

const string = (fields: Fields, key: string): string => {
	const value = fields[key];
	if (typeof value !== "string" || value.trim() === "") {
		return fail(`${key} must be a non-empty string`);
	}
	return value;
};

const storeOf = (fields: Fields): { store?: string } => {
	if (fields.store === undefined) return {};
	const value = string(fields, "store");
	return value.length > 64
		? fail("store isn't a doc store id")
		: { store: value };
};

const docPath = (
	fields: Fields,
	accepts: (path: string) => boolean,
	kind: string,
) => {
	const value = string(fields, "path");
	if (!isDocPath(value)) {
		return fail(
			`${value} isn't a doc path: use relative folders and names of letters, digits, dots, dashes and underscores, ending in .md .txt .json .csv .svg .png .jpg .jpeg .gif or .webp`,
		);
	}
	return accepts(value) ? value : fail(`${value} isn't ${kind}`);
};

const anyDoc = () => true;

const located = (
	fields: Fields,
	accepts: (path: string) => boolean = anyDoc,
	kind = "",
): Located => ({ ...storeOf(fields), path: docPath(fields, accepts, kind) });

const content = (fields: Fields): string => {
	const value = fields.content;
	if (typeof value !== "string") return fail("content must be a string");
	return Buffer.byteLength(value) > maxDocTextBytes
		? fail(`content must be at most ${maxDocTextBytes} bytes`)
		: value;
};

const base64Pattern = /^[A-Za-z0-9+/]*={0,2}$/;

const data = (fields: Fields): string => {
	const value = fields.data;
	if (
		typeof value !== "string" ||
		value.length % 4 !== 0 ||
		!base64Pattern.test(value)
	) {
		return fail("data must be base64");
	}
	return Buffer.from(value, "base64").length > maxDocBytes
		? fail(`The file must be at most ${maxDocBytes} bytes`)
		: value;
};

const file = (fields: Fields, target: string): string => {
	const value = string(fields, "file");
	if (!isAbsolute(value)) return fail("file must be an absolute path");
	return extensionOf(value) === extensionOf(target)
		? value
		: fail(`file and path must have the same extension`);
};

const title = (fields: Fields): string => {
	const value = string(fields, "title").trim();
	return value.length > maxDocTitle || /\p{Cc}/u.test(value)
		? fail(`title must be at most ${maxDocTitle} characters on one line`)
		: value;
};

const requiredStore = (fields: Fields): string =>
	storeOf(fields).store ?? fail("store must be a non-empty string");

const note = (fields: Fields): { note?: string } => {
	if (fields.note === undefined) return {};
	const value = fields.note;
	if (typeof value !== "string" || value.length > maxShareNote) {
		return fail(`note must be a string of at most ${maxShareNote} characters`);
	}
	return value.trim() === "" ? {} : { note: value.trim() };
};

const flag = (fields: Fields, key: string): boolean => {
	const value = fields[key] ?? false;
	return typeof value === "boolean"
		? value
		: fail(`${key} must be true or false`);
};

const image = "an image (.png .jpg .jpeg .gif .webp .svg)";
const text = "a text page (.md .txt .json .csv .svg)";

const common = {
	list_docs: (fields: Fields) => ({
		tool: "list_docs" as const,
		...storeOf(fields),
	}),
	read_doc: (fields: Fields) => ({
		tool: "read_doc" as const,
		...located(fields),
	}),
	write_doc: (fields: Fields) => ({
		tool: "write_doc" as const,
		...located(fields, isTextPath, text),
		content: content(fields),
	}),
	delete_doc: (fields: Fields) => ({
		tool: "delete_doc" as const,
		...located(fields),
	}),
	find_doc_stores: (): StoreCall => ({ tool: "find_doc_stores" }),
	create_doc_store: (fields: Fields): StoreCall => ({
		tool: "create_doc_store",
		title: title(fields),
	}),
	join_doc_store: (fields: Fields): StoreCall => ({
		tool: "join_doc_store",
		store: requiredStore(fields),
	}),
	leave_doc_store: (fields: Fields): StoreCall => ({
		tool: "leave_doc_store",
		store: requiredStore(fields),
	}),
	share_doc_store: (fields: Fields): StoreCall => {
		const session = string(fields, "session");
		return {
			tool: "share_doc_store",
			...storeOf(fields),
			session:
				session.length > 128 ? fail("session must be a session") : session,
			...note(fields),
			contribute: flag(fields, "contribute"),
		};
	},
};

const forms = {
	mcp: {
		...common,
		put_doc_asset: (fields: Fields): DocToolInput => {
			const target = located(fields, isImagePath, image);
			return {
				tool: "put_doc_asset",
				...target,
				file: file(fields, target.path),
			};
		},
	},
	http: {
		...common,
		put_doc_asset: (fields: Fields): DocToolCall => ({
			tool: "put_doc_asset",
			...located(fields, isImagePath, image),
			data: data(fields),
		}),
	},
};

const httpArguments: Record<DocToolName, string[]> = {
	list_docs: ["store"],
	read_doc: ["store", "path"],
	write_doc: ["store", "path", "content"],
	delete_doc: ["store", "path"],
	put_doc_asset: ["store", "path", "data"],
	find_doc_stores: [],
	create_doc_store: ["title"],
	join_doc_store: ["store"],
	leave_doc_store: ["store"],
	share_doc_store: ["store", "session", "note", "contribute"],
};

const isDocToolName = (name: string): name is DocToolName =>
	Object.hasOwn(httpArguments, name);

const parse = <T>(
	name: string,
	args: unknown,
	allowed: (name: DocToolName) => string[],
	read: (name: DocToolName, fields: Fields) => T,
): T | { error: string } => {
	if (!isDocToolName(name)) return { error: `Unknown tool ${name}` };
	const fields = args ?? {};
	if (typeof fields !== "object" || Array.isArray(fields)) {
		return { error: "Arguments must be an object" };
	}
	const unknown = Object.keys(fields).find(
		(key) => !allowed(name).includes(key),
	);
	if (unknown) return { error: `Unknown argument ${unknown}` };
	try {
		return read(name, fields as Fields);
	} catch (error) {
		if (error instanceof Invalid) return { error: error.message };
		throw error;
	}
};

export const parseDocToolInput = (
	name: string,
	args: unknown,
): DocToolInput | { error: string } =>
	parse(
		name,
		args,
		(tool) =>
			Object.keys(
				docToolDefinitions.find((definition) => definition.name === tool)
					?.inputSchema.properties ?? {},
			),
		(tool, fields) => forms.mcp[tool](fields),
	);

export const parseDocToolCall = (
	name: string,
	args: unknown,
): DocToolCall | { error: string } =>
	parse(
		name,
		args,
		(tool) => httpArguments[tool],
		(tool, fields) => forms.http[tool](fields),
	);
