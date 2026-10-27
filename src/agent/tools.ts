import { isRegionColour, type RegionColour } from "../shared/colours.ts";
import { maxNoteText, type NoteColor, noteColors } from "../shared/types.ts";

export type Placed = {
	id: string;
	x: number;
	y: number;
	w?: number;
	h?: number;
};

export type Bounds = { x: number; y: number; w: number; h: number };

export type ToolCall =
	| { tool: "board_snapshot" }
	| { tool: "read_transcript"; session: string; limit: number }
	| { tool: "ask_session"; session: string; question: string }
	| { tool: "send_prompt"; session: string; text: string }
	| { tool: "finish_session"; session: string }
	| {
			tool: "start_session";
			cwd: string;
			prompt: string;
			name?: string;
			x?: number;
			y?: number;
	  }
	| {
			tool: "put_note";
			id?: string;
			text?: string;
			color?: NoteColor;
			x?: number;
			y?: number;
			w?: number;
			h?: number;
	  }
	| {
			tool: "put_sticker";
			id?: string;
			sticker?: string;
			x?: number;
			y?: number;
			size?: number;
			rotation?: number;
	  }
	| { tool: "delete_annotations"; ids: string[] }
	| { tool: "find_stickers"; query: string }
	| {
			tool: "arrange";
			cards: Placed[];
			regions: (Bounds & { id: string })[];
			annotations: Placed[];
	  }
	| ({
			tool: "create_region";
			cwd: string;
			name?: string;
			colour?: RegionColour;
	  } & Bounds)
	| ({
			tool: "update_region";
			id: string;
			name?: string;
			colour?: RegionColour | null;
	  } & Partial<Bounds>)
	| { tool: "delete_region"; id: string };

export type ToolName = ToolCall["tool"];

export type ToolDefinition = {
	name: ToolName;
	description: string;
	inputSchema: {
		type: "object";
		properties: Record<string, unknown>;
		required?: string[];
		additionalProperties: false;
	};
};

export const maxTranscriptEntries = 80;
export const maxQuestion = 2000;
export const maxPromptText = 8000;
export const maxArranged = 300;
export const maxCoordinate = 10_000_000;

const coordinate = { type: "number", description: "Board pixels" };
const size = { type: "number", minimum: 1, description: "Board pixels" };
const sessionRef = {
	type: "string",
	description: "A session's id or short id from board_snapshot",
};
const placed = {
	type: "object",
	properties: {
		id: { type: "string" },
		x: coordinate,
		y: coordinate,
		w: size,
		h: size,
	},
	required: ["id", "x", "y"],
	additionalProperties: false,
};
const regionBounds = {
	x: coordinate,
	y: coordinate,
	w: { type: "number", minimum: 96, maximum: 20000 },
	h: { type: "number", minimum: 96, maximum: 20000 },
};
const colour = {
	type: "string",
	enum: ["stone", "red", "amber", "green", "teal", "blue", "violet", "pink"],
};

const object = (
	properties: Record<string, unknown>,
	required: string[] = [],
): ToolDefinition["inputSchema"] => ({
	type: "object",
	properties,
	...(required.length > 0 ? { required } : {}),
	additionalProperties: false,
});

