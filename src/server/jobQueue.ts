// The durable queue of jobs the hub hands to runners. A job is bytes in, bytes
// out, run by a class's fixed command that each runner's own machine config
// lists. A runner holds a lease on the attempt it runs, renewed by each
// heartbeat that reports the job; a lease not renewed for leaseMs lapses and
// the job is queued again with the next attempt number, so a late result from
// the old attempt is dropped. Kept in SQLite in the hub's state folder, so a
// hub restart keeps every job: leased ones get a fresh lease window, which the
// runners' first heartbeats renew.
import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type {
	RunnerJob,
	RunnerJobResult,
	RunnerRunningJob,
} from "../shared/runners.ts";

export const jobLeaseMs = 15_000;
export const maxJobInputBytes = 8 * 1024 ** 2;
export const maxJobOutputBytes = 16 * 1024 ** 2;
const keepFinishedMs = 7 * 24 * 3600_000;
const keepBlobsMs = 24 * 3600_000;
const classPattern = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export type JobState = "queued" | "leased" | "done" | "failed" | "expired";

export type JobShadow = {
	/** How the hub judges the result against today's: png, test or bytes. */
	kind: "png" | "test" | "bytes";
	/** How long today's path took for the same input. */
	referenceMs: number | null;
};

export type JobSpec = {
	class: string;
	input: Uint8Array;
	personal: boolean;
	/** Roughly how long it runs, for placement; short work is at most a minute. */
	expectedMs: number;
	/** From submission. */
	deadlineMs: number;
	maxAttempts: number;
	source: string;
	shadow: JobShadow | null;
	/** Today's result for the same input, to compare with. */
	reference: Uint8Array | null;
};

export type QueuedJob = {
	id: string;
	class: string;
	personal: boolean;
	expectedMs: number;
	attempt: number;
	excluded: string[];
	createdAt: number;
};

export type JobRow = {
	id: string;
	class: string;
	inputHash: string;
	personal: boolean;
	state: JobState;
	attempt: number;
	leaseHolder: string | null;
	leaseUntil: number | null;
	ranOn: string | null;
	ms: number | null;
	error: string | null;
	source: string;
	createdAt: number;
	updatedAt: number;
	shadow: JobShadow | null;
};

export type JobEvent = {
	at: number;
	job: string;
	kind: string;
	runner: string | null;
	attempt: number;
	detail: string | null;
};

export type ShadowEntry = {
	at: number;
	job: string;
	class: string;
	runner: string;
	kind: JobShadow["kind"];
	match: boolean;
	detail: string;
	runnerMs: number;
	referenceMs: number | null;
};

export type ShadowVerdict = { match: boolean; detail: string };

export type ResultOutcome = "accepted" | "late" | "unknown";

export type JobQueue = {
	submit(
		spec: JobSpec,
	): { ok: true; id: string } | { ok: false; error: string };
	/** Queued jobs, oldest first. */
	waiting(): QueuedJob[];
	/** Gives a queued job's current attempt to a runner; null when it isn't queued. */
	lease(id: string, runner: string): RunnerJob["job"] | null;
	/** Renews what a runner reports running; answers the ids it should stop. */
	renew(runner: string, running: readonly RunnerRunningJob[]): string[];
	result(
		runner: string,
		id: string,
		attempt: number,
		result: RunnerJobResult,
	): ResultOutcome;
	/** Lapses leases and gives up on jobs past their deadline. */
	sweep(): void;
	leasesHeldBy(runner: string): number;
	recent(limit?: number): JobRow[];
	events(limit?: number): JobEvent[];
	shadows(limit?: number): ShadowEntry[];
	counts(): Record<JobState, number>;
	close(): void;
};

export type JobQueueOptions = {
	file: string;
	now?: () => number;
	newId?: () => string;
	leaseMs?: number;
	log?: (line: string) => void;
	compare?: (
		kind: JobShadow["kind"],
		output: Uint8Array,
		reference: Uint8Array | null,
	) => ShadowVerdict;
};

const sha256 = (bytes: Uint8Array) =>
	createHash("sha256").update(bytes).digest("hex");

const short = (id: string) => id.slice(0, 8);

export const parseJobClass = (value: unknown): string | null =>
	typeof value === "string" && classPattern.test(value) ? value : null;

type Raw = Record<string, unknown>;

const rowOf = (raw: Raw): JobRow => ({
	id: String(raw.id),
	class: String(raw.class),
	inputHash: String(raw.input_hash),
	personal: raw.personal === 1,
	state: raw.state as JobState,
	attempt: Number(raw.attempt),
	leaseHolder: (raw.lease_holder as string | null) ?? null,
	leaseUntil: (raw.lease_until as number | null) ?? null,
	ranOn: (raw.ran_on as string | null) ?? null,
	ms: (raw.ms as number | null) ?? null,
	error: (raw.error as string | null) ?? null,
	source: String(raw.source),
	createdAt: Number(raw.created_at),
	updatedAt: Number(raw.updated_at),
	shadow: raw.shadow ? (JSON.parse(String(raw.shadow)) as JobShadow) : null,
});

