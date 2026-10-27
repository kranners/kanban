import { defaultRegionColour } from "../shared/colours.ts";
import type {
	Layout,
	Link,
	Message,
	Note,
	Region,
	Session,
	Subagent,
} from "../shared/types.ts";
import {
	a,
	minute,
	type Scenario,
	type Stage,
	type Step,
	s,
	session,
	subagent,
	type Turn,
	type World,
} from "./scenario.ts";

type Project = {
	project: string;
	x: number;
	y: number;
	w: number;
	h: number;
};

const card = { w: 312, h: 240 };
const rowPitch = 288;
const unitGap = 24;
const subagentPitch = 84;
const regionPad = 24;
const regionLabel = 96;

const projects = {
	api: { project: "acme-api", x: 0, y: 0, w: 1272, h: 816 },
	web: { project: "acme-web", x: 1416, y: 0, w: 672, h: 816 },
	mobile: { project: "acme-mobile", x: 2232, y: 0, w: 672, h: 816 },
	data: { project: "acme-data", x: 0, y: 1056, w: 1272, h: 528 },
	infra: { project: "acme-infra", x: 1416, y: 1056, w: 672, h: 528 },
	docs: { project: "acme-docs", x: 2232, y: 1056, w: 672, h: 528 },
} satisfies Record<string, Project>;

type Seat = {
	id: string;
	in: Project;
	col: number;
	row: number;
	worktree?: string;
} & Partial<Session> &
	Pick<Session, "name">;

const id = (n: number) => `${(0x5eed_0000 + n).toString(16)}a1`;

const columns = [0, 360, 600, 960];