export const toolDefinitions: ToolDefinition[] = [
	{
		name: "board_snapshot",
		description:
			"Everything on the board: sessions with their card rectangles, activity and region, subagent counts, project regions, notes, stickers and where this comment thread is pinned.",
		inputSchema: object({}),
	},
	{
		name: "read_transcript",
		description:
			"The most recent entries of a session's transcript, oldest first, each shortened. Use it to report on what a session did.",
		inputSchema: object(
			{
				session: sessionRef,
				limit: {
					type: "integer",
					minimum: 1,
					maximum: maxTranscriptEntries,
					description: "How many entries, default 40",
				},
			},
			["session"],
		),
	},
	{
		name: "ask_session",
		description:
			"Ask a session a question and get its plain-text answer. It answers from a throwaway copy of its conversation that cannot run tools, so the real session is never disturbed. Takes up to a few minutes.",
		inputSchema: object(
			{
				session: sessionRef,
				question: { type: "string", maxLength: maxQuestion },
			},
			["session", "question"],
		),
	},
	{
		name: "send_prompt",
		description:
			"Send a prompt to a session on the user's behalf, as if they typed it and pressed Enter. Only for background sessions and sessions in a cmux pane. The text cannot start with !, / or #. Use only when the user asked for it.",
		inputSchema: object(
			{
				session: sessionRef,
				text: { type: "string", maxLength: maxPromptText },
			},
			["session", "text"],
		),
	},
	{
		name: "finish_session",
		description:
			"End a session the way the board's exit button does: the session is asked whether it is safe to exit and only exits if it says so. Never forces.",
		inputSchema: object({ session: sessionRef }, ["session"]),
	},
	{
		name: "start_session",
		description:
			"Start a new background Claude Code session in a directory with a first prompt. x and y place its card's top-left corner.",
		inputSchema: object(
			{
				cwd: { type: "string", description: "Absolute directory" },
				prompt: { type: "string", maxLength: maxPromptText },
				name: { type: "string", maxLength: 60 },
				x: coordinate,
				y: coordinate,
			},
			["cwd", "prompt"],
		),
	},
	{
		name: "put_note",
		description: `Create a sticky note (omit id; text, x and y required) or change one (give its id and only the fields to change). Text is GitHub-flavoured markdown, at most ${maxNoteText} characters. x and y are the top-left corner; omit w and h on a new note to size it to its text.`,
		inputSchema: object({
			id: { type: "string" },
			text: { type: "string", maxLength: maxNoteText },
			color: { type: "string", enum: [...noteColors] },
			x: coordinate,
			y: coordinate,
			w: { type: "number", minimum: 96, maximum: 1200 },
			h: { type: "number", minimum: 96, maximum: 1200 },
		}),
	},
	{
		name: "put_sticker",
		description:
			"Place a sticker (omit id; sticker, x and y required) or change one (give its id). Sticker ids come from find_stickers. size is the square side, default 96.",
		inputSchema: object({
			id: { type: "string" },
			sticker: { type: "string" },
			x: coordinate,
			y: coordinate,
			size: { type: "number", minimum: 32, maximum: 1200 },
			rotation: { type: "number", minimum: -180, maximum: 180 },
		}),
	},
	{
		name: "delete_annotations",
		description: "Delete notes and stickers by id.",
		inputSchema: object(
			{
				ids: {
					type: "array",
					items: { type: "string" },
					minItems: 1,
					maxItems: 100,
				},
			},
			["ids"],
		),
	},
	{
		name: "find_stickers",
		description:
			"Search the board's stickers by words such as 'done', 'bug' or 'party'. An empty query lists them all.",
		inputSchema: object({ query: { type: "string" } }),
	},
	{
		name: "arrange",
		description:
			"Move and resize many things in one call. cards: session or subagent cards by id (x, y top-left; w and h resize a session card). regions: project regions by id with their full bounds; cards inside do not follow, so move them too. annotations: notes and stickers by id.",
		inputSchema: object({
			cards: { type: "array", items: placed, maxItems: maxArranged },
			regions: {
				type: "array",
				items: object({ id: { type: "string" }, ...regionBounds }, [
					"id",
					"x",
					"y",
					"w",
					"h",
				]),
				maxItems: maxArranged,
			},
			annotations: { type: "array", items: placed, maxItems: maxArranged },
		}),
	},
	{
		name: "create_region",
		description:
			"Draw a project region: a named frame for one directory. Sessions under that directory whose card centre lies inside belong to it. colour applies to every frame of that directory.",
		inputSchema: object(
			{
				cwd: { type: "string", description: "Absolute directory" },
				name: { type: "string", maxLength: 60 },
				colour,
				...regionBounds,
			},
			["cwd", "x", "y", "w", "h"],
		),
	},
	{
		name: "update_region",
		description:
			"Rename, move or resize a project region (x, y, w and h together), or set its directory's colour (null for the default).",
		inputSchema: object(
			{
				id: { type: "string" },
				name: { type: "string", maxLength: 60 },
				colour: { anyOf: [colour, { type: "null" }] },
				...regionBounds,
			},
			["id"],
		),
	},
	{
		name: "delete_region",
		description: "Delete a project region. Its cards stay where they are.",
		inputSchema: object({ id: { type: "string" } }, ["id"]),
	},
];

const toolNames = new Set<string>(toolDefinitions.map((tool) => tool.name));

export const isToolName = (name: string): name is ToolName =>
	toolNames.has(name);

class Invalid extends Error {}

type Fields = Record<string, unknown>;

const fail = (message: string): never => {
	throw new Invalid(message);
};

