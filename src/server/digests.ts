import { createHash } from "node:crypto";
import type {
	Digests,
	ProjectDigest,
	Session,
	SessionDigest,
	TranscriptEntry,
} from "../shared/types.ts";
import type { Summary } from "../web/summaries.ts";
import { lastLine } from "./ansi.ts";
import { asNumber, asObject, asString, truncate } from "./ingest/json.ts";
import { createStateFile, readState } from "./stateFile.ts";

export const digestTickMs = 20_000;
export const minIntervalMs = 120_000;
export const failurePauseMs = 300_000;
export const digestTimeoutMs = 90_000;
const recentEntries = 10;
const entryChars = 300;
const transcriptLimit = 40;

const digestPrompt = [
	"You summarise Claude Code sessions for a kanban board that shows many sessions at once.",
	"You are given one project's sessions, labelled s1, s2 and so on, with each one's goal, state, tasks, recent steps and the last few turns of its conversation.",
	"Answer with:",
	"- narrative: one to three sentences of markdown saying what is being done across these sessions overall and how it is going. Bold the one or two things that matter most. No headings. Never write the labels s1, s2 and so on; name a session by the work it is doing.",
	"- sessions: one entry per session, by its label, with:",
	"  - now: one short sentence on what the session is doing right now.",
	"  - progress: one short sentence on how far along it is towards its goal.",
	"  - stuck: if the session looks stuck, because it keeps repeating the same step, keeps failing the same way, or is blocked on something it cannot fix itself, one short sentence saying why. Otherwise an empty string. A session waiting on the user is not stuck, and neither is one that has merely gone quiet.",
	"Be concrete and terse. Use only what the input shows.",
].join("\n");

const digestSchema = {
	type: "object",
	properties: {
		narrative: { type: "string" },
		sessions: {
			type: "array",
			items: {
				type: "object",
				properties: {
					id: { type: "string" },
					now: { type: "string" },
					progress: { type: "string" },
					stuck: { type: "string" },
				},
				required: ["id", "now", "progress", "stuck"],
				additionalProperties: false,
			},
		},
	},
	required: ["narrative", "sessions"],
	additionalProperties: false,
};

export const digestArgs = (input: string): string[] => [
	"-p",
	"--model",
	"haiku",
	"--no-session-persistence",
	"--tools",
	"",
	"--strict-mcp-config",
	"--permission-mode",
	"dontAsk",
	"--settings",
	JSON.stringify({ disableAllHooks: true }),
	"--setting-sources",
	"",
	"--disable-slash-commands",
	"--output-format",
	"json",
	"--json-schema",
	JSON.stringify(digestSchema),
	"--system-prompt",
	digestPrompt,
	"--",
	input,
];

const clock = (at: number): string =>
	new Date(at).toLocaleTimeString("en-GB", {
		hour: "2-digit",
		minute: "2-digit",
	});

const taskMarks = { completed: "x", in_progress: ">", pending: " " } as const;

const conversationOf = (entries: readonly TranscriptEntry[]): string[] =>
	entries
		.filter((entry) => entry.role !== "tool")
		.slice(-recentEntries)
		.map(
			(entry) =>
				`- ${clock(entry.at)} ${entry.role}: ${truncate(entry.text.replace(/\s+/g, " ").trim(), entryChars)}`,
		);

const memberInput = (
	label: string,
	session: Session,
	entries: readonly TranscriptEntry[],
): string => {
	const done = session.tasks.filter((t) => t.status === "completed").length;
	const conversation = conversationOf(entries);
	return [
		`${label}: ${session.name}`,
		`State: ${session.activity} · updated ${clock(session.updatedAt)}`,
		session.goal && `Goal: ${session.goal}`,
		session.doing && `Doing: ${session.doing}`,
		session.activity === "needs-you" &&
			session.needs &&
			`Needs you: ${session.needs}`,
		session.tasks.length > 0 && `Tasks: ${done}/${session.tasks.length} done`,
		...session.tasks.map(
			(task) => `- [${taskMarks[task.status]}] ${task.subject}`,
		),
		session.steps.length > 0 && "Recent steps:",
		...session.steps.map((step) => `- ${clock(step.at)} ${step.text}`),
		conversation.length > 0 && "Conversation:",
		...conversation,
	]
		.filter((line) => typeof line === "string")
		.join("\n");
};

