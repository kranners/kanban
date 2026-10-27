import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	createClient,
	envFile,
	parseConfig,
	runSetup,
	type SetupConfig,
} from "./cloudflare-setup.ts";

const config: SetupConfig = {
	account: "acct1",
	zone: "example.test",
	hostname: "board.example.test",
	team: "acme-team",
	email: "me@example.test",
	service: "http://127.0.0.1:7420",
	tunnelName: "kanban",
};

type Request = { method: string; path: string; body: unknown };
type Row = Record<string, unknown> & { id: string };

const fakeCloudflare = (
	seed: {
		tunnels?: Row[];
		policies?: Row[];
		apps?: Row[];
		records?: Row[];
	} = {},
) => {
	const state = {
		tunnels: seed.tunnels ?? [],
		policies: seed.policies ?? [],
		apps: seed.apps ?? [],
		records: seed.records ?? [],
		ingress: null as unknown,
	};
	const requests: Request[] = [];
	let nextId = 1;
	const newId = (prefix: string) => `${prefix}-${nextId++}`;

	const collections: [RegExp, Row[], string][] = [
		[/^\/accounts\/acct1\/cfd_tunnel$/, state.tunnels, "tun"],
		[/^\/accounts\/acct1\/access\/policies$/, state.policies, "pol"],
		[/^\/accounts\/acct1\/access\/apps$/, state.apps, "app"],
		[/^\/zones\/zone1\/dns_records$/, state.records, "rec"],
	];

	const respond = (result: unknown) =>
		new Response(JSON.stringify({ success: true, errors: [], result }), {
			status: 200,
		});

	const handle = (method: string, url: URL, body: unknown): Response => {
		const path = url.pathname.replace("/client/v4", "");
		requests.push({ method, path, body });
		if (path === "/zones") return respond([{ id: "zone1" }]);
		if (path.endsWith("/configurations")) {
			state.ingress = body;
			return respond({});
		}
		if (path.endsWith("/token")) return respond("secret-tunnel-token");
		for (const [pattern, rows, prefix] of collections) {
			if (pattern.test(path)) {
				if (method === "GET") {
					const name = url.searchParams.get("name");
					const exact = url.searchParams.get("name.exact");
					return respond(
						rows.filter(
							(row) =>
								(!name || row.name === name) && (!exact || row.name === exact),
						),
					);
				}
				const row = {
					...(body as object),
					id: newId(prefix),
					aud: "aud-1",
				} as Row;
				rows.push(row);
				return respond(row);
			}
			const item = path.match(
				new RegExp(`${pattern.source.slice(0, -1)}/(.+)$`),
			);
			if (item && method === "PUT") {
				const index = rows.findIndex((row) => row.id === item[1]);
				const row = { ...rows[index], ...(body as object) } as Row;
				rows[index] = row;
				return respond(row);
			}
		}
		return new Response(
			JSON.stringify({
				success: false,
				errors: [{ code: 404, message: path }],
			}),
			{ status: 404 },
		);
	};

	const fetchImpl = (async (input: URL, init?: RequestInit) =>
		handle(
			init?.method ?? "GET",
			new URL(input),
			init?.body ? JSON.parse(String(init.body)) : undefined,
		)) as typeof fetch;

	return { state, requests, fetchImpl };
};

const run = async (fake: ReturnType<typeof fakeCloudflare>, dryRun = false) => {
	const lines: string[] = [];
	const log = (line: string) => lines.push(line);
	const client = createClient("api-secret", fake.fetchImpl, dryRun, log);
	const result = await runSetup(client, config, log);
	return { result, lines };
};

const writes = (requests: Request[]) =>
	requests.filter((request) => request.method !== "GET");