const seats: Seat[] = [
	{
		id: id(1),
		in: projects.api,
		col: 0,
		row: 0,
		name: "orders v3",
		goal: "Ship v3 of the orders API across four workers",
		activity: "working",
		doing: "Coordinating 4 background workers",
	},
	{
		id: id(2),
		in: projects.api,
		col: 2,
		row: 0,
		name: "/bg rollout review",
		goal: "Review the v3 rollout plan in the background",
		activity: "idle",
		doing: "Wrote review notes on the rollout plan",
	},
	{
		id: id(3),
		in: projects.api,
		col: 3,
		row: 0,
		name: "flaky webhook test",
		goal: "Fix the flaky webhook retry test",
		activity: "working",
		doing: "Running npm test -- webhooks --repeat 50",
	},
	{
		id: id(4),
		in: projects.api,
		col: 0,
		row: 1,
		worktree: "orders-v3",
		name: "worker: orders",
		goal: "Port the /orders endpoints to v3",
		activity: "working",
		doing: "Editing src/v3/orders/routes.ts",
	},
	{
		id: id(5),
		in: projects.api,
		col: 2,
		row: 1,
		worktree: "payments-v3",
		name: "worker: payments",
		goal: "Port the /payments endpoints to v3",
		activity: "working",
		doing: "Running npm test -- payments",
	},
	{
		id: id(6),
		in: projects.api,
		col: 0,
		row: 2,
		worktree: "load-v3",
		name: "worker: load test",
		goal: "Load-test the v3 endpoints at twice peak traffic",
		activity: "working",
		doing: "Writing load/v3-orders.js",
	},
	{
		id: id(7),
		in: projects.api,
		col: 2,
		row: 2,
		worktree: "contracts-v3",
		name: "worker: contracts",
		goal: "Write consumer contract tests for v3",
		activity: "working",
		doing: "Generating contracts/payments.json",
	},
	{
		id: id(8),
		in: projects.web,
		col: 0,
		row: 0,
		name: "checkout redesign",
		goal: "Redesign the checkout summary for v3 totals",
		kind: "interactive",
		short: null,
		attachable: false,
		cmux: true,
		activity: "working",
		doing: "Editing src/checkout/Summary.tsx",
	},
	{
		id: id(9),
		in: projects.web,
		col: 0,
		row: 1,
		name: "dark mode tokens",
		goal: "Move every colour to design tokens for dark mode",
		activity: "needs-you",
		doing: "Waiting for approval",
		needs: "Allow `npx stylelint --fix 'src/**/*.css'`?",
	},
	{
		id: id(10),
		in: projects.web,
		col: 1,
		row: 1,
		name: "hydration warning",
		goal: "Fix the hydration warning on the product page",
		activity: "done",
		doing: "Opened pull request #1207",
	},
	{
		id: id(11),
		in: projects.web,
		col: 0,
		row: 2,
		name: "a11y sweep",
		goal: "Fix accessibility violations in checkout",
		activity: "failed",
		doing: "axe found 14 violations; build failed",
	},
	{
		id: id(12),
		in: projects.web,
		col: 1,
		row: 2,
		name: "storybook 10",
		goal: "Upgrade Storybook to 10",
		activity: "working",
		doing: "Running npx storybook@10 upgrade",
	},
	{
		id: id(13),
		in: projects.mobile,
		col: 0,
		row: 0,
		name: "offline cart",
		goal: "Keep the cart in sync while offline",
		activity: "working",
		doing: "Editing src/cart/sync.ts",
	},
	{
		id: id(14),
		in: projects.mobile,
		col: 0,
		row: 1,
		name: "push opt-in",
		goal: "Ask for push permission after the first order",
		activity: "needs-you",
		doing: "Asked a question",
		needs: "When should the app ask for push permission?",
	},
	{
		id: id(15),
		in: projects.mobile,
		col: 1,
		row: 1,
		name: "android 16 crash",
		goal: "Fix the crash on launch on Android 16",
		activity: "working",
		doing: "Reading crash logs from Play Console",
	},
	{
		id: id(16),
		in: projects.mobile,
		col: 0,
		row: 2,
		name: "release 4.2",
		goal: "Ship 4.2 to TestFlight",
		activity: "done",
		doing: "Uploaded build 4.2 (417)",
	},
	{
		id: id(18),
		in: projects.data,
		col: 0,
		row: 0,
		name: "nightly ETL",
		goal: "Make the nightly ETL resumable",
		activity: "working",
		doing: "Running dbt run --select staging",
	},
	{
		id: id(19),
		in: projects.data,
		col: 2,
		row: 0,
		name: "dedupe customers",
		goal: "Merge duplicate customer records",
		activity: "idle",
		doing: "Found 1,284 duplicate pairs",
	},
	{
		id: id(20),
		in: projects.data,
		col: 3,
		row: 0,
		name: "revenue dashboard",
		goal: "Rebuild the revenue dashboard on the new models",
		activity: "working",
		doing: "Editing models/marts/revenue.sql",
	},
	{
		id: id(21),
		in: projects.data,
		col: 0,
		row: 1,
		name: "warehouse costs",
		goal: "Explain the warehouse bill",
		kind: "interactive",
		short: null,
		attachable: false,
		activity: "idle",
		doing: "Explained last month's warehouse bill",
	},
	{
		id: id(23),
		in: projects.infra,
		col: 0,
		row: 0,
		name: "k8s 1.34",
		goal: "Upgrade the cluster to Kubernetes 1.34",
		activity: "working",
		doing: "Draining node pool general-a",
	},
	{
		id: id(24),
		in: projects.infra,
		col: 1,
		row: 0,
		name: "cdn rules",
		goal: "Cache product images at the edge",
		activity: "stopped",
		doing: "Stopped after terraform plan",
	},
	{
		id: id(25),
		in: projects.infra,
		col: 0,
		row: 1,
		name: "terraform drift",
		goal: "Reconcile drift in the staging account",
		activity: "needs-you",
		doing: "Waiting for approval",
		needs: "Allow `terraform apply` to fix 6 drifted resources in staging?",
	},
	{
		id: id(26),
		in: projects.infra,
		col: 1,
		row: 1,
		name: "cert rotation",
		goal: "Rotate the internal TLS certificates",
		activity: "working",
		doing: "Running cert-manager renew --all",
	},
	{
		id: id(27),
		in: projects.docs,
		col: 0,
		row: 0,
		name: "v3 API reference",
		goal: "Write the v3 API reference",
		activity: "working",
		doing: "Editing docs/api/v3/orders.md",
	},
	{
		id: id(28),
		in: projects.docs,
		col: 1,
		row: 0,
		name: "release notes",
		goal: "Draft the 2.9 release notes",
		activity: "done",
		doing: "Drafted release notes for 2.9",
	},
	{
		id: id(29),
		in: projects.docs,
		col: 0,
		row: 1,
		name: "onboarding guide",
		goal: "Refresh the contributor onboarding guide",
		activity: "needs-you",
		doing: "Waiting for approval",
		needs: "Allow `git push origin docs/onboarding`?",
	},
];

