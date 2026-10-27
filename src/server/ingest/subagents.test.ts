import assert from "node:assert/strict";
import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { Subagent } from "../../shared/types.ts";
import { createFacts } from "./records.ts";
import {
	abandoned,
	type FoundSubagent,
	newestPerSession,
	scanSubagents,
	settleSubagents,
	subagentLimit,
	subagentWindowMs,
} from "./subagents.ts";

function found(
	id: string,
	sessionId: string,
	updatedAt: number,
	state: Partial<Subagent> = {},
	teammate = false,
): FoundSubagent {
	return {
		transcriptPath: `/agents/${id}.jsonl`,
		teammate,
		workflowRun: null,
		subagent: {
			id,
			sessionId,
			parentAgentId: null,
			type: "general-purpose",
			description: id,
			live: false,
			done: false,
			startedAt: 0,
			updatedAt,
			...state,
		},
	};
}

test("keeps the newest subagents of each session up to the limit", () => {
	const many = Array.from({ length: subagentLimit + 20 }, (_, i) =>
		found(`a${i}`, "busy", i),
	);
	const shown = newestPerSession([...many, found("quiet", "calm", 0)]);
	const busy = shown.filter(({ subagent }) => subagent.sessionId === "busy");
	assert.equal(busy.length, subagentLimit);
	assert.equal(busy.at(-1)?.subagent.id, "a20");
	assert.ok(shown.some(({ subagent }) => subagent.id === "quiet"));
});

test("a subagent waiting on a tool is working; one any transcript finished is done", () => {
	const parent = createFacts();
	parent.finishedTasks.add("nested");
	const blocked = createFacts();
	blocked.tools.set("t1", { name: "Bash", input: {} });
	const settled = settleSubagents(
		[
			found("parent", "s", 1),
			found("nested", "s", 1, { parentAgentId: "parent" }),
			found("blocked", "s", 1),
			found("finished", "s", 1, { done: true }),
		],
		new Map([
			["/agents/parent.jsonl", parent],
			["/agents/blocked.jsonl", blocked],
			["/agents/nested.jsonl", createFacts()],
		]),
	);
	assert.deepEqual(
		settled.map(({ subagent }) => [subagent.id, subagent.live, subagent.done]),
		[
			["parent", false, false],
			["nested", false, true],
			["blocked", true, false],
			["finished", false, true],
		],
	);
});

test("a subagent of a workflow run that ended has returned", () => {
	const lead = createFacts();
	lead.finishedTasks.add("wf_ended");
	const inRun = (id: string, run: string): FoundSubagent => ({
		...found(id, "s", Date.now(), { live: true }),
		transcriptPath: `/s/subagents/workflows/${run}/agent-${id}.jsonl`,
	});
	const settled = settleSubagents(
		[inRun("stopped", "wf_ended"), inRun("running", "wf_live")],
		new Map([["/lead.jsonl", lead]]),
	);
	assert.deepEqual(
		settled.map(({ subagent }) => [subagent.id, subagent.live, subagent.done]),
		[
			["stopped", false, true],
			["running", true, false],
		],
	);
});

test("an abandoned subagent is no longer awaited", () => {
	const { subagent } = abandoned(found("orphan", "s", 1, { live: true }));
	assert.deepEqual([subagent.live, subagent.done], [false, true]);
});

test("an idle teammate has returned; a busy one is still running", () => {
	const settled = settleSubagents(
		[
			found("resting", "s", 1, {}, true),
			found("typing", "s", 1, { live: true }, true),
		],
		new Map(),
	);
	assert.deepEqual(
		settled.map(({ subagent }) => [subagent.id, subagent.live, subagent.done]),
		[
			["resting", false, true],
			["typing", true, false],
		],
	);
});

const scratch = mkdtempSync(join(tmpdir(), "kanban-subagents-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

test("keeps an old subagent while a recent descendant of it still works", () => {
	const dir = join(scratch, "subagents");
	mkdirSync(join(dir, "workflows", "wf_run"), { recursive: true });
	const agent = (path: string, meta: object, ageMs: number) => {
		writeFileSync(join(dir, `${path}.meta.json`), JSON.stringify(meta));
		writeFileSync(join(dir, `${path}.jsonl`), "");
		const at = (Date.now() - ageMs) / 1000;
		utimesSync(join(dir, `${path}.jsonl`), at, at);
	};
	const old = subagentWindowMs + 5 * 60_000;
	agent("agent-parent", { agentType: "general-purpose" }, old);
	agent(
		"agent-child",
		{ agentType: "general-purpose", parentAgentId: "parent" },
		3000,
	);
	agent("agent-stale", { agentType: "general-purpose" }, old);
	agent(
		"workflows/wf_run/agent-step",
		{ agentType: "workflow-subagent" },
		3000,
	);
	agent(
		"agent-mate",
		{ agentType: "helper", taskKind: "in_process_teammate" },
		3000,
	);
	const scanned = scanSubagents({
		dir,
		sessionId: "s",
		finishedTasks: new Set(),
		now: Date.now(),
		cache: new Map(),
	});
	assert.deepEqual(
		scanned
			.map(({ subagent, teammate, workflowRun }) => [
				subagent.id,
				teammate,
				workflowRun,
			])
			.sort(),
		[
			["child", false, null],
			["mate", true, null],
			["parent", false, null],
			["step", false, "wf_run"],
		],
	);
});