describe("cloudflare setup", () => {
	it("creates everything on a fresh account, DNS last", async () => {
		const fake = fakeCloudflare();
		const { result, lines } = await run(fake);

		assert.deepEqual(
			writes(fake.requests).map((r) => `${r.method} ${r.path}`),
			[
				"POST /accounts/acct1/cfd_tunnel",
				"POST /accounts/acct1/access/policies",
				"POST /accounts/acct1/access/apps",
				"PUT /accounts/acct1/cfd_tunnel/tun-1/configurations",
				"POST /zones/zone1/dns_records",
			],
		);
		assert.deepEqual(fake.state.tunnels[0]?.config_src, "cloudflare");
		assert.deepEqual(fake.state.policies[0]?.include, [
			{ email: { email: "me@example.test" } },
		]);
		const app = fake.state.apps[0];
		assert.equal(app?.type, "self_hosted");
		assert.equal(app?.domain, "board.example.test");
		assert.equal(app?.session_duration, "24h");
		assert.equal(app?.same_site_cookie_attribute, "lax");
		assert.equal(app?.http_only_cookie_attribute, true);
		assert.equal(app?.app_launcher_visible, false);
		assert.deepEqual(app?.policies, [{ id: "pol-2", precedence: 1 }]);
		assert.deepEqual(fake.state.ingress, {
			config: {
				ingress: [
					{
						hostname: "board.example.test",
						service: "http://127.0.0.1:7420",
						originRequest: {
							access: {
								required: true,
								teamName: "acme-team",
								audTag: ["aud-1"],
							},
						},
					},
					{ service: "http_status:404" },
				],
			},
		});
		assert.deepEqual(
			{
				type: fake.state.records[0]?.type,
				content: fake.state.records[0]?.content,
				proxied: fake.state.records[0]?.proxied,
			},
			{ type: "CNAME", content: "tun-1.cfargotunnel.com", proxied: true },
		);
		assert.deepEqual(result, {
			tunnelId: "tun-1",
			aud: "aud-1",
			tunnelToken: "secret-tunnel-token",
		});
		assert.ok(!lines.join("\n").includes("secret"));
	});

	it("creates nothing on a second run", async () => {
		const fake = fakeCloudflare();
		await run(fake);
		fake.requests.length = 0;
		await run(fake);

		assert.deepEqual(
			writes(fake.requests).map((r) => `${r.method} ${r.path}`),
			[
				"PUT /accounts/acct1/access/apps/app-3",
				"PUT /accounts/acct1/cfd_tunnel/tun-1/configurations",
			],
		);
		assert.equal(fake.state.tunnels.length, 1);
		assert.equal(fake.state.records.length, 1);
	});

	it("updates the policy when the allowed email changes", async () => {
		const fake = fakeCloudflare({
			policies: [
				{
					id: "pol-old",
					name: "kanban owner",
					decision: "allow",
					include: [{ email: { email: "old@example.test" } }],
				},
			],
		});
		await run(fake);
		assert.equal(fake.state.policies.length, 1);
		assert.deepEqual(fake.state.policies[0]?.include, [
			{ email: { email: "me@example.test" } },
		]);
	});

	it("only reads in a dry run", async () => {
		const fake = fakeCloudflare();
		const { result, lines } = await run(fake, true);

		assert.deepEqual(writes(fake.requests), []);
		assert.equal(result.tunnelToken, null);
		assert.ok(lines.some((line) => line.startsWith("would POST")));
	});

	it("refuses a locally managed tunnel", async () => {
		const fake = fakeCloudflare({
			tunnels: [{ id: "t", name: "kanban", config_src: "local" }],
		});
		await assert.rejects(run(fake), /locally managed/);
		assert.deepEqual(writes(fake.requests), []);
	});

	it("refuses to replace a non-CNAME record", async () => {
		const fake = fakeCloudflare({
			records: [
				{ id: "r", type: "A", name: "board.example.test", content: "1.2.3.4" },
			],
		});
		await assert.rejects(run(fake), /already has A records/);
		assert.ok(
			!writes(fake.requests).some((r) => r.path.includes("dns_records")),
		);
	});

	it("repoints a CNAME at the tunnel", async () => {
		const fake = fakeCloudflare({
			tunnels: [{ id: "tun-x", name: "kanban", config_src: "cloudflare" }],
			records: [
				{
					id: "r",
					type: "CNAME",
					name: "board.example.test",
					content: "elsewhere.example.test",
					proxied: false,
				},
			],
		});
		await run(fake);
		assert.equal(fake.state.records[0]?.content, "tun-x.cfargotunnel.com");
		assert.equal(fake.state.records[0]?.proxied, true);
	});
});

describe("parseConfig", () => {
	it("requires the account, zone, hostname, team and allowed email", () => {
		assert.deepEqual(parseConfig([], {}).missing, [
			"a Cloudflare account id: set KANBAN_CF_ACCOUNT or pass --account",
			"a Cloudflare zone: set KANBAN_CF_ZONE or pass --zone",
			"a hostname for the board: set KANBAN_HOSTNAME or pass --hostname",
			"an Access team name: set KANBAN_ACCESS_TEAM or pass --team",
			"an allowed email: set KANBAN_ALLOWED_EMAIL or pass --email",
		]);
	});

	it("takes flags over env over defaults", () => {
		const {
			config: parsed,
			dryRun,
			missing,
		} = parseConfig(
			["--hostname", "x.example.test", "--team", "acme-team", "--dry-run"],
			{
				KANBAN_CF_ACCOUNT: "acct1",
				KANBAN_CF_ZONE: "example.test",
				KANBAN_ALLOWED_EMAIL: "me@example.test",
				KANBAN_HOSTNAME: "y",
			},
		);
		assert.deepEqual(missing, []);
		assert.deepEqual(parsed, {
			account: "acct1",
			zone: "example.test",
			hostname: "x.example.test",
			team: "acme-team",
			email: "me@example.test",
			service: "http://127.0.0.1:7420",
			tunnelName: "kanban",
		});
		assert.equal(dryRun, true);
	});
});

describe("envFile", () => {
	it("holds the team, audience and origin", () => {
		assert.equal(
			envFile(config, "aud-1"),
			"KANBAN_ACCESS_TEAM=acme-team\nKANBAN_ACCESS_AUD=aud-1\nKANBAN_ORIGIN=https://board.example.test\n",
		);
	});
});