export const digestInput = (
	unit: Summary,
	entries: ReadonlyMap<string, readonly TranscriptEntry[]>,
	now: number,
): string =>
	[
		`Project: ${unit.project} (${unit.cwd})\nTime: ${clock(now)}`,
		...unit.sessions.map((session, index) =>
			memberInput(`s${index + 1}`, session, entries.get(session.id) ?? []),
		),
	].join("\n\n");

export const fingerprintOf = (unit: Summary): string =>
	createHash("sha1")
		.update(
			JSON.stringify([
				unit.key,
				...unit.sessions.map((s) => [
					s.id,
					s.activity,
					s.doing,
					s.needs,
					s.goal,
					s.tasks.map((t) => t.status + t.subject),
					s.steps.map((step) => step.text),
				]),
			]),
		)
		.digest("hex");

export type Digest = {
	narrative: ProjectDigest;
	sessions: Record<string, SessionDigest>;
};

export type DigestResult =
	| ({ ok: true } & Digest)
	| { ok: false; error: string };

const failed = (reason: string, detail: string): DigestResult => ({
	ok: false,
	error: detail ? `${reason}: ${detail}` : reason,
});

export const parseDigest = (
	stdout: string,
	stderr: string,
	ids: readonly string[],
	at: number,
): DigestResult => {
	let result: unknown;
	try {
		result = JSON.parse(stdout);
	} catch {
		return failed("Could not digest", lastLine(`${stdout}\n${stderr}`));
	}
	const record = asObject(result) ?? {};
	const answer = asObject(record.structured_output);
	const narrative = asString(answer?.narrative)?.trim() ?? "";
	if (record.is_error === true || !narrative) {
		return failed(
			"The digest came back empty",
			lastLine(asString(record.result) ?? `${stdout}\n${stderr}`),
		);
	}
	const sessions: Record<string, SessionDigest> = {};
	const entries = Array.isArray(answer?.sessions) ? answer.sessions : [];
	for (const entry of entries.map(asObject)) {
		const label = /^\s*s(\d+)\s*$/i.exec(asString(entry?.id) ?? "");
		const id = label ? ids[Number(label[1]) - 1] : undefined;
		if (!id) continue;
		sessions[id] = {
			at,
			now: asString(entry?.now)?.trim() ?? "",
			progress: asString(entry?.progress)?.trim() ?? "",
			stuck: asString(entry?.stuck)?.trim() || null,
		};
	}
	return { ok: true, narrative: { at, narrative }, sessions };
};

export type DigestEntry = {
	fingerprint: string;
	ranAt: number;
	narrative: ProjectDigest;
	sessions: Record<string, SessionDigest>;
};

export type DigestCache = Record<string, DigestEntry>;

const parseSessionDigest = (value: unknown): SessionDigest | null => {
	const record = asObject(value);
	const at = asNumber(record?.at);
	const now = asString(record?.now);
	const progress = asString(record?.progress);
	const stuck = record?.stuck;
	if (at === null || now === null || progress === null) return null;
	if (stuck !== null && typeof stuck !== "string") return null;
	return { at, now, progress, stuck };
};

const parseNarrative = (value: unknown): ProjectDigest | null => {
	const record = asObject(value);
	const at = asNumber(record?.at);
	const narrative = asString(record?.narrative);
	return at === null || narrative === null ? null : { at, narrative };
};

const parseEntry = (value: unknown): DigestEntry | null => {
	const record = asObject(value);
	const fingerprint = asString(record?.fingerprint);
	const ranAt = asNumber(record?.ranAt);
	const narrative = parseNarrative(record?.narrative);
	const sessions = asObject(record?.sessions);
	if (fingerprint === null || ranAt === null || narrative === null || !sessions)
		return null;
	return {
		fingerprint,
		ranAt,
		narrative,
		sessions: Object.fromEntries(
			Object.entries(sessions).flatMap(([id, digest]) => {
				const parsed = parseSessionDigest(digest);
				return parsed ? [[id, parsed]] : [];
			}),
		),
	};
};