export const createJobQueue = ({
	file,
	now = Date.now,
	newId = randomUUID,
	leaseMs = jobLeaseMs,
	log = () => {},
	compare = () => ({ match: false, detail: "no comparison" }),
}: JobQueueOptions): JobQueue => {
	const db = new DatabaseSync(file);
	db.exec(`
		PRAGMA journal_mode = WAL;
		CREATE TABLE IF NOT EXISTS jobs (
			id TEXT PRIMARY KEY,
			class TEXT NOT NULL,
			input BLOB,
			input_hash TEXT NOT NULL,
			personal INTEGER NOT NULL,
			expected_ms INTEGER NOT NULL,
			deadline INTEGER NOT NULL,
			max_attempts INTEGER NOT NULL,
			attempt INTEGER NOT NULL,
			state TEXT NOT NULL,
			lease_holder TEXT,
			lease_until INTEGER,
			excluded TEXT NOT NULL DEFAULT '[]',
			source TEXT NOT NULL,
			shadow TEXT,
			reference BLOB,
			output BLOB,
			error TEXT,
			ms INTEGER,
			ran_on TEXT,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL
		);
		CREATE INDEX IF NOT EXISTS jobs_state ON jobs (state, created_at);
		CREATE TABLE IF NOT EXISTS events (
			at INTEGER NOT NULL,
			job TEXT NOT NULL,
			kind TEXT NOT NULL,
			runner TEXT,
			attempt INTEGER NOT NULL,
			detail TEXT
		);
		CREATE TABLE IF NOT EXISTS shadows (
			at INTEGER NOT NULL,
			job TEXT NOT NULL,
			class TEXT NOT NULL,
			runner TEXT NOT NULL,
			kind TEXT NOT NULL,
			match INTEGER NOT NULL,
			detail TEXT NOT NULL,
			runner_ms INTEGER NOT NULL,
			reference_ms INTEGER
		);
	`);

	const event = (
		job: string,
		kind: string,
		runner: string | null,
		attempt: number,
		detail: string | null,
	) => {
		db.prepare(
			"INSERT INTO events (at, job, kind, runner, attempt, detail) VALUES (?, ?, ?, ?, ?, ?)",
		).run(now(), job, kind, runner, attempt, detail);
	};

	const get = (id: string): Raw | undefined =>
		db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as Raw | undefined;

	const requeue = (raw: Raw, why: string, exclude: string | null) => {
		const attempt = Number(raw.attempt);
		const excluded = JSON.parse(String(raw.excluded)) as string[];
		if (exclude && !excluded.includes(exclude)) excluded.push(exclude);
		const id = String(raw.id);
		if (attempt >= Number(raw.max_attempts)) {
			db.prepare(
				"UPDATE jobs SET state = 'failed', lease_holder = NULL, lease_until = NULL, error = ?, excluded = ?, updated_at = ? WHERE id = ?",
			).run(
				`${why}; gave up after ${attempt} attempts`,
				JSON.stringify(excluded),
				now(),
				id,
			);
			event(id, "failed", exclude, attempt, why);
			log(
				`jobs: ${raw.class} ${short(id)} failed after ${attempt} attempts: ${why}`,
			);
			return;
		}
		db.prepare(
			"UPDATE jobs SET state = 'queued', attempt = attempt + 1, lease_holder = NULL, lease_until = NULL, excluded = ?, updated_at = ? WHERE id = ?",
		).run(JSON.stringify(excluded), now(), id);
		event(id, "requeued", exclude, attempt + 1, why);
		log(
			`jobs: ${raw.class} ${short(id)} requeued as attempt ${attempt + 1}: ${why}`,
		);
	};

	const prune = () => {
		const at = now();
		db.prepare(
			"DELETE FROM jobs WHERE state NOT IN ('queued', 'leased') AND updated_at < ?",
		).run(at - keepFinishedMs);
		db.prepare(
			"UPDATE jobs SET input = NULL, output = NULL, reference = NULL WHERE state NOT IN ('queued', 'leased') AND updated_at < ?",
		).run(at - keepBlobsMs);
		db.prepare("DELETE FROM events WHERE at < ?").run(at - keepFinishedMs);
		db.prepare("DELETE FROM shadows WHERE at < ?").run(
			at - 30 * keepFinishedMs,
		);
	};

	const rebuilt = db
		.prepare("UPDATE jobs SET lease_until = ? WHERE state = 'leased'")
		.run(now() + leaseMs).changes;
	const waitingAtStart = (
		db
			.prepare("SELECT count(*) AS n FROM jobs WHERE state = 'queued'")
			.get() as {
			n: number;
		}
	).n;
	log(
		`jobs: queue at ${file}, ${waitingAtStart} waiting, ${rebuilt} leases kept for ${leaseMs / 1000} s for their runners to report`,
	);
	prune();
	let prunedAt = now();

	return {
		submit(spec) {
			if (!classPattern.test(spec.class)) {
				return {
					ok: false,
					error:
						"A job class is lower case letters, digits, dot, dash or underscore",
				};
			}
			if (spec.input.byteLength > maxJobInputBytes) {
				return {
					ok: false,
					error: `A job's input is at most ${maxJobInputBytes} bytes`,
				};
			}
			const id = newId();
			const at = now();
			db.prepare(
				`INSERT INTO jobs (id, class, input, input_hash, personal, expected_ms, deadline, max_attempts, attempt, state, source, shadow, reference, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 'queued', ?, ?, ?, ?, ?)`,
			).run(
				id,
				spec.class,
				spec.input,
				sha256(spec.input),
				spec.personal ? 1 : 0,
				spec.expectedMs,
				at + spec.deadlineMs,
				spec.maxAttempts,
				spec.source,
				spec.shadow ? JSON.stringify(spec.shadow) : null,
				spec.reference,
				at,
				at,
			);
			event(id, "queued", null, 1, spec.source);
			log(
				`jobs: ${spec.class} ${short(id)} queued from ${spec.source}${spec.personal ? ", personal" : ""}${spec.shadow ? ", shadow" : ""}`,
			);
			return { ok: true, id };
		},
		waiting() {
			return (
				db
					.prepare(
						"SELECT id, class, personal, expected_ms, attempt, excluded, created_at FROM jobs WHERE state = 'queued' ORDER BY created_at",
					)
					.all() as Raw[]
			).map((raw) => ({
				id: String(raw.id),
				class: String(raw.class),
				personal: raw.personal === 1,
				expectedMs: Number(raw.expected_ms),
				attempt: Number(raw.attempt),
				excluded: JSON.parse(String(raw.excluded)) as string[],
				createdAt: Number(raw.created_at),
			}));
		},
		lease(id, runner) {
			const raw = get(id);
			if (!raw || raw.state !== "queued" || raw.input === null) return null;
			const attempt = Number(raw.attempt);
			db.prepare(
				"UPDATE jobs SET state = 'leased', lease_holder = ?, lease_until = ?, updated_at = ? WHERE id = ?",
			).run(runner, now() + leaseMs, now(), id);
			event(id, "leased", runner, attempt, null);
			log(
				`jobs: ${raw.class} ${short(id)} attempt ${attempt} leased to ${runner}`,
			);
			return {
				id,
				class: String(raw.class),
				attempt,
				deadline: Number(raw.deadline),
				input: Buffer.from(raw.input as Uint8Array).toString("base64"),
			};
		},
		renew(runner, running) {
			const stop: string[] = [];
			for (const { id, attempt } of running) {
				const raw = get(id);
				if (
					raw?.state === "leased" &&
					raw.lease_holder === runner &&
					Number(raw.attempt) === attempt
				) {
					db.prepare("UPDATE jobs SET lease_until = ? WHERE id = ?").run(
						now() + leaseMs,
						id,
					);
				} else {
					stop.push(id);
				}
			}
			return stop;
		},
		result(runner, id, attempt, result) {
			const raw = get(id);
			if (!raw) return "unknown";
			if (
				raw.state !== "leased" ||
				raw.lease_holder !== runner ||
				Number(raw.attempt) !== attempt
			) {
				event(
					id,
					"late",
					runner,
					attempt,
					`now ${raw.state} at attempt ${raw.attempt}`,
				);
				log(
					`jobs: ${raw.class} ${short(id)} late result from ${runner} for attempt ${attempt} dropped (the job is ${raw.state} at attempt ${raw.attempt})`,
				);
				return "late";
			}
			if (!result.ok) {
				if (result.refused) {
					requeue(raw, `${runner} refused: ${result.error}`, runner);
				} else if (result.requeue) {
					requeue(raw, `${runner} gave it back: ${result.error}`, null);
				} else {
					requeue(raw, `${runner} failed: ${result.error}`, null);
				}
				return "accepted";
			}
			const output = Buffer.from(result.output, "base64");
			db.prepare(
				"UPDATE jobs SET state = 'done', output = ?, ms = ?, ran_on = ?, lease_holder = NULL, lease_until = NULL, error = NULL, updated_at = ? WHERE id = ?",
			).run(output, Math.round(result.ms), runner, now(), id);
			event(id, "done", runner, attempt, `${Math.round(result.ms)} ms`);
			log(
				`jobs: ${raw.class} ${short(id)} attempt ${attempt} done on ${runner} in ${Math.round(result.ms)} ms`,
			);
			const shadow = raw.shadow
				? (JSON.parse(String(raw.shadow)) as JobShadow)
				: null;
			if (shadow) {
				const reference = raw.reference
					? new Uint8Array(raw.reference as Uint8Array)
					: null;
				let verdict: ShadowVerdict;
				try {
					verdict = compare(shadow.kind, output, reference);
				} catch (error) {
					verdict = {
						match: false,
						detail: `comparison failed: ${(error as Error).message}`,
					};
				}
				db.prepare(
					"INSERT INTO shadows (at, job, class, runner, kind, match, detail, runner_ms, reference_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
				).run(
					now(),
					id,
					String(raw.class),
					runner,
					shadow.kind,
					verdict.match ? 1 : 0,
					verdict.detail,
					Math.round(result.ms),
					shadow.referenceMs,
				);
				log(
					`jobs: shadow ${raw.class} ${short(id)} on ${runner}: ${verdict.match ? "match" : "differs"} (${verdict.detail}), ${runner} ${Math.round(result.ms)} ms, today's path ${shadow.referenceMs === null ? "not timed" : `${shadow.referenceMs} ms`}`,
				);
			}
			return "accepted";
		},
		sweep() {
			const at = now();
			for (const raw of db
				.prepare(
					"SELECT * FROM jobs WHERE state = 'leased' AND lease_until < ?",
				)
				.all(at) as Raw[]) {
				event(
					String(raw.id),
					"lapsed",
					raw.lease_holder as string,
					Number(raw.attempt),
					null,
				);
				requeue(
					raw,
					`lease lapsed on ${raw.lease_holder}, no heartbeat for ${leaseMs / 1000} s`,
					null,
				);
			}
			for (const raw of db
				.prepare(
					"SELECT * FROM jobs WHERE state IN ('queued', 'leased') AND deadline < ?",
				)
				.all(at) as Raw[]) {
				db.prepare(
					"UPDATE jobs SET state = 'expired', lease_holder = NULL, lease_until = NULL, updated_at = ? WHERE id = ?",
				).run(at, raw.id as string);
				event(String(raw.id), "expired", null, Number(raw.attempt), null);
				log(
					`jobs: ${raw.class} ${short(String(raw.id))} passed its deadline unfinished`,
				);
			}
			if (at - prunedAt > 3600_000) {
				prunedAt = at;
				prune();
			}
		},
		leasesHeldBy(runner) {
			return (
				db
					.prepare(
						"SELECT count(*) AS n FROM jobs WHERE state = 'leased' AND lease_holder = ?",
					)
					.get(runner) as { n: number }
			).n;
		},
		recent(limit = 50) {
			return (
				db
					.prepare(
						"SELECT id, class, input_hash, personal, state, attempt, lease_holder, lease_until, ran_on, ms, error, source, created_at, updated_at, shadow FROM jobs ORDER BY updated_at DESC LIMIT ?",
					)
					.all(limit) as Raw[]
			).map(rowOf);
		},
		events(limit = 100) {
			return (
				db
					.prepare("SELECT * FROM events ORDER BY at DESC, rowid DESC LIMIT ?")
					.all(limit) as Raw[]
			).map((raw) => ({
				at: Number(raw.at),
				job: String(raw.job),
				kind: String(raw.kind),
				runner: (raw.runner as string | null) ?? null,
				attempt: Number(raw.attempt),
				detail: (raw.detail as string | null) ?? null,
			}));
		},
		shadows(limit = 50) {
			return (
				db
					.prepare("SELECT * FROM shadows ORDER BY at DESC, rowid DESC LIMIT ?")
					.all(limit) as Raw[]
			).map((raw) => ({
				at: Number(raw.at),
				job: String(raw.job),
				class: String(raw.class),
				runner: String(raw.runner),
				kind: raw.kind as JobShadow["kind"],
				match: raw.match === 1,
				detail: String(raw.detail),
				runnerMs: Number(raw.runner_ms),
				referenceMs: (raw.reference_ms as number | null) ?? null,
			}));
		},
		counts() {
			const counts: Record<JobState, number> = {
				queued: 0,
				leased: 0,
				done: 0,
				failed: 0,
				expired: 0,
			};
			for (const raw of db
				.prepare("SELECT state, count(*) AS n FROM jobs GROUP BY state")
				.all() as Raw[]) {
				counts[raw.state as JobState] = Number(raw.n);
			}
			return counts;
		},
		close() {
			db.close();
		},
	};
};
