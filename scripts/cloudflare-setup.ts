import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";

export type SetupConfig = {
	account: string;
	zone: string;
	hostname: string;
	team: string;
	email: string;
	service: string;
	tunnelName: string;
};

export type Method = "GET" | "POST" | "PUT";

export type Client = {
	get: <T>(path: string, query?: Record<string, string>) => Promise<T>;
	getAll: <T>(path: string, query?: Record<string, string>) => Promise<T[]>;
	send: <T>(method: Method, path: string, body: unknown) => Promise<T | null>;
};

type Envelope<T> = {
	success: boolean;
	errors?: { code: number; message: string }[];
	result: T;
	result_info?: { page?: number; total_pages?: number };
};

type Tunnel = { id: string; name: string; config_src?: string };
type Policy = {
	id: string;
	name: string;
	decision: string;
	include: unknown[];
};
type AccessApp = { id: string; aud: string; domain?: string; type?: string };
type DnsRecord = {
	id: string;
	type: string;
	name: string;
	content: string;
	proxied?: boolean;
};

export type SetupResult = {
	tunnelId: string;
	aud: string;
	tunnelToken: string | null;
};

const apiBase = "https://api.cloudflare.com/client/v4";
const pendingId = "<to be created>";

export const createClient = (
	token: string,
	fetchImpl: typeof fetch,
	dryRun: boolean,
	log: (line: string) => void,
): Client => {
	const call = async <T>(
		method: Method,
		path: string,
		query: Record<string, string> = {},
		body?: unknown,
	): Promise<Envelope<T>> => {
		const url = new URL(apiBase + path);
		for (const [key, value] of Object.entries(query)) {
			url.searchParams.set(key, value);
		}
		const response = await fetchImpl(url, {
			method,
			headers: {
				authorization: `Bearer ${token}`,
				"content-type": "application/json",
			},
			body: body === undefined ? undefined : JSON.stringify(body),
		});
		const envelope = (await response.json()) as Envelope<T>;
		if (!response.ok || !envelope.success) {
			const reasons = (envelope.errors ?? [])
				.map((error) => `${error.code} ${error.message}`)
				.join("; ");
			throw new Error(
				`${method} ${path} failed (${response.status}): ${reasons}`,
			);
		}
		return envelope;
	};

	return {
		get: async <T>(path: string, query?: Record<string, string>) =>
			(await call<T>("GET", path, query)).result,
		getAll: async <T>(path: string, query: Record<string, string> = {}) => {
			const items: T[] = [];
			for (let page = 1; ; page++) {
				const envelope = await call<T[]>("GET", path, {
					...query,
					page: String(page),
					per_page: "50",
				});
				items.push(...envelope.result);
				const totalPages = envelope.result_info?.total_pages ?? 1;
				if (page >= totalPages || envelope.result.length === 0) return items;
			}
		},
		send: async <T>(method: Method, path: string, body: unknown) => {
			log(`${dryRun ? "would " : ""}${method} ${path}`);
			if (dryRun) return null;
			return (await call<T>(method, path, {}, body)).result;
		},
	};
};

export const policyName = (config: SetupConfig): string =>
	`${config.tunnelName} owner`;

export const policyBody = (config: SetupConfig) => ({
	name: policyName(config),
	decision: "allow",
	include: [{ email: { email: config.email } }],
});

export const appBody = (config: SetupConfig, policyId: string) => ({
	name: config.tunnelName,
	type: "self_hosted",
	domain: config.hostname,
	destinations: [{ type: "public", uri: config.hostname }],
	session_duration: "24h",
	app_launcher_visible: false,
	policies: [{ id: policyId, precedence: 1 }],
});

export const ingressBody = (config: SetupConfig, aud: string) => ({
	config: {
		ingress: [
			{
				hostname: config.hostname,
				service: config.service,
				originRequest: {
					access: { required: true, teamName: config.team, audTag: [aud] },
				},
			},
			{ service: "http_status:404" },
		],
	},
});

export const dnsBody = (config: SetupConfig, tunnelId: string) => ({
	type: "CNAME",
	name: config.hostname,
	content: `${tunnelId}.cfargotunnel.com`,
	proxied: true,
	ttl: 1,
	comment: `${config.tunnelName} tunnel`,
});