const arriving: Seat[] = [
	{
		id: id(17),
		in: projects.mobile,
		col: 1,
		row: 2,
		name: "hotfix 4.2.1",
		goal: "Hotfix the Android 16 launch crash",
		activity: "working",
		doing: "Bumping the version to 4.2.1",
	},
	{
		id: id(22),
		in: projects.data,
		col: 1,
		row: 1,
		name: "events backfill",
		goal: "Backfill a week of events after the ETL fix",
		activity: "working",
		doing: "Running dbt run --select events --full-refresh",
	},
];

const ids = Object.fromEntries(
	[...seats, ...arriving].map((seat) => [seat.name, seat.id]),
);

const sid = (name: string) => ids[name] ?? "";

type Helper = {
	id: string;
	parent: string;
	slot: number;
	type: string;
	description: string;
	state: "live" | "done" | "idle" | "later";
};

const helpers: Helper[] = [
	{
		id: "sa-split",
		parent: "orders v3",
		slot: 0,
		type: "Plan",
		description: "Split v3 into parallel work",
		state: "done",
	},
	{
		id: "sa-orders-map",
		parent: "worker: orders",
		slot: 0,
		type: "Explore",
		description: "Map the v2 order handlers",
		state: "done",
	},
	{
		id: "sa-orders-types",
		parent: "worker: orders",
		slot: 1,
		type: "general-purpose",
		description: "Generate v3 order types",
		state: "live",
	},
	{
		id: "sa-orders-tests",
		parent: "worker: orders",
		slot: 2,
		type: "general-purpose",
		description: "Port the order tests",
		state: "live",
	},
	{
		id: "sa-pay-map",
		parent: "worker: payments",
		slot: 0,
		type: "Explore",
		description: "Find every refund code path",
		state: "live",
	},
	{
		id: "sa-pay-idem",
		parent: "worker: payments",
		slot: 1,
		type: "code-reviewer",
		description: "Check idempotency keys",
		state: "later",
	},
	{
		id: "sa-load-script",
		parent: "worker: load test",
		slot: 0,
		type: "general-purpose",
		description: "Write the k6 scenarios",
		state: "live",
	},
	{
		id: "sa-load-baseline",
		parent: "worker: load test",
		slot: 1,
		type: "Explore",
		description: "Pull v2 latency baselines",
		state: "done",
	},
	{
		id: "sa-contract-orders",
		parent: "worker: contracts",
		slot: 0,
		type: "general-purpose",
		description: "Orders contract",
		state: "done",
	},
	{
		id: "sa-contract-pay",
		parent: "worker: contracts",
		slot: 1,
		type: "general-purpose",
		description: "Payments contract",
		state: "live",
	},
	{
		id: "sa-contract-verify",
		parent: "worker: contracts",
		slot: 2,
		type: "code-reviewer",
		description: "Verify against the web client",
		state: "later",
	},
	{
		id: "sa-checkout-review",
		parent: "checkout redesign",
		slot: 0,
		type: "code-reviewer",
		description: "Review the checkout diff",
		state: "live",
	},
	{
		id: "sa-checkout-shots",
		parent: "checkout redesign",
		slot: 1,
		type: "general-purpose",
		description: "Capture visual diffs",
		state: "idle",
	},
	{
		id: "sa-cart-conflicts",
		parent: "offline cart",
		slot: 0,
		type: "Plan",
		description: "Design conflict resolution",
		state: "done",
	},
	{
		id: "sa-cart-tests",
		parent: "offline cart",
		slot: 1,
		type: "general-purpose",
		description: "Write airplane-mode tests",
		state: "live",
	},
	{
		id: "sa-etl-checkpoints",
		parent: "nightly ETL",
		slot: 0,
		type: "Explore",
		description: "Find safe checkpoints",
		state: "done",
	},
	{
		id: "sa-etl-retry",
		parent: "nightly ETL",
		slot: 1,
		type: "general-purpose",
		description: "Add retries to the loaders",
		state: "live",
	},
	{
		id: "sa-backfill-verify",
		parent: "events backfill",
		slot: 0,
		type: "general-purpose",
		description: "Verify row counts per day",
		state: "later",
	},
];