const string = (fields: Fields, key: string, max: number): string => {
	const value = fields[key];
	if (typeof value !== "string" || value.trim() === "") {
		return fail(`${key} must be a non-empty string`);
	}
	if (value.length > max)
		return fail(`${key} must be at most ${max} characters`);
	return value;
};

const optional = <T>(
	fields: Fields,
	key: string,
	read: (fields: Fields, key: string) => T,
): T | undefined => (fields[key] === undefined ? undefined : read(fields, key));

const number = (
	fields: Fields,
	key: string,
	min = -maxCoordinate,
	max = maxCoordinate,
): number => {
	const value = fields[key];
	if (typeof value !== "number" || !Number.isFinite(value)) {
		return fail(`${key} must be a finite number`);
	}
	if (value < min || value > max) {
		return fail(`${key} must be between ${min} and ${max}`);
	}
	return value;
};

const records = (fields: Fields, key: string): Fields[] => {
	const value = fields[key] ?? [];
	if (!Array.isArray(value)) return fail(`${key} must be an array`);
	return value.map((item, index) =>
		typeof item === "object" && item !== null && !Array.isArray(item)
			? (item as Fields)
			: fail(`${key}[${index}] must be an object`),
	);
};

const sized = (fields: Fields, min: number, max: number) => {
	const w = optional(fields, "w", (f, k) => number(f, k, min, max));
	const h = optional(fields, "h", (f, k) => number(f, k, min, max));
	return {
		...(w === undefined ? {} : { w }),
		...(h === undefined ? {} : { h }),
	};
};

const placedItem = (fields: Fields, min: number, max: number): Placed => ({
	id: string(fields, "id", 128),
	x: number(fields, "x"),
	y: number(fields, "y"),
	...sized(fields, min, max),
});

const regionColour = (fields: Fields, key: string): RegionColour =>
	isRegionColour(fields[key])
		? fields[key]
		: fail(`${key} must be one of the region colours`);

const noteColour = (fields: Fields, key: string): NoteColor =>
	noteColors.includes(fields[key] as NoteColor)
		? (fields[key] as NoteColor)
		: fail(`${key} must be one of ${noteColors.join(", ")}`);

const name = (fields: Fields, key: string): string =>
	typeof fields[key] === "string" && fields[key].length <= 60
		? fields[key]
		: fail(`${key} must be a string of at most 60 characters`);

const regionSize = (fields: Fields, key: string) =>
	number(fields, key, 96, 20_000);

const defined = <T extends object>(value: T): T =>
	Object.fromEntries(
		Object.entries(value).filter(([, item]) => item !== undefined),
	) as T;