export const envFile = (config: SetupConfig, aud: string): string =>
	[
		`KANBAN_ACCESS_TEAM=${config.team}`,
		`KANBAN_ACCESS_AUD=${aud}`,
		`KANBAN_ORIGIN=https://${config.hostname}`,
		"",
	].join("\n");

const sameJson = (a: unknown, b: unknown): boolean =>
	JSON.stringify(a) === JSON.stringify(b);

const findZone = async (client: Client, config: SetupConfig) => {
	const zones = await client.get<{ id: string }[]>("/zones", {
		name: config.zone,
		"account.id": config.account,
	});
	const zone = zones[0];
	if (!zone) {
		throw new Error(
			`zone ${config.zone} not found in account ${config.account}`,
		);
	}
	return zone.id;
};

const ensureTunnel = async (client: Client, config: SetupConfig) => {
	const path = `/accounts/${config.account}/cfd_tunnel`;
	const tunnels = await client.getAll<Tunnel>(path, {
		name: config.tunnelName,
		is_deleted: "false",
	});
	const existing = tunnels.find((tunnel) => tunnel.name === config.tunnelName);
	if (existing) {
		if (existing.config_src !== "cloudflare") {
			throw new Error(
				`tunnel ${config.tunnelName} is locally managed; delete it or pick another --tunnel-name`,
			);
		}
		return existing.id;
	}
	const created = await client.send<Tunnel>("POST", path, {
		name: config.tunnelName,
		config_src: "cloudflare",
	});
	return created?.id ?? pendingId;
};

const ensurePolicy = async (client: Client, config: SetupConfig) => {
	const path = `/accounts/${config.account}/access/policies`;
	const wanted = policyBody(config);
	const existing = (await client.getAll<Policy>(path)).find(
		(policy) => policy.name === wanted.name,
	);
	if (!existing) {
		return (await client.send<Policy>("POST", path, wanted))?.id ?? pendingId;
	}
	const current = {
		name: existing.name,
		decision: existing.decision,
		include: existing.include,
	};
	if (!sameJson(current, wanted)) {
		await client.send("PUT", `${path}/${existing.id}`, wanted);
	}
	return existing.id;
};

const ensureApp = async (
	client: Client,
	config: SetupConfig,
	policyId: string,
) => {
	const path = `/accounts/${config.account}/access/apps`;
	const wanted = appBody(config, policyId);
	const existing = (await client.getAll<AccessApp>(path)).find(
		(app) => app.domain === config.hostname,
	);
	if (existing) {
		const updated = await client.send<AccessApp>(
			"PUT",
			`${path}/${existing.id}`,
			wanted,
		);
		return updated?.aud ?? existing.aud;
	}
	return (await client.send<AccessApp>("POST", path, wanted))?.aud ?? pendingId;
};

const ensureIngress = async (
	client: Client,
	config: SetupConfig,
	tunnelId: string,
	aud: string,
) => {
	await client.send(
		"PUT",
		`/accounts/${config.account}/cfd_tunnel/${tunnelId}/configurations`,
		ingressBody(config, aud),
	);
};

const ensureDns = async (
	client: Client,
	config: SetupConfig,
	zoneId: string,
	tunnelId: string,
) => {
	const path = `/zones/${zoneId}/dns_records`;
	const records = await client.getAll<DnsRecord>(path, {
		"name.exact": config.hostname,
	});
	const conflicting = records.filter((record) => record.type !== "CNAME");
	if (conflicting.length > 0) {
		throw new Error(
			`${config.hostname} already has ${conflicting.map((record) => record.type).join(", ")} records; remove them first`,
		);
	}
	const wanted = dnsBody(config, tunnelId);
	const existing = records[0];
	if (!existing) {
		await client.send("POST", path, wanted);
		return;
	}
	if (existing.content !== wanted.content || existing.proxied !== true) {
		await client.send("PUT", `${path}/${existing.id}`, wanted);
	}
};