const seatOf = (name: string) =>
	[...seats, ...arriving].find((seat) => seat.name === name);

const spot = (seat: Seat) => ({
	x: seat.in.x + (columns[seat.col] ?? 0),
	y: seat.in.y + seat.row * rowPitch,
});

const helperSpot = (helper: Helper) => {
	const seat = seatOf(helper.parent);
	const at = seat ? spot(seat) : { x: 0, y: 0 };
	return { x: at.x + card.w + unitGap, y: at.y + helper.slot * subagentPitch };
};

const cwdOf = (seat: Seat) =>
	seat.worktree
		? `/Users/me/dev/${seat.in.project}/.claude/worktrees/${seat.worktree}`
		: `/Users/me/dev/${seat.in.project}`;

const sessionOf = (start: number, seat: Seat, order: number): Session => {
	const {
		in: home,
		col: _col,
		row: _row,
		worktree: _worktree,
		...fields
	} = seat;
	return session(start, {
		...fields,
		project: home.project,
		cwd: cwdOf(seat),
		startedAt: start - (95 - order * 2) * minute,
		updatedAt: start - ((order * 7) % 23) * 20_000 - 15_000,
	});
};

const helperOf = (start: number, helper: Helper): Subagent =>
	subagent(start, {
		id: helper.id,
		sessionId: sid(helper.parent),
		type: helper.type,
		description: helper.description,
		live: helper.state === "live" || helper.state === "later",
		done: helper.state === "done",
		startedAt: start - 20 * minute,
		updatedAt:
			helper.state === "live" ? start - 25_000 : start - 6 * minute - 20_000,
	});

const spawned = (from: string, to: string): Link => ({
	from: s(sid(from)),
	to: s(sid(to)),
	kind: "spawned",
});

const regionOf = (home: Project): Region => ({
	id: `region-${home.project}`,
	cwd: `/Users/me/dev/${home.project}`,
	name: home.project,
	x: home.x - regionPad,
	y: home.y - regionPad - regionLabel,
	w: home.w + regionPad * 2,
	h: home.h + regionPad * 2 + regionLabel,
});

const orchestratorStory: Turn[] = [
	{
		user: "Ship v3 of the orders API. Split it across background workers and keep me posted.",
	},
	{
		thinking:
			"Four pieces can run in parallel: orders, payments, a load test and contract tests. Each gets its own worktree so they don't collide.",
	},
	{
		tool: "Task",
		input: {
			description: "Split v3 into parallel work",
			subagent_type: "Plan",
			prompt: "Split the v3 orders API work into independent pieces.",
		},
		result: "Four independent pieces: orders, payments, load test, contracts.",
		agentId: "sa-split",
	},
	{
		tool: "TodoWrite",
		input: {
			todos: [
				{ content: "Port /orders to v3", status: "in_progress" },
				{ content: "Port /payments to v3", status: "in_progress" },
				{ content: "Load-test v3 at 2x peak", status: "in_progress" },
				{ content: "Contract tests for v3", status: "in_progress" },
				{ content: "Merge and roll out", status: "pending" },
			],
		},
		result: "Todos updated",
	},
	...["orders", "payments", "load-test", "contracts"].map(
		(piece): Turn => ({
			tool: "Bash",
			input: {
				command: `claude --bg --worktree ${piece}-v3 "Own the v3 ${piece} work"`,
				description: `Start the ${piece} worker`,
			},
			result: `Started background session in .claude/worktrees/${piece}-v3`,
		}),
	),
	{ user: "/bg Review the rollout plan while the workers run" },
	{
		assistant:
			"Four workers are running, each in its own worktree, and a background fork is reviewing the rollout plan. I'll merge as their pull requests land.",
	},
];

