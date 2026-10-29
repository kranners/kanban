import type { Digests, NodeRef, SessionDigest } from "../shared/types.ts";
import {
	a,
	minute,
	type Scenario,
	s,
	session,
	subagent,
	type World,
} from "./scenario.ts";

const welcome = [
	"**This board is a demo.** The sessions are made up and nothing runs.",
	"",
	"- Click a card to open its conversation",
	"- Drag cards, or press **R** for a project region",
	"- Right-click the board for notes and stickers",
	"- Press **/** to ask the board agent",
].join("\n");

function digestsAt(start: number): Digests {
	const at = start - minute;
	const project = (narrative: string) => ({ at, narrative });
	const progress = (
		now: string,
		progress: string,
		stuck: string | null = null,
	): SessionDigest => ({ at, now, progress, stuck });
	return {
		projects: {
			"session:a1f0c2d4e5": project(
				"Auth work is nearly wrapped up: the **token refresh race is fixed** in #482 and the **stale-session sweep** is in testing. The orders migration is **waiting on you** to approve the staging run.",
			),
			"session:d4c3f5a6b8": project(
				"The checkout summary redesign is **going in circles on a type error**, and the accessibility sweep **failed its build** with 14 axe violations left.",
			),
			"session:a7f6c8e9f1": project(
				"Quiet: the staging network plan **stopped after terraform plan**, and last month's bill has been explained.",
			),
			"session:b8e7d9f0a2": project(
				"Release notes for 2.4 have **not started**; the changelog has been read.",
			),
		},
		sessions: {
			a1f0c2d4e5: progress(
				"Running the auth tests against the new hourly expiry sweep.",
				"Two of four tasks done; a pull request follows once tests pass.",
			),
			b2e1d3c4f6: progress(
				"Waiting for approval to run the staging migration.",
				"Schema and migration are written; only the staging run is left.",
			),
			c3d2e4f5a7: progress(
				"Finished and opened pull request #482.",
				"Done, waiting for review.",
			),
			d4c3f5a6b8: progress(
				"Editing Summary.tsx to add the currency field once more.",
				"Layout is done; the currency field still does not type-check.",
				"The same OrderSummary type error has come back after three edits.",
			),
			e5b4a6c7d9: progress(
				"Stopped after the build failed.",
				"Fixed 9 of 23 axe violations before the build broke.",
			),
			f6a5b7d8e0: progress(
				"Stopped after reviewing the terraform plan.",
				"The plan is ready; nothing has been applied.",
			),
			a7f6c8e9f1: progress(
				"Waiting for a follow-up question about the bill.",
				"Answered what it was asked.",
			),
			b8e7d9f0a2: progress(
				"Waiting for a prompt after reading the changelog.",
				"No notes drafted yet.",
			),
		},
	};
}

