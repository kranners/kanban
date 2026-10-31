import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Activity, Board, Session } from "../shared/types.ts";
import {
	asObject,
	asString,
	asTime,
	parseJson,
	truncate,
} from "./ingest/json.ts";
import { activityOf, type Job, readJobs } from "./ingest/registry.ts";

export type TimelineEntry = { at: number; state: string; detail: string };

export type SessionHistory = {
	id: string;
	short: string | null;
	name: string;
	cwd: string;
	kind: string;
	activity: Activity;
	onBoard: boolean;
	needs: string | null;
	goal: string | null;
	doing: string | null;
	startedAt: number;
	updatedAt: number;
	tasks: { subject: string; status: string }[];
	timeline: TimelineEntry[];
	lastMessage: string | null;
};

export type Commit = { sha: string; at: string; subject: string };
export type Landed = { repo: string; ref: string; commits: Commit[] };

export type GitLog = (cwd: string, since: number) => Promise<Landed | null>;

export type HistoryDeps = {
	homes: () => string[];
	board: () => Board;
	gitLog: GitLog;
};

const blockersFirst: readonly Activity[] = [
	"needs-you",
	"failed",
	"working",
	"watching",
	"idle",
	"stopped",
	"done",
];
const timelineShown = 12;
const messageShown = 600;
const detailShown = 160;
const sessionsShown = 60;
const commitsShown = 20;
const commitsRead = 50;
export const historyBudget = 36_000;
const landedBudget = 8000;
const minSessionBudget = 400;
const fieldShown = 240;

export const readTimeline = async (
	home: string,
	short: string,
	since: number,
): Promise<{ timeline: TimelineEntry[]; lastMessage: string | null }> => {
	let text: string;
	try {
		text = await readFile(join(home, "jobs", short, "timeline.jsonl"), "utf8");
	} catch {
		return { timeline: [], lastMessage: null };
	}
	const timeline: TimelineEntry[] = [];
	let lastMessage: string | null = null;
	for (const line of text.split("\n")) {
		const record = asObject(parseJson(line));
		const at = asTime(record?.at);
		if (!record || at === null || at < since) continue;
		const state = asString(record.state) ?? "unknown";
		const detail = truncate(asString(record.detail) ?? "", detailShown);
		const previous = timeline.at(-1);
		if (previous?.state !== state || previous.detail !== detail) {
			timeline.push({ at, state, detail });
		}
		lastMessage = asString(record.text) ?? lastMessage;
	}
	return {
		timeline: timeline.slice(-timelineShown),
		lastMessage: lastMessage && truncate(lastMessage, messageShown),
	};
};

const fromBoard = (session: Session, since: number): SessionHistory => ({
	id: session.id,
	short: session.short,
	name: session.name,
	cwd: session.cwd,
	kind: session.cloud ? "cloud" : session.kind,
	activity: session.activity,
	onBoard: true,
	needs: session.needs,
	goal: session.goal,
	doing: session.doing,
	startedAt: session.startedAt,
	updatedAt: session.updatedAt,
	tasks: session.tasks.map(({ subject, status }) => ({ subject, status })),
	timeline: session.steps
		.filter((step) => step.at >= since)
		.slice(-timelineShown)
		.map((step) => ({ at: step.at, state: "step", detail: step.text })),
	lastMessage: null,
});

const fromJob = (job: Job): SessionHistory => ({
	id: job.sessionId,
	short: job.short,
	name: job.name ?? job.short,
	cwd: job.cwd,
	kind: "background",
	activity: activityOf(null, job),
	onBoard: false,
	needs: job.needs,
	goal: job.intent,
	doing: job.detail,
	startedAt: job.createdAt,
	updatedAt: job.updatedAt,
	tasks: [],
	timeline: [],
	lastMessage: null,
});

const isActive = (session: Session, since: number) =>
	session.updatedAt >= since ||
	session.activity === "needs-you" ||
	session.activity === "working";

const repoOf = (cwd: string): string =>
	cwd.split("/.claude/worktrees/")[0] ?? cwd;

const iso = (at: number) => new Date(at).toISOString();

const clock = (at: number) =>
	new Date(at).toLocaleString("en-GB", {
		weekday: "short",
		day: "numeric",
		month: "short",
		hour: "2-digit",
		minute: "2-digit",
	});