const pushStory: Turn[] = [
	{ user: "Ask for push permission at a better moment than first launch." },
	{
		tool: "Grep",
		input: { pattern: "requestPermission", path: "src" },
		result: "Found 1 file\nsrc/notifications/permission.ts",
	},
	{
		assistant:
			"There are two good moments to ask. Which one fits the product better?",
	},
	{
		tool: "AskUserQuestion",
		input: {
			questions: [
				{
					question: "When should the app ask for push permission?",
					header: "Timing",
					multiSelect: false,
					options: [
						{
							label: "After the first order",
							description: "Ask once they have something to be notified about",
						},
						{
							label: "On the order status screen",
							description: "Ask when they first check delivery progress",
						},
					],
				},
			],
		},
	},
];

function world(start: number): World {
	const sessions = seats.map((seat, order) => sessionOf(start, seat, order));
	const subagents = helpers
		.filter((helper) => helper.state !== "later")
		.filter((helper) => seats.some((seat) => seat.name === helper.parent))
		.map((helper) => helperOf(start, helper));
	const layout: Layout = Object.fromEntries([
		...[...seats, ...arriving].map((seat) => [
			`session:${seat.id}`,
			{ ...spot(seat), pinned: true as const },
		]),
		...helpers.map((helper) => [`subagent:${helper.id}`, helperSpot(helper)]),
	]);
	const message = (
		n: number,
		from: string,
		to: string,
		ago: number,
		summary: string,
	): Message => ({
		id: `h${n}`,
		from: s(sid(from)),
		to: s(sid(to)),
		at: start - ago * minute,
		summary,
	});
	return {
		sessions,
		subagents,
		workflows: [
			{
				runId: "wf_contracts",
				sessionId: sid("worker: contracts"),
				name: "contract-tests",
				agents: ["sa-contract-orders", "sa-contract-pay", "sa-contract-verify"],
			},
		],
		links: [
			...subagents.map(
				(agent): Link => ({
					from: s(agent.sessionId),
					to: a(agent.id),
					kind: "subagent",
				}),
			),
			spawned("orders v3", "worker: orders"),
			spawned("orders v3", "worker: payments"),
			spawned("orders v3", "worker: load test"),
			spawned("orders v3", "worker: contracts"),
			{
				from: s(sid("orders v3")),
				to: s(sid("/bg rollout review")),
				kind: "forked",
			},
			spawned("checkout redesign", "a11y sweep"),
			spawned("nightly ETL", "dedupe customers"),
			{ from: s(sid("k8s 1.34")), to: s(sid("cert rotation")), kind: "forked" },
		],
		messages: [
			message(
				1,
				"orders v3",
				"worker: orders",
				40,
				"You own /orders. Keep v2 responses byte-identical.",
			),
			message(
				2,
				"worker: payments",
				"worker: contracts",
				22,
				"Refund amounts are now integers in cents.",
			),
			message(
				3,
				"checkout redesign",
				"orders v3",
				15,
				"Will v3 totals include tax lines?",
			),
			message(
				4,
				"orders v3",
				"checkout redesign",
				14,
				"Yes: totals.tax is an array of lines.",
			),
			message(
				5,
				"k8s 1.34",
				"nightly ETL",
				9,
				"Node pool general-a drains at 14:00.",
			),
		],
		layout,
		regions: Object.values(projects).map(regionOf),
		colours: {},
		annotations: {},
		comments: [],
		files: {},
		stories: {
			[`session:${sid("orders v3")}`]: orchestratorStory,
			[`session:${sid("push opt-in")}`]: pushStory,
		},
	};
}

const at = (seconds: number, run: (stage: Stage) => void): Step => ({
	at: Math.round(seconds * 1000),
	run,
});

