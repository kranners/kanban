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
	| "list_doc_stores"
	| "list_docs"
	| "read_doc"
	| "write_doc"
	| "delete_doc"
	| "put_doc_asset"
	| "search_docs"
	| "create_doc_store"
	| "rename_doc_store"
	| "delete_doc_store";

type Located = { store: string; path: string };

export type DocToolCall =
	| { tool: "list_doc_stores" }
	| { tool: "list_docs"; store: string }
	| ({ tool: "read_doc" } & Located)
	| ({ tool: "write_doc"; content: string } & Located)
	| ({ tool: "delete_doc" } & Located)
	| ({ tool: "put_doc_asset"; data: string } & Located)
	| { tool: "search_docs"; query: string; store?: string }
	| { tool: "create_doc_store"; title: string }
	| { tool: "rename_doc_store"; store: string; title: string }
	| { tool: "delete_doc_store"; store: string };

export const maxSearchQuery = 200;

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
	description: "The doc store's id or its exact title, from list_doc_stores",
};
const path = {
	type: "string",
	description: "The file's path in the store, like guides/setup.md",
};
const title = {
	type: "string",
	maxLength: maxDocTitle,
	description: "A short name for what the docs cover, one line",
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

const shared =
	"Doc stores on the kanban board are shared by every session on it: sessions write them for each other, and any session can read, write and delete any of them.";

export const docToolDefinitions: DocToolDefinition[] = [
	{
		name: "list_doc_stores",
		description: `${shared} List every doc store with its title, id, file count, last update and what its index.md says it covers.`,
		inputSchema: object({}),
	},
	{
		name: "search_docs",
		description: `${shared} Search every text page of every store, or of one store, for words (case-insensitive). Returns matching store, path, line number and line, best matches first; store titles and file paths match too. Read a hit with read_doc.`,
		inputSchema: object(
			{
				query: {
					type: "string",
					maxLength: maxSearchQuery,
					description: "The text to look for, like a word or phrase",
				},
				store: {
					...store,
					description: `Only search this store: ${store.description}`,
				},
			},
			["query"],
		),
	},
	{
		name: "list_docs",
		description:
			"List the files in a shared doc store with their sizes and update times.",
		inputSchema: object({ store }, ["store"]),
	},
	{
		name: "read_doc",
		description:
			"Read a markdown or text page from a shared doc store. For an image it says how to show it from a page.",
		inputSchema: object({ store, path }, ["store", "path"]),
	},
	{
		name: "write_doc",
		description:
			"Create or replace a markdown or text page in a shared doc store, for other sessions to read. Paths are relative, like `guides/setup.md`, and folders are created as needed. Link pages with relative links, draw diagrams in fenced `mermaid` blocks, and add images with put_doc_asset. Other sessions write here too, so read a page again just before you replace it and keep what they added.",
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
			["store", "path", "content"],
		),
	},
	{
		name: "delete_doc",
		description:
			"Delete one file from a shared doc store. Other sessions may rely on it, so only delete what is wrong or replaced.",
		inputSchema: object({ store, path }, ["store", "path"]),
	},
	{
		name: "put_doc_asset",
		description:
			"Copy an image from this Mac into a shared doc store (.png .jpg .jpeg .gif .webp .svg, at most 10 MB). `file` is an absolute path; `path` is where it goes, such as `assets/flow.png`, with the same extension. Link it from a page by its relative path.",
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
			["store", "path", "file"],
		),
	},
	{
		name: "create_doc_store",
		description: `${shared} Make a new, empty doc store when none fits what you want to write. Start it with an index.md that explains what it covers. Returns its id.`,
		inputSchema: object({ title }, ["title"]),
	},
	{
		name: "rename_doc_store",
		description: "Give a shared doc store a new title.",
		inputSchema: object({ store, title }, ["store", "title"]),
	},
	{
		name: "delete_doc_store",
		description:
			"Delete a shared doc store and every file in it, for every session. Only do this for a store that is wrong or no longer used.",
		inputSchema: object({ store }, ["store"]),
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

const storeOf = (fields: Fields): string => {
	const value = string(fields, "store").trim();
	return value.length > 64
		? fail("store isn't a doc store id or title")
		: value;
};

const optionalStore = (fields: Fields): { store?: string } =>
	fields.store === undefined ? {} : { store: storeOf(fields) };

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
): Located => ({
	store: storeOf(fields),
	path: docPath(fields, accepts, kind),
});

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

const titleOf = (fields: Fields): string => {
	const value = string(fields, "title").trim();
	return value.length > maxDocTitle || /\p{Cc}/u.test(value)
		? fail(`title must be at most ${maxDocTitle} characters on one line`)
		: value;
};

const query = (fields: Fields): string => {
	const value = string(fields, "query").trim();
	return value.length > maxSearchQuery || /\p{Cc}/u.test(value)
		? fail(`query must be at most ${maxSearchQuery} characters on one line`)
		: value;
};

const image = "an image (.png .jpg .jpeg .gif .webp .svg)";
const text = "a text page (.md .txt .json .csv .svg)";

type Common = Exclude<DocToolCall, { tool: "put_doc_asset" }>;

const common = {
	list_doc_stores: (): Common => ({ tool: "list_doc_stores" }),
	list_docs: (fields: Fields): Common => ({
		tool: "list_docs",
		store: storeOf(fields),
	}),
	read_doc: (fields: Fields): Common => ({
		tool: "read_doc",
		...located(fields),
	}),
	write_doc: (fields: Fields): Common => ({
		tool: "write_doc",
		...located(fields, isTextPath, text),
		content: content(fields),
	}),
	delete_doc: (fields: Fields): Common => ({
		tool: "delete_doc",
		...located(fields),
	}),
	search_docs: (fields: Fields): Common => ({
		tool: "search_docs",
		query: query(fields),
		...optionalStore(fields),
	}),
	create_doc_store: (fields: Fields): Common => ({
		tool: "create_doc_store",
		title: titleOf(fields),
	}),
	rename_doc_store: (fields: Fields): Common => ({
		tool: "rename_doc_store",
		store: storeOf(fields),
		title: titleOf(fields),
	}),
	delete_doc_store: (fields: Fields): Common => ({
		tool: "delete_doc_store",
		store: storeOf(fields),
	}),
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
	list_doc_stores: [],
	list_docs: ["store"],
	read_doc: ["store", "path"],
	write_doc: ["store", "path", "content"],
	delete_doc: ["store", "path"],
	put_doc_asset: ["store", "path", "data"],
	search_docs: ["query", "store"],
	create_doc_store: ["title"],
	rename_doc_store: ["store", "title"],
	delete_doc_store: ["store"],
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
