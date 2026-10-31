import {
	type DocStore,
	noDigests,
	type Region,
	type Session,
} from "../shared/types.ts";
import { handbook } from "./handbook.ts";
import {
	minute,
	type Scenario,
	type Step,
	s,
	session,
	type World,
} from "./scenario.ts";

const card = { w: 312, h: 240 };
const regionPad = 24;
const regionLabel = 96;

type Seat = Pick<Session, "id" | "name" | "project" | "goal" | "doing"> &
	Partial<Session> & { x: number; y: number; worktree?: string };

const regionAround = (project: string, seats: { x: number; y: number }[]) => {
	const left = Math.min(...seats.map((seat) => seat.x));
	const top = Math.min(...seats.map((seat) => seat.y));
	const right = Math.max(...seats.map((seat) => seat.x + card.w));
	const bottom = Math.max(...seats.map((seat) => seat.y + card.h));
	return {
		id: `region-${project}`,
		cwd: `/Users/me/dev/${project}`,
		name: project,
		x: left - regionPad,
		y: top - regionPad - regionLabel,
		w: right - left + regionPad * 2,
		h: bottom - top + regionPad * 2 + regionLabel,
	} satisfies Region;
};

function board(
	start: number,
	seats: Seat[],
	extra: Partial<World> & Pick<World, "regions">,
): World {
	return {
		sessions: seats.map(({ x: _x, y: _y, worktree, ...seat }, order) =>
			session(start, {
				activity: "working",
				...seat,
				...(worktree
					? {
							cwd: `/Users/me/dev/${seat.project}/.claude/worktrees/${worktree}`,
						}
					: {}),
				startedAt: start - (40 - order * 5) * minute,
				updatedAt: start - (order + 1) * 20_000,
			}),
		),
		subagents: [],
		workflows: [],
		links: [],
		messages: [],
		relations: [],
		docs: {},
		layout: Object.fromEntries(
			seats.map((seat) => [
				`session:${seat.id}`,
				{ x: seat.x, y: seat.y, pinned: true as const },
			]),
		),
		colours: {},
		annotations: {},
		comments: [],
		digests: noDigests,
		stories: {},
		files: {},
		...extra,
	};
}

const orchestrator = "0c1a5e7d01";
const checkout = "0c1a5e7d02";

const linkSeats: Seat[] = [
	{
		id: orchestrator,
		name: "orders v3",
		project: "acme-api",
		goal: "Ship v3 of the orders API across four workers",
		doing: "Coordinating 4 background workers",
		x: 0,
		y: 0,
	},
	{
		id: "0c1a5e7d03",
		name: "worker: payments",
		project: "acme-api",
		worktree: "payments-v3",
		goal: "Port the /payments endpoints to v3",
		doing: "Running npm test -- payments",
		x: 0,
		y: 288,
	},
	{
		id: "0c1a5e7d04",
		name: "dark mode tokens",
		project: "acme-web",
		goal: "Move every colour to design tokens for dark mode",
		activity: "needs-you",
		doing: "Waiting for approval",
		needs: "Allow `npx stylelint --fix 'src/**/*.css'`?",
		x: 504,
		y: 0,
	},
	{
		id: checkout,
		name: "checkout redesign",
		project: "acme-web",
		goal: "Redesign the checkout summary for v3 totals",
		doing: "Editing src/checkout/Summary.tsx",
		x: 504,
		y: 288,
	},
];

const after = (seconds: number, run: Step["run"]): Step => ({
	at: Math.round(seconds * 1000),
	run,
});

export const links: Scenario = {
	world: (start) =>
		board(start, linkSeats, {
			regions: ["acme-api", "acme-web"].map((project) =>
				regionAround(
					project,
					linkSeats.filter((seat) => seat.project === project),
				),
			),
		}),
	timeline: [],
	linked: (from, to) =>
		from.kind === "session" && to.kind === "session"
			? [
					after(0.9, (stage) =>
						stage.message(
							s(from.id),
							s(to.id),
							"v3 totals now carry tax lines: read totals.tax.",
						),
					),
					after(2.4, (stage) =>
						stage.update(to.id, {
							doing: "Switching Summary.tsx to totals.tax",
						}),
					),
					after(3.6, (stage) =>
						stage.message(
							s(to.id),
							s(from.id),
							"Thanks. Summary.tsx now shows each tax line.",
						),
					),
				]
			: [],
};

const writer = "0c1a5e7d11";
const ordersWorker = "0c1a5e7d12";
const paymentsWorker = "0c1a5e7d13";

const docSeats: Seat[] = [
	{
		id: writer,
		name: "orders v3",
		project: "acme-api",
		goal: "Ship v3 of the orders API and keep its handbook current",
		doing: "Writing the v3 handbook",
		x: 0,
		y: 0,
	},
	{
		id: ordersWorker,
		name: "worker: orders",
		project: "acme-api",
		worktree: "orders-v3",
		goal: "Port the /orders endpoints to v3",
		doing: "Editing src/v3/orders/routes.ts",
		x: 0,
		y: 288,
	},
	{
		id: paymentsWorker,
		name: "worker: payments",
		project: "acme-api",
		worktree: "payments-v3",
		goal: "Port the /payments endpoints to v3",
		doing: "Running npm test -- payments",
		x: 696,
		y: 0,
	},
	{
		id: "0c1a5e7d14",
		name: "worker: load test",
		project: "acme-api",
		worktree: "load-v3",
		goal: "Load-test the v3 endpoints at twice peak traffic",
		activity: "needs-you",
		doing: "Waiting for approval",
		needs: "Allow `k6 run load/v3-orders.js` against staging?",
		x: 696,
		y: 288,
	},
];

const store: DocStore = {
	id: handbook.id,
	kind: "docs",
	title: handbook.title,
	x: 360,
	y: 120,
	w: 288,
	h: 288,
	z: 1,
};

const write = (seconds: number, by: string, path: string, text: string): Step =>
	after(seconds, (stage) => stage.write(store.id, path, text, by));

export const docs: Scenario = {
	world: (start) =>
		board(start, docSeats, {
			regions: [regionAround("acme-api", [...docSeats, store])],
			annotations: { [store.id]: store },
			docs: { [store.id]: [] },
			relations: [writer, ordersWorker, paymentsWorker].map((id, n) => ({
				id: `relation-d${n + 1}`,
				from: s(id),
				to: { kind: "docs", id: store.id },
				createdAt: start - (20 - n * 5) * minute,
			})),
		}),
	timeline: [
		write(0.6, writer, "index.md", handbook.draft),
		write(1.8, ordersWorker, "guides/orders.md", handbook.orders),
		write(3.0, paymentsWorker, "guides/payments.md", handbook.payments),
		write(4.2, writer, "assets/request-flow.svg", handbook.requestFlow),
		write(5.2, ordersWorker, "guides/migration.md", handbook.migration),
		write(6.2, writer, "guides/rollout.md", handbook.rollout),
		write(7.2, writer, "index.md", handbook.index),
	],
};