const fetchTunnelToken = async (
	client: Client,
	config: SetupConfig,
	tunnelId: string,
) =>
	tunnelId === pendingId
		? null
		: client.get<string>(
				`/accounts/${config.account}/cfd_tunnel/${tunnelId}/token`,
			);

export const runSetup = async (
	client: Client,
	config: SetupConfig,
	log: (line: string) => void,
): Promise<SetupResult> => {
	const zoneId = await findZone(client, config);
	const tunnelId = await ensureTunnel(client, config);
	log(`tunnel ${config.tunnelName}: ${tunnelId}`);
	const policyId = await ensurePolicy(client, config);
	const aud = await ensureApp(client, config, policyId);
	log(`access application ${config.hostname}: aud ${aud}`);
	await ensureIngress(client, config, tunnelId, aud);
	await ensureDns(client, config, zoneId, tunnelId);
	const tunnelToken = await fetchTunnelToken(client, config, tunnelId);
	return { tunnelId, aud, tunnelToken };
};

const writePrivate = async (path: string, contents: string) => {
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	await writeFile(path, contents, { mode: 0o600 });
	await chmod(path, 0o600);
};

export const parseConfig = (
	argv: string[],
	env: NodeJS.ProcessEnv,
): { config: SetupConfig; dryRun: boolean; missing: string[] } => {
	const { values } = parseArgs({
		args: argv,
		options: {
			account: { type: "string" },
			zone: { type: "string" },
			hostname: { type: "string" },
			team: { type: "string" },
			email: { type: "string" },
			service: { type: "string" },
			"tunnel-name": { type: "string" },
			"dry-run": { type: "boolean", default: false },
		},
	});
	const config = {
		account:
			values.account ??
			env.KANBAN_CF_ACCOUNT ??
			"fae652ecde66de622a287f1b29581741",
		zone: values.zone ?? env.KANBAN_CF_ZONE ?? "cute.engineer",
		hostname: values.hostname ?? env.KANBAN_HOSTNAME ?? "kanban.cute.engineer",
		team: values.team ?? env.KANBAN_ACCESS_TEAM ?? "frappuccino-pages",
		email: values.email ?? env.KANBAN_ALLOWED_EMAIL ?? "",
		service: values.service ?? env.KANBAN_SERVICE ?? "http://127.0.0.1:7420",
		tunnelName: values["tunnel-name"] ?? env.KANBAN_TUNNEL_NAME ?? "kanban",
	};
	const missing = config.email
		? []
		: ["an allowed email: set KANBAN_ALLOWED_EMAIL or pass --email"];
	return { config, dryRun: values["dry-run"], missing };
};

const readApiToken = async (path: string): Promise<string | null> => {
	try {
		return (await readFile(path, "utf8")).trim() || null;
	} catch {
		return null;
	}
};

const main = async () => {
	const { config, dryRun, missing } = parseConfig(
		process.argv.slice(2),
		process.env,
	);
	const tokenPath = join(homedir(), ".cloudflared/api-token");
	const apiToken = await readApiToken(tokenPath);
	if (!apiToken) {
		missing.push(
			`a Cloudflare API token in ${tokenPath} with Account: Cloudflare Tunnel Edit, Account: Access: Apps and Policies Edit, Zone: Zone Read and Zone: DNS Edit on ${config.zone}`,
		);
	}
	if (missing.length > 0 || !apiToken) {
		console.error(`Missing:\n${missing.map((item) => `- ${item}`).join("\n")}`);
		process.exit(1);
	}
	const log = (line: string) => console.log(line);
	const client = createClient(apiToken, fetch, dryRun, log);
	const result = await runSetup(client, config, log);
	if (dryRun) {
		log("dry run: nothing written");
		return;
	}
	const configDir = join(homedir(), ".config/kanban");
	await writePrivate(join(configDir, "env"), envFile(config, result.aud));
	if (result.tunnelToken) {
		await writePrivate(join(configDir, "tunnel-token"), result.tunnelToken);
	}
	log(`wrote ${configDir}/env and ${configDir}/tunnel-token`);
};

if (import.meta.main) {
	main().catch((error: unknown) => {
		console.error(error instanceof Error ? error.message : error);
		process.exit(1);
	});
}