function world(start: number): World {
	const sessions = [
		session(start, {
			id: "a1f0c2d4e5",
			goal: "Expire stale auth sessions",
			name: "acme-api",
			project: "acme-api",
			activity: "working",
			doing: "Running npm test -- --filter auth",
			updatedAt: start - 20_000,
			tasks: [
				{
					id: "1",
					subject: "Find where sessions are stored",
					status: "completed",
					activeForm: null,
				},
				{
					id: "2",
					subject: "Add an expiry sweep",
					status: "completed",
					activeForm: null,
				},
				{
					id: "3",
					subject: "Test the sweep",
					status: "in_progress",
					activeForm: "Testing the sweep",
				},
				{
					id: "4",
					subject: "Open a pull request",
					status: "pending",
					activeForm: null,
				},
			],
			steps: [
				{ at: start - 6 * minute, text: "Read: src/auth/sessions.ts" },
				{ at: start - 4 * minute, text: "Edit: src/auth/sweep.ts" },
				{
					at: start - 2 * minute,
					text: "The sweep runs hourly; testing it now.",
				},
				{ at: start - 20_000, text: "Bash: npm test -- --filter auth" },
			],
		}),
		session(start, {
			id: "b2e1d3c4f6",
			goal: "Migrate the orders table to the new schema",
			name: "migrate orders table",
			project: "acme-api",
			activity: "needs-you",
			doing: "Waiting for approval",
			needs: "Approve running `npm run db:migrate -- --env staging`?",
			updatedAt: start - 3 * minute,
		}),
		session(start, {
			id: "c3d2e4f5a7",
			goal: "Fix the auth token refresh race",
			name: "auth hotfix",
			project: "acme-api",
			activity: "done",
			doing: "Opened pull request #482",
			updatedAt: start - 26 * minute,
		}),
		session(start, {
			id: "d4c3f5a6b8",
			goal: "Redesign the checkout summary",
			name: "acme-web",
			project: "acme-web",
			kind: "interactive",
			short: null,
			attachable: false,
			cmux: true,
			activity: "working",
			doing: "Editing src/checkout/Summary.tsx",
			updatedAt: start - 45_000,
		}),
		session(start, {
			id: "e5b4a6c7d9",
			goal: "Fix accessibility violations across the web app",
			name: "a11y sweep",
			project: "acme-web",
			activity: "failed",
			doing: "axe found 14 violations; build failed",
			updatedAt: start - 12 * minute,
		}),
		session(start, {
			id: "f6a5b7d8e0",
			goal: "Plan the staging network changes",
			name: "acme-infra",
			project: "acme-infra",
			activity: "stopped",
			doing: "Stopped after terraform plan",
			updatedAt: start - 3 * 60 * minute,
		}),
		session(start, {
			id: "a7f6c8e9f1",
			name: "cost report",
			project: "acme-infra",
			activity: "idle",
			doing: "Explained last month's bill",
			updatedAt: start - 50 * minute,
		}),
		session(start, {
			id: "b8e7d9f0a2",
			goal: "Draft release notes for 2.4 from the changelog",
			name: "release notes",
			project: "acme-docs",
			kind: "interactive",
			short: null,
			attachable: false,
			activity: "idle",
			doing: "Read CHANGELOG.md",
			updatedAt: start - 8 * minute,
		}),
	];
	const subagents = [
		subagent(start, {
			id: "sa-explore",
			sessionId: "a1f0c2d4e5",
			type: "Explore",
			description: "Map the auth middleware",
			live: true,
			updatedAt: start - 30_000,
		}),
		subagent(start, {
			id: "sa-tests",
			sessionId: "a1f0c2d4e5",
			type: "general-purpose",
			description: "Write session expiry tests",
			done: true,
		}),
		subagent(start, {
			id: "sa-sql",
			sessionId: "b2e1d3c4f6",
			type: "Plan",
			description: "Draft the backfill in batches",
		}),
		subagent(start, {
			id: "sa-review",
			sessionId: "d4c3f5a6b8",
			type: "code-reviewer",
			description: "Review checkout flow changes",
			live: true,
			updatedAt: start - 60_000,
		}),
	];
	const message = (
		id: string,
		from: NodeRef,
		to: NodeRef,
		ago: number,
		summary: string,
	) => ({ id, from, to, at: start - ago, summary });
	return {
		sessions,
		subagents,
		workflows: [],
		links: [
			{ from: s("a1f0c2d4e5"), to: a("sa-explore"), kind: "subagent" },
			{ from: s("a1f0c2d4e5"), to: a("sa-tests"), kind: "subagent" },
			{ from: s("a1f0c2d4e5"), to: s("b2e1d3c4f6"), kind: "spawned" },
			{ from: s("a1f0c2d4e5"), to: s("c3d2e4f5a7"), kind: "forked" },
			{ from: s("b2e1d3c4f6"), to: a("sa-sql"), kind: "subagent" },
			{ from: s("d4c3f5a6b8"), to: a("sa-review"), kind: "subagent" },
			{ from: s("d4c3f5a6b8"), to: s("e5b4a6c7d9"), kind: "spawned" },
			{ from: s("f6a5b7d8e0"), to: s("a7f6c8e9f1"), kind: "forked" },
		],
		messages: [
			message(
				"m1",
				s("a1f0c2d4e5"),
				s("d4c3f5a6b8"),
				40 * minute,
				"The session cookie is now SameSite=Lax; update the checkout fetches.",
			),
			message(
				"m2",
				s("a1f0c2d4e5"),
				s("d4c3f5a6b8"),
				18 * minute,
				"New /v2/orders shape is live on staging.",
			),
			message(
				"m3",
				s("d4c3f5a6b8"),
				s("a1f0c2d4e5"),
				15 * minute,
				"Thanks. Can you add the currency field to the order summary?",
			),
			message(
				"m4",
				s("e5b4a6c7d9"),
				s("d4c3f5a6b8"),
				12 * minute,
				"Build failed on 14 axe violations, mostly missing labels in checkout.",
			),
			message(
				"m5",
				s("b2e1d3c4f6"),
				s("f6a5b7d8e0"),
				4 * minute,
				"Need the staging RDS snapshot id before migrating.",
			),
			message(
				"m6",
				s("a1f0c2d4e5"),
				s("d4c3f5a6b8"),
				20_000,
				"Currency field added to OrderSummary; tests are running.",
			),
		],
		layout: {},
		regions: [],
		colours: {},
		digests: digestsAt(start),
		annotations: {
			welcome: {
				id: "welcome",
				kind: "note",
				color: "yellow",
				text: welcome,
				x: 864,
				y: 600,
				w: 288,
				h: 216,
				z: 1,
			},
		},
		comments: [],
		files: {
			"acme-api": [
				"src/auth/middleware.ts",
				"src/auth/session.ts",
				"src/orders/summary.ts",
				"src/orders/routes.ts",
				"migrations/0042_orders_currency.sql",
				"test/auth.test.ts",
				"package.json",
				"README.md",
			],
			"acme-web": [
				"src/checkout/Summary.tsx",
				"src/checkout/Payment.tsx",
				"src/checkout/labels.ts",
				"src/app.tsx",
				"package.json",
			],
		},
		stories: {
			"session:a1f0c2d4e5": [
				{ user: "Expire auth sessions that have been idle for 30 days." },
				{
					assistant:
						"I'll find where sessions are stored, add an expiry, and cover it with tests.",
				},
				{
					tool: "Grep",
					input: { pattern: "lastSeenAt", path: "src/auth" },
					result: "Found 2 files\nsrc/auth/session.ts\nsrc/auth/middleware.ts",
				},
				{
					tool: "Task",
					input: {
						description: "Map the auth middleware",
						subagent_type: "Explore",
						prompt: "Map every route that reads the session cookie.",
					},
				},
				{
					tool: "Task",
					input: {
						description: "Write session expiry tests",
						subagent_type: "general-purpose",
						prompt: "Write tests for sessions idle past 30 days.",
					},
					result: "Added 6 tests in test/auth.test.ts",
					agentId: "sa-tests",
				},
				{
					peer: "Can you add the currency field to the order summary?",
					from: "acme-web",
				},
				{
					tool: "Edit",
					input: {
						file_path: "/Users/me/dev/acme-api/src/orders/summary.ts",
						old_string: "  total: order.total,",
						new_string: "  total: order.total,\n  currency: order.currency,",
					},
					result: "The file has been updated.",
				},
				{
					tool: "SendMessage",
					input: {
						to: "acme-web",
						summary: "Currency field added to OrderSummary; tests are running.",
					},
					result: "Sent",
				},
				{
					assistant:
						"Currency is in. Running the auth suite before I hand back.",
				},
				{
					tool: "Bash",
					input: {
						command: "npm test -- --filter auth",
						description: "Run the auth tests",
					},
				},
			],
			"session:b2e1d3c4f6": [
				{ user: "Backfill the orders table on staging, in batches." },
				{
					tool: "Write",
					input: {
						file_path:
							"/Users/me/dev/acme-api/migrations/0042_orders_currency.sql",
						content:
							"ALTER TABLE orders ADD COLUMN currency text;\nUPDATE orders SET currency = 'USD' WHERE id IN (SELECT id FROM orders WHERE currency IS NULL LIMIT 5000);",
					},
					result: "File created",
				},
				{
					assistant:
						"The backfill is ready. It runs in batches of 5,000 rows, so staging stays responsive.",
				},
				{
					tool: "Bash",
					input: {
						command: "npm run db:migrate -- --env staging",
						description: "Run the migration against staging",
					},
				},
			],
			"session:c3d2e4f5a7": [
				{ user: "Two tabs can rotate the same refresh token. Fix the race." },
				{
					tool: "Edit",
					input: {
						file_path: "/Users/me/dev/acme-api/src/auth/middleware.ts",
						old_string: "const token = await rotate(session);",
						new_string:
							"const token = await withLock(session.id, () => rotate(session));",
					},
					result: "The file has been updated.",
				},
				{
					tool: "Bash",
					input: { command: "npm test", description: "Run the tests" },
					result: "Tests  212 passed (212)",
				},
				{
					tool: "Bash",
					input: {
						command: "gh pr create --fill",
						description: "Open a pull request",
					},
					result: "https://github.com/acme/acme-api/pull/482",
				},
				{
					assistant:
						"Opened #482: fix token refresh race in the auth middleware.\n\nThe refresh now holds a per-session lock, so two tabs can no longer both rotate the token.",
				},
			],
			"session:e5b4a6c7d9": [
				{ user: "Run axe over checkout and fix what it finds." },
				{
					tool: "Bash",
					input: {
						command: "npx axe-cli http://localhost:5173/checkout",
						description: "Audit checkout with axe",
					},
					result: "Exit code 1\n14 violations found: 9 label, 5 color-contrast",
					error: true,
				},
				{
					assistant:
						"14 violations: 9 missing form labels and 5 contrast failures, all in checkout.",
				},
				{
					tool: "SendMessage",
					input: {
						to: "acme-web",
						summary:
							"Build failed on 14 axe violations, mostly missing labels in checkout.",
					},
					result: "Sent",
				},
				{ assistant: "The accessibility gate failed; stopping here." },
			],
			"session:f6a5b7d8e0": [
				{ user: "Plan the NAT gateway change but do not apply it." },
				{
					tool: "Bash",
					input: {
						command: "terraform plan -out plan.tfplan",
						description: "Plan the change",
					},
					result: "Plan: 2 to add, 1 to change, 0 to destroy.",
				},
				{
					assistant:
						"Plan saved: 2 to add, 1 to change, 0 to destroy. Review it before I apply.",
				},
				{ notice: "Interrupted by the user", level: "warning" },
			],
			"session:a7f6c8e9f1": [
				{ user: "Why did last month's bill go up?" },
				{
					tool: "Bash",
					input: {
						command: "aws ce get-cost-and-usage --granularity MONTHLY",
						description: "Fetch monthly costs",
					},
					result: '{ "ResultsByTime": [ … ] }',
				},
				{
					assistant:
						"Last month's spend is up 8%, mostly NAT gateway traffic from the image proxy.\n\n| Service | Change |\n| --- | --- |\n| NAT gateway | +31% |\n| EC2 | +2% |\n| S3 | -4% |",
				},
			],
			"session:b8e7d9f0a2": [
				{ user: "Draft release notes for 2.4 from the changelog." },
				{
					tool: "Read",
					input: { file_path: "/Users/me/dev/acme-docs/CHANGELOG.md" },
					result: "212 lines",
				},
				{
					assistant:
						"Drafting now. 2.4 has three user-facing changes and one fix.",
				},
			],
		},
	};
}