export const parseDigestCache = (value: unknown): DigestCache =>
	Object.fromEntries(
		Object.entries(asObject(value) ?? {}).flatMap(([key, entry]) => {
			const parsed = parseEntry(entry);
			return parsed ? [[key, parsed]] : [];
		}),
	);

export const loadDigests = (file: string): Promise<DigestCache> =>
	readState(file, parseDigestCache);

export type DigestRun = (
	args: string[],
) => Promise<{ ok: boolean; stdout: string; stderr: string }>;

export type DigesterDeps = {
	units: () => Summary[];
	transcript: (id: string, limit: number) => Promise<TranscriptEntry[]>;
	run: DigestRun;
	watching: () => boolean;
	file: string;
	initial: DigestCache;
	now: () => number;
	onChange: (digests: Digests) => void;
};

export type Digester = {
	pump(): Promise<void>;
	current(): Digests;
	saved(): Promise<void>;
};

const needsAttention = (unit: Summary): boolean =>
	unit.sessions.some(
		(s) => s.activity === "needs-you" || s.activity === "working",
	);

const latest = (unit: Summary): number =>
	Math.max(...unit.sessions.map((s) => s.updatedAt));

const mostPressing = (units: readonly Summary[]): Summary | undefined =>
	[...units].sort(
		(a, b) =>
			Number(needsAttention(b)) - Number(needsAttention(a)) ||
			latest(b) - latest(a),
	)[0];

export const createDigester = (deps: DigesterDeps): Digester => {
	const stored = createStateFile<DigestCache>(deps.file);
	let cache: DigestCache = { ...deps.initial };
	let running = false;
	let pausedUntil = 0;

	const current = (): Digests => {
		const units = deps.units();
		const present = new Set(
			units.flatMap((unit) => unit.sessions.map((s) => s.id)),
		);
		const projects: Digests["projects"] = {};
		const sessions: Digests["sessions"] = {};
		for (const [key, entry] of Object.entries(cache)) {
			projects[key] = entry.narrative;
			for (const [id, digest] of Object.entries(entry.sessions)) {
				const previous = sessions[id];
				if (present.has(id) && (!previous || previous.at < digest.at))
					sessions[id] = digest;
			}
		}
		return { projects, sessions };
	};

	const changed = () => {
		stored.write(cache);
		deps.onChange(current());
	};

	const prune = (units: readonly Summary[]) => {
		const keys = new Set(units.map((unit) => unit.key));
		const kept = Object.entries(cache).filter(([key]) => keys.has(key));
		if (kept.length === Object.keys(cache).length) return;
		cache = Object.fromEntries(kept);
		changed();
	};

	const digestOne = async (): Promise<boolean> => {
		const now = deps.now();
		const units = deps.units();
		prune(units);
		const unit = mostPressing(
			units.filter((unit) => {
				const entry = cache[unit.key];
				return (
					(!entry || entry.fingerprint !== fingerprintOf(unit)) &&
					now - (entry?.ranAt ?? -Infinity) >= minIntervalMs
				);
			}),
		);
		if (!unit) return false;
		const ids = unit.sessions.map((s) => s.id);
		const entries = new Map(
			await Promise.all(
				ids.map(
					async (id) =>
						[id, await deps.transcript(id, transcriptLimit)] as const,
				),
			),
		);
		const { stdout, stderr } = await deps.run(
			digestArgs(digestInput(unit, entries, now)),
		);
		const result = parseDigest(stdout, stderr, ids, now);
		if (!result.ok) {
			console.error(`kanban digests: ${result.error}`);
			pausedUntil = now + failurePauseMs;
			return false;
		}
		cache[unit.key] = {
			fingerprint: fingerprintOf(unit),
			ranAt: now,
			narrative: result.narrative,
			sessions: result.sessions,
		};
		changed();
		return true;
	};

	const pump = async (): Promise<void> => {
		if (running || deps.now() < pausedUntil || !deps.watching()) return;
		running = true;
		let digested = false;
		try {
			digested = await digestOne();
		} catch (error) {
			console.error(`kanban digests: ${(error as Error).message}`);
			pausedUntil = deps.now() + failurePauseMs;
		} finally {
			running = false;
		}
		if (digested) await pump();
	};

	return { pump, current, saved: () => stored.saved() };
};