const say = (seconds: number, from: string, to: string, summary: string) =>
	at(seconds, (stage) => stage.message(s(sid(from)), s(sid(to)), summary));

const set = (seconds: number, name: string, patch: Partial<Session>) =>
	at(seconds, (stage) => stage.update(sid(name), patch));

const spawn = (seconds: number, helperId: string) =>
	at(seconds, (stage) => {
		const helper = helpers.find((item) => item.id === helperId);
		if (helper)
			stage.spawn({
				...helperOf(Date.now(), helper),
				live: true,
				done: false,
				startedAt: Date.now(),
				updatedAt: Date.now(),
			});
	});

const finish = (seconds: number, helperId: string, summary: string) =>
	at(seconds, (stage) => stage.finish(helperId, summary));

const arrive = (seconds: number, name: string, parent: string) =>
	at(seconds, (stage) => {
		const seat = arriving.find((item) => item.name === name);
		if (!seat) return;
		stage.add(sessionOf(Date.now(), seat, 0), undefined, spawned(parent, name));
	});

const checklist: Note = {
	id: "launch-checklist",
	kind: "note",
	color: "yellow",
	text: "### v3 launch\n\n- [x] Orders ported\n- [x] Contract tests green\n- [ ] Payments ported\n- [ ] Load test at 2x peak\n- [ ] Docs live",
	x: projects.docs.x + 360,
	y: projects.docs.y + rowPitch,
	w: 288,
	h: 216,
	z: 1,
};

const webCwd = `/Users/me/dev/${projects.web.project}`;
const webColour = defaultRegionColour(webCwd) === "teal" ? "violet" : "teal";