export const sessionBlock = (session: SessionHistory): string => {
	const where = session.onBoard ? "on the board" : "ended, off the board";
	const tasks = session.tasks.map(
		(task) => `${task.status === "completed" ? "[x]" : "[ ]"} ${task.subject}`,
	);
	return [
		`## ${session.name}${session.short ? ` (${session.short})` : ""}: ${session.activity}, ${where}`,
		`${session.kind} in ${session.cwd}, started ${clock(session.startedAt)}, last active ${clock(session.updatedAt)}`,
		session.needs && `Needs: ${truncate(session.needs, fieldShown * 2)}`,
		session.goal && `Goal: ${truncate(session.goal, fieldShown)}`,
		session.doing && `Doing: ${truncate(session.doing, fieldShown)}`,
		tasks.length > 0 && `Tasks: ${tasks.join("; ")}`,
		session.timeline.length > 0 &&
			`Timeline: ${session.timeline.map((entry) => `${clock(entry.at)} ${entry.state}: ${entry.detail}`).join(" | ")}`,
		session.lastMessage && `Last message: ${session.lastMessage}`,
	]
		.filter(Boolean)
		.join("\n");
};

export const landedBlock = (landed: Landed[]): string =>
	landed.length === 0
		? "## Landed\nNo commits reached a main branch in these repositories."
		: [
				"## Landed",
				...landed.map((log) =>
					[
						`${log.repo} (${log.ref}):`,
						...log.commits
							.slice(0, commitsShown)
							.map(
								(commit) => `- ${commit.sha} ${commit.at} ${commit.subject}`,
							),
						...(log.commits.length > commitsShown
							? [
									`- and ${log.commits.length - commitsShown}${log.commits.length >= commitsRead ? " or more" : ""} more`,
								]
							: []),
					].join("\n"),
				),
			].join("\n");

export const readHistory = async (
	deps: HistoryDeps,
	since: number,
): Promise<string> => {
	const sessions = new Map<string, SessionHistory>();
	for (const session of deps.board().sessions) {
		if (isActive(session, since)) {
			sessions.set(session.id, fromBoard(session, since));
		}
	}
	for (const home of deps.homes()) {
		for (const job of readJobs(home)) {
			if (job.updatedAt < since) continue;
			const known = sessions.get(job.sessionId) ?? fromJob(job);
			const { timeline, lastMessage } = await readTimeline(
				home,
				job.short,
				since,
			);
			sessions.set(job.sessionId, {
				...known,
				needs: known.needs ?? job.needs,
				timeline: timeline.length > 0 ? timeline : known.timeline,
				lastMessage,
			});
		}
	}
	const ordered = [...sessions.values()]
		.sort(
			(a, b) =>
				blockersFirst.indexOf(a.activity) - blockersFirst.indexOf(b.activity) ||
				b.updatedAt - a.updatedAt,
		)
		.slice(0, sessionsShown);
	const repos = [...new Set(ordered.map((session) => repoOf(session.cwd)))];
	const landed = (
		await Promise.all(repos.map((repo) => deps.gitLog(repo, since)))
	).filter(
		(log, index, all): log is Landed =>
			log !== null &&
			log.commits.length > 0 &&
			all.findIndex((other) => other?.repo === log.repo) === index,
	);
	const heading = `${sessions.size} sessions active since ${iso(since)}${sessions.size > ordered.length ? `, showing ${ordered.length}` : ""}, blockers first. Times are local.`;
	const landedText = truncate(landedBlock(landed), landedBudget);
	const each = Math.max(
		minSessionBudget,
		Math.floor(
			(historyBudget - heading.length - landedText.length) /
				Math.max(1, ordered.length),
		) - 2,
	);
	return truncate(
		[
			heading,
			landedText,
			...ordered.map((session) => truncate(sessionBlock(session), each)),
		].join("\n\n"),
		historyBudget,
	);
};

const git = (cwd: string, args: string[]): Promise<string | null> =>
	new Promise((resolve) => {
		execFile(
			"git",
			["-C", cwd, ...args],
			{ timeout: 10_000, maxBuffer: 1024 * 1024 },
			(error, stdout) => resolve(error ? null : stdout),
		);
	});

const mainRefs = ["origin/HEAD", "origin/main", "origin/master"];

export const gitMainLog: GitLog = async (cwd, since) => {
	for (const ref of mainRefs) {
		if ((await git(cwd, ["rev-parse", "--verify", "--quiet", ref])) === null) {
			continue;
		}
		const log = await git(cwd, [
			"log",
			ref,
			`--since=@${Math.floor(since / 1000)}`,
			`--max-count=${commitsRead}`,
			"--format=%h%x09%ct%x09%s",
		]);
		const common = await git(cwd, [
			"rev-parse",
			"--path-format=absolute",
			"--git-common-dir",
		]);
		if (log === null || common === null) return null;
		const commits = log
			.split("\n")
			.filter(Boolean)
			.map((line) => {
				const [sha = "", seconds = "", ...subject] = line.split("\t");
				return {
					sha,
					at: clock(Number(seconds) * 1000),
					subject: subject.join("\t"),
				};
			});
		return { repo: common.trim().replace(/\/\.git$/, ""), ref, commits };
	}
	return null;
};
