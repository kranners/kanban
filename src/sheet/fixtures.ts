// Invented sheet inputs, one of each kind, for the tests and for looking at
// the sheet by eye. Nothing here is a real thread, project or person.

const minute = 60_000;
const hour = 60 * minute;

export const fixtureNow = Date.UTC(2026, 10, 19, 9, 30);

const link = (id: string) => `https://discord.com/channels/111111/${id}`;

export const fixtureCards = (now: number) => [
	{
		id: "200000000000000001",
		title: "Tidy the garden watering schedule",
		kind: "conversation",
		state: "working",
		status: "Reading the valve logs",
		link: link("200000000000000001"),
		createdAt: now - 40 * minute,
		lastActiveAt: now - minute,
		machines: ["piggy", "browser"],
		mission: { id: "m-12", covers: "Edit the schedule file" },
		private: false,
		subagents: [
			{
				id: "sub-1",
				description: "Read the valve logs",
				type: "Explore",
				state: "working",
				updatedAt: now - minute,
			},
			{
				id: "sub-2",
				description: "Draft the new schedule",
				type: "general-purpose",
				state: "done",
				updatedAt: now - 8 * minute,
			},
		],
	},
	{
		id: "200000000000000002",
		title: "Book the bike service",
		kind: "desk",
		state: "needs-you",
		status: "Which Saturday suits?",
		link: link("200000000000000002"),
		createdAt: now - 3 * hour,
		lastActiveAt: now - 20 * minute,
		parent: "200000000000000001",
		desk: { id: "1119-2", task: "Book the bike service", state: "parked" },
		engine: "Codex · Sol",
		private: false,
	},
	{
		id: "200000000000000003",
		title: "Morning weather brief",
		kind: "scheduled",
		state: "done",
		status: "Sent the brief",
		link: link("200000000000000003"),
		createdAt: now - 2 * hour,
		lastActiveAt: now - 90 * minute,
		finishedAt: now - 90 * minute,
		outcome: "done",
		mood: "content",
		private: false,
	},
	{
		id: "200000000000000004",
		title: "Rebuild the photo index",
		kind: "job",
		state: "failed",
		status: "The index disk was full",
		link: link("200000000000000004"),
		createdAt: now - 5 * hour,
		lastActiveAt: now - 4 * hour,
		private: true,
	},
	{
		id: "1119-3",
		title: "Sort the receipts folder",
		kind: "desk",
		state: "working",
		status: "",
		link: "",
		createdAt: now - 25 * minute,
		lastActiveAt: now - 25 * minute,
		desk: { id: "1119-3", task: "Sort the receipts folder", state: "working" },
		private: false,
	},
];

export const fixtureProjects = (now: number) => {
	const ago = (days: number) => new Date(now - days * 86_400_000).toISOString();
	return [
		{
			id: "garden",
			title: "Garden automation",
			parent: null,
			area: "home",
			kind: "project",
			stage: "building",
			state: "Watering schedule works; the soil sensors are next",
			next: "Pair the second soil sensor",
			blocked_on: null,
			created: ago(40),
			touched: ago(1),
			stage_since: ago(9),
			links: [{ type: "thread", ref: "200000000000000001" }],
			history: [
				{ at: ago(40), stage: "idea", note: "Thought of it" },
				{ at: ago(25), stage: "planned", note: "Parts list written" },
				{ at: ago(9), stage: "building", note: "Valves wired" },
			],
			progress: 0.45,
			graph: {
				updated: ago(0.5),
				nodes: [
					{ id: "parts", title: "Order parts", state: "done" },
					{ id: "valves", title: "Wire the valves", state: "done" },
					{ id: "schedule", title: "Watering schedule", state: "progress" },
					{
						id: "batteries",
						title: "Batteries for sensor two",
						sub: "Waiting on a yes to buy them",
						state: "aaron",
					},
					{ id: "sensor", title: "Pair soil sensor two", state: "idle" },
				],
				edges: [
					{ from: "parts", to: "valves" },
					{ from: "valves", to: "schedule" },
					{ from: "parts", to: "batteries" },
					{ from: "batteries", to: "sensor" },
					{ from: "schedule", to: "sensor" },
				],
			},
		},
		{
			id: "garden-sensors",
			title: "Soil sensors",
			parent: "garden",
			area: "home",
			kind: "project",
			stage: "planned",
			state: "Two sensors chosen",
			next: "Order the second one",
			created: ago(12),
			touched: ago(2),
			links: [],
			history: [],
		},
	];
};

export const fixtureReport = (now: number) => ({
	at: now,
	title: "Garden automation",
	parts: [
		{
			name: "Watering schedule",
			activity: "working",
			sections: {
				done: "Valves wired and tested.",
				goal: "Water each bed by its soil reading.",
				left: "Pair the second sensor.",
				needs: "A yes to buy batteries.",
			},
			plan: [{ ms: 30 * minute, text: "Pair the sensor" }],
			tasks: { done: 5, active: 1, pending: 2 },
			burnup: [
				{ at: now - 4 * hour, done: 1 },
				{ at: now - 2 * hour, done: 3 },
				{ at: now, done: 5 },
			],
			tokens: {
				input: 120_000,
				output: 18_000,
				cacheRead: 400_000,
				cacheWrite: 30_000,
			},
			startedAt: now - 5 * hour,
			finish: now + hour,
		},
	],
	lanes: [
		{
			key: "tasks",
			label: "Tasks",
			spans: [
				{
					start: now - 5 * hour,
					end: now - 3 * hour,
					kind: "done",
					title: "Wire valves",
				},
				{ start: now - 3 * hour, end: now, kind: "active", title: "Schedule" },
				{ start: now, end: now + hour, kind: "planned", title: "Sensor" },
			],
			finish: now + hour,
			events: [{ at: now - 2 * hour, text: "Schedule ran" }],
		},
	],
	shots: [
		{ url: "https://example.com/shot.png", caption: "Never loaded", at: now },
	],
});

export const sheetFixtures = (now = fixtureNow) => ({
	cards: { kind: "cards", now, cards: fixtureCards(now) },
	strip: { kind: "strip", now, cards: fixtureCards(now).slice(0, 1) },
	dashboard: {
		kind: "dashboard",
		now,
		dashboard: {
			projects: fixtureProjects(now),
			project: "garden",
			cards: fixtureCards(now).slice(0, 2),
		},
	},
	report: { kind: "report", now, report: fixtureReport(now) },
});