const timeline: Step[] = [
	say(
		0.5,
		"worker: orders",
		"orders v3",
		"Orders endpoints ported; 41 of 41 contract checks pass.",
	),
	set(1.2, "worker: orders", { doing: "Running npm test -- orders" }),
	spawn(1.8, "sa-pay-idem"),
	say(
		2.6,
		"orders v3",
		"worker: load test",
		"Load-test staging at 2x peak, never production.",
	),
	set(3.2, "storybook 10", { doing: "Fixing 3 stories after the upgrade" }),
	finish(3.8, "sa-orders-types", "Generated 18 v3 order types."),
	set(4.4, "revenue dashboard", {
		activity: "needs-you",
		doing: "Waiting for approval",
		needs: "Run `dbt run --select marts.revenue` against the warehouse?",
	}),
	say(
		5.0,
		"checkout redesign",
		"orders v3",
		"Is currency always present on v3 totals?",
	),
	set(5.6, "flaky webhook test", { doing: "Reproduced: fails 3 of 50 runs" }),
	say(
		6.4,
		"orders v3",
		"checkout redesign",
		"Yes. v3 always returns currency with totals.",
	),
	arrive(7.0, "hotfix 4.2.1", "android 16 crash"),
	spawn(7.8, "sa-contract-verify"),
	say(
		8.6,
		"k8s 1.34",
		"nightly ETL",
		"Draining general-a now; pause the nightly ETL.",
	),
	set(9.2, "nightly ETL", { doing: "Paused for the node pool drain" }),
	set(9.8, "push opt-in", {
		activity: "working",
		doing: "Showing the prompt after the first order",
		needs: null,
	}),
	say(
		10.6,
		"nightly ETL",
		"k8s 1.34",
		"Paused. Ping me when the drain is done.",
	),
	set(12.0, "worker: load test", {
		activity: "needs-you",
		doing: "Waiting for approval",
		needs: "Allow `k6 run load/v3-orders.js` against staging?",
	}),
	say(
		12.8,
		"worker: contracts",
		"worker: payments",
		"Payments contract: 3 fields renamed, see contracts/payments.json.",
	),
	finish(13.4, "sa-pay-map", "Refunds go through 4 code paths; all covered."),
	set(14.0, "flaky webhook test", {
		activity: "failed",
		doing: "2 of 212 tests failed: webhook retry timing",
	}),
	say(
		14.8,
		"worker: payments",
		"worker: contracts",
		"Renamed fields updated in the payments handler.",
	),
	set(16.2, "storybook 10", {
		activity: "done",
		doing: "Upgraded to Storybook 10; 212 stories pass",
	}),
	say(
		16.8,
		"hotfix 4.2.1",
		"android 16 crash",
		"Version bumped; which commit has the fix?",
	),
	arrive(17.4, "events backfill", "nightly ETL"),
	say(
		18.2,
		"android 16 crash",
		"hotfix 4.2.1",
		"Cherry-pick 9f3c2e1: guards the null splash intent.",
	),
	set(18.8, "revenue dashboard", {
		activity: "working",
		doing: "Running dbt run --select marts.revenue",
		needs: null,
	}),
	spawn(19.4, "sa-backfill-verify"),
	say(
		20.0,
		"orders v3",
		"/bg rollout review",
		"Rollout plan v2 is in docs/rollout.md; review the canary steps.",
	),
	set(20.6, "k8s 1.34", { doing: "Upgrading the control plane" }),
	say(21.4, "k8s 1.34", "nightly ETL", "Drain finished. Safe to resume."),
	set(22.0, "nightly ETL", { doing: "Resuming from checkpoint 14 of 20" }),
	set(22.6, "worker: load test", {
		activity: "working",
		doing: "Running k6 at 2x peak",
		needs: null,
	}),
	say(
		23.2,
		"/bg rollout review",
		"orders v3",
		"Canary steps look right; add a rollback check at 25%.",
	),
	at(24.0, (stage) => stage.exit(sid("release notes"))),
	finish(24.6, "sa-orders-tests", "Ported 64 order tests; all pass on v3."),
	set(25.2, "worker: orders", {
		activity: "done",
		doing: "Opened pull request #913",
	}),
	say(25.8, "worker: orders", "orders v3", "PR #913 is up: /orders on v3."),
	at(26.2, (stage) => stage.colour(webCwd, webColour)),
	finish(
		26.6,
		"sa-contract-pay",
		"Payments contract verified against 3 consumers.",
	),
	set(27.2, "hotfix 4.2.1", {
		activity: "needs-you",
		doing: "Waiting for approval",
		needs: "Upload build 4.2.1 (418) to TestFlight?",
	}),
	say(
		27.8,
		"worker: contracts",
		"orders v3",
		"Contract tests green for orders and payments.",
	),
	finish(
		28.4,
		"sa-load-script",
		"k6 scenarios cover orders, refunds and search.",
	),
	finish(
		28.7,
		"sa-contract-verify",
		"The web client accepts every v3 response.",
	),
	set(29.0, "worker: contracts", {
		activity: "done",
		doing: "Opened pull request #915",
	}),
	say(
		29.6,
		"events backfill",
		"nightly ETL",
		"Backfilled 7 days; row counts match source.",
	),
	finish(30.2, "sa-backfill-verify", "Row counts match for all 7 days."),
	at(30.5, (stage) => stage.annotate({ [checklist.id]: checklist })),
	set(30.8, "events backfill", {
		activity: "done",
		doing: "Backfilled 7 days of events",
	}),
	finish(31.4, "sa-pay-idem", "Idempotency keys are checked on every write."),
	set(32.0, "worker: payments", {
		activity: "done",
		doing: "Opened pull request #914",
	}),
	say(32.6, "worker: payments", "orders v3", "PR #914 is up: /payments on v3."),
	say(
		33.4,
		"worker: load test",
		"orders v3",
		"p99 at 2x peak is 182 ms, under budget.",
	),
	set(34.0, "worker: load test", {
		activity: "done",
		doing: "p99 182 ms at 2x peak",
	}),
	say(
		34.6,
		"orders v3",
		"checkout redesign",
		"v3 is on staging. Point checkout at /v3.",
	),
	set(35.4, "orders v3", {
		activity: "needs-you",
		doing: "Waiting for approval",
		needs: "Merge PRs #913, #914 and #915 into main?",
	}),
	set(36.2, "checkout redesign", { doing: "Switching checkout to /v3" }),
];

export const headline: Scenario = { world, timeline };