const chatter: [NodeRef, NodeRef, string][] = [
	[
		s("f6a5b7d8e0"),
		s("b2e1d3c4f6"),
		"Staging snapshot is rds:acme-staging-2026-10-24.",
	],
	[
		s("d4c3f5a6b8"),
		s("e5b4a6c7d9"),
		"Checkout labels fixed; rerun the a11y sweep?",
	],
	[
		s("a1f0c2d4e5"),
		s("d4c3f5a6b8"),
		"Auth tests are green. Merging after review.",
	],
	[
		s("a7f6c8e9f1"),
		s("b8e7d9f0a2"),
		"Cost report: NAT traffic traced to the image proxy.",
	],
	[
		s("b2e1d3c4f6"),
		s("a1f0c2d4e5"),
		"Backfill plan is ready; it needs a green light on staging.",
	],
	[
		s("e5b4a6c7d9"),
		s("d4c3f5a6b8"),
		"Rerun found 3 contrast failures left, all in the footer.",
	],
	[
		s("b8e7d9f0a2"),
		s("a1f0c2d4e5"),
		"Should the 2.4 notes mention the session expiry change?",
	],
	[
		s("a1f0c2d4e5"),
		s("b8e7d9f0a2"),
		"Yes: sessions idle for 30 days now sign out.",
	],
];

export const calm: Scenario = {
	world,
	timeline: [],
	ambient: {
		every: 15_000,
		steps: chatter.map(
			([from, to, summary]) =>
				(stage) =>
					stage.message(from, to, summary),
		),
	},
};
