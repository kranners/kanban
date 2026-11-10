// What processes on the hub's own machine send to queue a job, and the
// read-only view of the queue, its shadow log and each runner's enrolment.
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { RunnerView } from "../shared/runners.ts";
import type { JobsHttp } from "./http.ts";
import {
	type JobQueue,
	type JobShadow,
	maxJobInputBytes,
	parseJobClass,
} from "./jobQueue.ts";

export const jobsOffFile = (stateDir: string) => join(stateDir, "jobs-off");

const shadowKinds: readonly JobShadow["kind"][] = ["png", "test", "bytes"];
const maxDeadlineMs = 24 * 3600_000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const bytesOf = (value: unknown): Uint8Array | null =>
	typeof value === "string" && /^[A-Za-z0-9+/]*={0,2}$/.test(value)
		? Buffer.from(value, "base64")
		: null;

const bounded = (value: unknown, fallback: number, max: number): number =>
	typeof value === "number" && Number.isFinite(value) && value > 0
		? Math.min(Math.round(value), max)
		: fallback;

export const createJobsHttp = ({
	queue,
	offFile,
	runners,
}: {
	queue: JobQueue;
	offFile: string;
	runners: () => RunnerView[];
}): JobsHttp => ({
	submit(body) {
		if (!isRecord(body)) return { ok: false, error: "Send a JSON object" };
		if (existsSync(offFile)) {
			return { ok: false, error: `Offloading is off while ${offFile} exists` };
		}
		const jobClass = parseJobClass(body.class);
		if (!jobClass) return { ok: false, error: "Name the job's class" };
		const input = bytesOf(body.input);
		if (!input) return { ok: false, error: "Send the input as base64" };
		if (input.byteLength > maxJobInputBytes) {
			return {
				ok: false,
				error: `A job's input is at most ${maxJobInputBytes} bytes`,
			};
		}
		const shadow = isRecord(body.shadow) ? body.shadow : null;
		const kind = shadowKinds.find((known) => known === shadow?.kind);
		if (shadow && !kind) {
			return { ok: false, error: "A shadow's kind is png, test or bytes" };
		}
		const reference =
			shadow?.reference === undefined ? null : bytesOf(shadow.reference);
		if (shadow && shadow.reference !== undefined && !reference) {
			return { ok: false, error: "Send the shadow's reference as base64" };
		}
		return queue.submit({
			class: jobClass,
			input,
			personal: body.personal !== false,
			expectedMs: bounded(body.expectedMs, 60_000, maxDeadlineMs),
			deadlineMs: bounded(body.deadlineMs, 3600_000, maxDeadlineMs),
			maxAttempts: bounded(body.maxAttempts, 3, 10),
			source:
				typeof body.source === "string" && /^[\w .:/-]{1,80}$/.test(body.source)
					? body.source
					: "unnamed",
			shadow: kind
				? {
						kind,
						referenceMs:
							typeof shadow?.referenceMs === "number" &&
							Number.isFinite(shadow.referenceMs)
								? Math.round(shadow.referenceMs)
								: null,
					}
				: null,
			reference,
		});
	},
	view() {
		return {
			off: existsSync(offFile),
			offFile,
			counts: queue.counts(),
			jobs: queue.recent(50),
			events: queue.events(100),
			shadows: queue.shadows(50),
			runners: runners()
				.filter((view) => !view.local)
				.map((view) => ({
					id: view.id,
					state: view.state,
					enrolment: view.enrolment ?? "shared-token",
					protocol: view.protocol ?? null,
					update: view.update ?? null,
					jobs: view.jobs ?? null,
				})),
		};
	},
});