const readers: { [K in ToolName]: (fields: Fields) => ToolCall } = {
	board_snapshot: () => ({ tool: "board_snapshot" }),
	read_transcript: (fields) => ({
		tool: "read_transcript",
		session: string(fields, "session", 128),
		limit:
			optional(fields, "limit", (f, k) => {
				const limit = number(f, k, 1, maxTranscriptEntries);
				return Number.isInteger(limit)
					? limit
					: fail(`${k} must be an integer`);
			}) ?? 40,
	}),
	ask_session: (fields) => ({
		tool: "ask_session",
		session: string(fields, "session", 128),
		question: string(fields, "question", maxQuestion),
	}),
	send_prompt: (fields) => ({
		tool: "send_prompt",
		session: string(fields, "session", 128),
		text: string(fields, "text", maxPromptText),
	}),
	finish_session: (fields) => ({
		tool: "finish_session",
		session: string(fields, "session", 128),
	}),
	start_session: (fields) => {
		const x = optional(fields, "x", number);
		const y = optional(fields, "y", number);
		if ((x === undefined) !== (y === undefined)) {
			return fail("x and y go together");
		}
		return defined({
			tool: "start_session" as const,
			cwd: string(fields, "cwd", 4096),
			prompt: string(fields, "prompt", maxPromptText),
			name: optional(fields, "name", name),
			x,
			y,
		});
	},
	put_note: (fields) => {
		const id = optional(fields, "id", (f, k) => string(f, k, 64));
		const text = optional(fields, "text", (f, k) =>
			typeof f[k] === "string" && f[k].length <= maxNoteText
				? f[k]
				: fail(`${k} must be a string of at most ${maxNoteText} characters`),
		);
		const x = optional(fields, "x", number);
		const y = optional(fields, "y", number);
		if (
			id === undefined &&
			(text === undefined || x === undefined || y === undefined)
		) {
			return fail("A new note needs text, x and y");
		}
		return defined({
			tool: "put_note" as const,
			id,
			text,
			color: optional(fields, "color", noteColour),
			x,
			y,
			...sized(fields, 96, 1200),
		});
	},
	put_sticker: (fields) => {
		const id = optional(fields, "id", (f, k) => string(f, k, 64));
		const sticker = optional(fields, "sticker", (f, k) => string(f, k, 64));
		const x = optional(fields, "x", number);
		const y = optional(fields, "y", number);
		if (
			id === undefined &&
			(sticker === undefined || x === undefined || y === undefined)
		) {
			return fail("A new sticker needs sticker, x and y");
		}
		return defined({
			tool: "put_sticker" as const,
			id,
			sticker,
			x,
			y,
			size: optional(fields, "size", (f, k) => number(f, k, 32, 1200)),
			rotation: optional(fields, "rotation", (f, k) => number(f, k, -180, 180)),
		});
	},
	delete_annotations: (fields) => {
		const ids = fields.ids;
		if (!Array.isArray(ids) || ids.length === 0 || ids.length > 100) {
			return fail("ids must be an array of 1 to 100 ids");
		}
		return {
			tool: "delete_annotations",
			ids: ids.map((id) =>
				typeof id === "string" && id.length <= 64
					? id
					: fail("ids must be strings"),
			),
		};
	},
	find_stickers: (fields) => ({
		tool: "find_stickers",
		query:
			optional(fields, "query", (f, k) =>
				typeof f[k] === "string" && f[k].length <= 200
					? f[k]
					: fail(`${k} must be a string`),
			) ?? "",
	}),
	arrange: (fields) => {
		const cards = records(fields, "cards").map((item) =>
			placedItem(item, 24, 100_000),
		);
		const regions = records(fields, "regions").map((item) => ({
			id: string(item, "id", 64),
			x: number(item, "x"),
			y: number(item, "y"),
			w: regionSize(item, "w"),
			h: regionSize(item, "h"),
		}));
		const annotations = records(fields, "annotations").map((item) =>
			placedItem(item, 24, 2400),
		);
		const count = cards.length + regions.length + annotations.length;
		if (count === 0) return fail("Nothing to arrange");
		if (count > maxArranged) {
			return fail(`At most ${maxArranged} items per call`);
		}
		return { tool: "arrange", cards, regions, annotations };
	},
	create_region: (fields) =>
		defined({
			tool: "create_region" as const,
			cwd: string(fields, "cwd", 4096),
			name: optional(fields, "name", name),
			colour: optional(fields, "colour", regionColour),
			x: number(fields, "x"),
			y: number(fields, "y"),
			w: regionSize(fields, "w"),
			h: regionSize(fields, "h"),
		}),
	update_region: (fields) => {
		const bounds = ["x", "y", "w", "h"].filter(
			(key) => fields[key] !== undefined,
		);
		if (bounds.length > 0 && bounds.length < 4) {
			return fail("x, y, w and h go together");
		}
		const update = defined({
			tool: "update_region" as const,
			id: string(fields, "id", 64),
			name: optional(fields, "name", name),
			colour:
				fields.colour === null
					? null
					: optional(fields, "colour", regionColour),
			...(bounds.length === 4
				? {
						x: number(fields, "x"),
						y: number(fields, "y"),
						w: regionSize(fields, "w"),
						h: regionSize(fields, "h"),
					}
				: {}),
		});
		return Object.keys(update).length > 2 ? update : fail("Nothing to change");
	},
	delete_region: (fields) => ({
		tool: "delete_region",
		id: string(fields, "id", 64),
	}),
};

export const parseToolCall = (
	name: string,
	args: unknown,
): ToolCall | { error: string } => {
	if (!isToolName(name)) return { error: `Unknown tool ${name}` };
	const fields = args ?? {};
	if (typeof fields !== "object" || Array.isArray(fields)) {
		return { error: "Arguments must be an object" };
	}
	const allowed = Object.keys(
		toolDefinitions.find((tool) => tool.name === name)?.inputSchema
			.properties ?? {},
	);
	const unknown = Object.keys(fields).find((key) => !allowed.includes(key));
	if (unknown) return { error: `Unknown argument ${unknown}` };
	try {
		return readers[name](fields as Fields);
	} catch (error) {
		if (error instanceof Invalid) return { error: error.message };
		throw error;
	}
};
