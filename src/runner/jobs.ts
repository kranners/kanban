// Jobs on this machine: bytes in, bytes out, run by the fixed command this
// machine's own config lists for the job's class, never anything the hub
// sends. Each runs in an empty environment in a scratch folder wiped at the
// end, at background priority, inside a sandbox profile when the config names
// one, which has to pass its own self-test before any job runs. The config can
// cap the cores, memory and slots jobs take, and set manners: no new job while
// someone typed lately, on battery, under heat or memory pressure or high load,
// a running one paused then and handed back after a minute paused.
import { type ChildProcess, execFile, spawn } from "node:child_process";
import {
	mkdir,
	mkdtemp,
	readFile,
	realpath,
	rm,
	writeFile,
} from "node:fs/promises";
import { homedir, setPriority, tmpdir } from "node:os";
import { join } from "node:path";
import type {
	RunnerJob,
	RunnerJobResult,
	RunnerJobsReport,
	RunnerSignals,
	RunnerUsage,
} from "../shared/runners.ts";

export const maxOutputBytes = 16 * 1024 ** 2;
export const pausedGiveUpMs = 60_000;
const classPattern = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export type JobClassConfig = {
	personal: boolean;
	command: string[];
	cores: number;
	memoryMb: number;
};

export type JobManners = {
	typedWithinSeconds: number | null;
	battery: boolean;
	heat: boolean;
	memoryPressure: boolean;
	loadPerCore: number | null;
	halveWhileSessionsWork: boolean;
};

export type JobConfig = {
	classes: Record<string, JobClassConfig>;
	limits: { cores: number; memoryMb: number; slots: number };
	manners: JobManners | null;
	sandbox: {
		profile: string;
		selfTest: string;
		params: Record<string, string>;
	} | null;
	background: boolean;
	keepAwake: boolean;
};

export const emptyJobConfig: JobConfig = {
	classes: {},
	limits: { cores: 0, memoryMb: 0, slots: 0 },
	manners: null,
	sandbox: null,
	background: true,
	keepAwake: false,
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const count = (value: unknown, fallback: number): number =>
	typeof value === "number" && Number.isFinite(value) && value >= 0
		? value
		: fallback;

const absolute = (value: unknown): value is string =>
	typeof value === "string" && value.startsWith("/") && !value.includes("\0");

/** The jobs part of the machine's allow-list file; anything malformed means no jobs. */
export const parseJobConfig = (text: string | null): JobConfig => {
	if (text === null) return emptyJobConfig;
	let body: unknown;
	try {
		body = JSON.parse(text);
	} catch {
		return emptyJobConfig;
	}
	if (!isRecord(body) || !isRecord(body.jobs)) return emptyJobConfig;
	const classes = Object.fromEntries(
		Object.entries(body.jobs).flatMap(([name, entry]) => {
			if (!classPattern.test(name) || !isRecord(entry)) return [];
			const command = entry.command;
			if (
				!Array.isArray(command) ||
				command.length === 0 ||
				!absolute(command[0]) ||
				!command.every((arg) => typeof arg === "string" && !arg.includes("\0"))
			) {
				return [];
			}
			return [
				[
					name,
					{
						personal: entry.personal !== false,
						command: command as string[],
						cores: count(entry.cores, 1),
						memoryMb: count(entry.memoryMb, 1024),
					},
				],
			];
		}),
	);
	const limits = isRecord(body.limits) ? body.limits : {};
	const manners = isRecord(body.manners) ? body.manners : null;
	const sandbox = isRecord(body.sandbox) ? body.sandbox : null;
	return {
		classes,
		limits: {
			cores: count(limits.cores, 1),
			memoryMb: count(limits.memoryMb, 2048),
			slots: Math.floor(count(limits.slots, 1)),
		},
		manners: manners && {
			typedWithinSeconds:
				typeof manners.typedWithinSeconds === "number"
					? manners.typedWithinSeconds
					: null,
			battery: manners.battery === true,
			heat: manners.heat === true,
			memoryPressure: manners.memoryPressure === true,
			loadPerCore:
				typeof manners.loadPerCore === "number" ? manners.loadPerCore : null,
			halveWhileSessionsWork: manners.halveWhileSessionsWork === true,
		},
		sandbox:
			sandbox && absolute(sandbox.profile) && absolute(sandbox.selfTest)
				? {
						profile: sandbox.profile,
						selfTest: sandbox.selfTest,
						params: isRecord(sandbox.params)
							? Object.fromEntries(
									Object.entries(sandbox.params).filter(
										([key, value]) =>
											/^[A-Z_][A-Z0-9_]{0,31}$/.test(key) &&
											typeof value === "string" &&
											!value.includes("\0"),
									) as [string, string][],
								)
							: {},
					}
				: null,
		background: body.background !== false,
		keepAwake: body.keepAwake === true,
	};
};

export type MachineState = {
	usage: RunnerUsage | null;
	signals: RunnerSignals | null;
	/** True under memory pressure, from the OS's own measure. */
	pressured: boolean;
	/** True while any board session on this machine is working. */
	sessionsWorking: boolean;
};

/** Why manners keep new work off this machine right now, or null. */
export const mannersBlock = (
	manners: JobManners | null,
	state: MachineState,
): string | null => {
	if (!manners) return null;
	const { signals, usage } = state;
	if (
		manners.typedWithinSeconds !== null &&
		signals?.idleSeconds != null &&
		signals.idleSeconds < manners.typedWithinSeconds
	) {
		return `someone used the keyboard or mouse in the last ${manners.typedWithinSeconds} s`;
	}
	if (manners.battery && signals?.power === "battery") return "on battery";
	if (manners.heat && signals?.thermal === "throttled") return "running hot";
	if (manners.memoryPressure && state.pressured) return "under memory pressure";
	if (
		manners.loadPerCore !== null &&
		usage?.load1 != null &&
		usage.cpus > 0 &&
		usage.load1 / usage.cpus > manners.loadPerCore
	) {
		return `load ${(usage.load1 / usage.cpus).toFixed(2)} a core, over ${manners.loadPerCore}`;
	}
	return null;
};

export type Ceiling = { cores: number; memoryMb: number; slots: number };

export const ceilingOf = (
	config: JobConfig,
	sessionsWorking: boolean,
): Ceiling => {
	const halve =
		config.manners?.halveWhileSessionsWork === true && sessionsWorking;
	const { cores, memoryMb, slots } = config.limits;
	return halve
		? {
				cores: cores / 2,
				memoryMb: memoryMb / 2,
				slots: Math.max(1, Math.floor(slots / 2)),
			}
		: { cores, memoryMb, slots };
};

type Running = {
	id: string;
	attempt: number;
	class: string;
	cores: number;
	memoryMb: number;
	child: ChildProcess | null;
	pausedAt: number | null;
	/** Set once it is stopped, so its end posts nothing. */
	silenced: boolean;
	/** Set when it was handed back after a minute paused. */
	handedBack: string | null;
};

export type JobRunnerOptions = {
	configFile: string;
	platform?: NodeJS.Platform;
	now?: () => number;
	home?: string;
	tmp?: string;
	/** Posts one attempt's result to the hub. */
	post: (id: string, attempt: number, result: RunnerJobResult) => Promise<void>;
	log?: (line: string) => void;
	pressure?: () => Promise<boolean>;
	read?: (file: string) => Promise<string | null>;
};

export type JobRunner = {
	report(state: Omit<MachineState, "pressured">): Promise<RunnerJobsReport>;
	start(job: RunnerJob["job"]): void;
	stop(ids: readonly string[], why: string): void;
	stopAll(why: string): void;
	busy(): boolean;
};

const readText = async (file: string) => {
	try {
		return await readFile(file, "utf8");
	} catch {
		return null;
	}
};

const run = (file: string, args: string[]) =>
	new Promise<{ code: number; out: string }>((resolve) => {
		execFile(
			file,
			args,
			{ timeout: 30_000, env: {} },
			(error, stdout, stderr) =>
				resolve({
					code:
						error === null
							? 0
							: typeof (error as { code?: unknown }).code === "number"
								? (error as { code: number }).code
								: 1,
					out: `${stdout}${stderr}`.slice(-400),
				}),
		);
	});

// macOS's own pressure level: 1 normal, 2 warning, 4 critical.
const osPressure =
	(platform: NodeJS.Platform) => async (): Promise<boolean> => {
		if (platform === "darwin") {
			const { code, out } = await run("/usr/sbin/sysctl", [
				"-n",
				"kern.memorystatus_vm_pressure_level",
			]);
			return code === 0 && Number(out.trim()) >= 2;
		}
		const text = await readText("/proc/pressure/memory");
		const avg10 = Number(text?.match(/^some avg10=([\d.]+)/m)?.[1] ?? 0);
		return avg10 > 20;
	};

export const createJobRunner = ({
	configFile,
	platform = process.platform,
	now = Date.now,
	home = homedir(),
	tmp = tmpdir(),
	post,
	log = console.error,
	pressure = osPressure(platform),
	read = readText,
}: JobRunnerOptions): JobRunner => {
	const running = new Map<string, Running>();
	let config: JobConfig = emptyJobConfig;
	let refusing: string | null = "not read its config yet";
	let ceiling: Ceiling = ceilingOf(config, false);
	let sandboxChecked: { key: string; passed: string | null } | null = null;
	let awake: ChildProcess | null = null;

	const signal = (job: Running, name: NodeJS.Signals) => {
		const pid = job.child?.pid;
		if (pid === undefined) return;
		try {
			process.kill(-pid, name);
		} catch {
			try {
				job.child?.kill(name);
			} catch {}
		}
	};

	const kill = (job: Running) => {
		signal(job, "SIGCONT");
		signal(job, "SIGTERM");
		const child = job.child;
		setTimeout(() => {
			if (child && child.exitCode === null && child.signalCode === null)
				signal(job, "SIGKILL");
		}, 5_000).unref();
	};

	const keepAwake = () => {
		const want = platform === "darwin" && config.keepAwake && running.size > 0;
		if (want && !awake) {
			awake = spawn(
				"/usr/bin/caffeinate",
				["-i", "-s", "-w", String(process.pid)],
				{
					stdio: "ignore",
				},
			);
			awake.on("error", () => {
				awake = null;
			});
		} else if (!want && awake) {
			awake.kill();
			awake = null;
		}
	};

	const sandboxArgs = (scratch: string): string[] =>
		config.sandbox
			? [
					"/usr/bin/sandbox-exec",
					"-f",
					config.sandbox.profile,
					"-D",
					`SCRATCH=${scratch}`,
					"-D",
					`HOME=${home}`,
					...Object.entries(config.sandbox.params).flatMap(([key, value]) => [
						"-D",
						`${key}=${value}`,
					]),
				]
			: [];

	const wrap = (scratch: string, command: string[]): string[] => [
		...(config.background && platform === "darwin"
			? ["/usr/sbin/taskpolicy", "-b"]
			: []),
		...sandboxArgs(scratch),
		...command,
	];

	const scratchFolder = async () =>
		realpath(await mkdtemp(join(tmp, "kanban-job-")));

	const checkSandbox = async (): Promise<string | null> => {
		const sandbox = config.sandbox;
		if (!sandbox) return null;
		const key = JSON.stringify(sandbox);
		if (sandboxChecked?.key === key) return sandboxChecked.passed;
		if (platform !== "darwin") {
			sandboxChecked = {
				key,
				passed: "a sandbox profile needs macOS's sandbox-exec",
			};
			return sandboxChecked.passed;
		}
		const scratch = await scratchFolder();
		const canary = join(home, ".config", "kanban", "sandbox-canary");
		try {
			await mkdir(join(home, ".config", "kanban"), { recursive: true });
			await writeFile(canary, "a job must not read this\n", { mode: 0o600 });
			const [file, ...args] = [
				...sandboxArgs(scratch),
				"/bin/sh",
				sandbox.selfTest,
				canary,
				scratch,
			];
			const { code, out } = await run(file as string, args);
			sandboxChecked = {
				key,
				passed:
					code === 0
						? null
						: `the sandbox self-test failed: ${out.trim() || `exit ${code}`}`,
			};
		} finally {
			await rm(scratch, { recursive: true, force: true });
		}
		log(
			`kanban-runner: sandbox self-test ${sandboxChecked.passed === null ? "passed" : sandboxChecked.passed}`,
		);
		return sandboxChecked.passed;
	};

	const used = () =>
		[...running.values()].reduce(
			(sum, job) => ({
				cores: sum.cores + job.cores,
				memoryMb: sum.memoryMb + job.memoryMb,
			}),
			{ cores: 0, memoryMb: 0 },
		);

	const finish = async (
		job: Running,
		result: RunnerJobResult,
		scratch: string,
	) => {
		running.delete(job.id);
		keepAwake();
		await rm(scratch, { recursive: true, force: true }).catch(() => {});
		if (job.silenced) return;
		await post(job.id, job.attempt, result).catch((error: Error) =>
			log(
				`kanban-runner: couldn't send job ${job.id}'s result: ${error.message}`,
			),
		);
	};

	const execute = async (
		job: Running,
		spec: JobClassConfig,
		input: Buffer,
		deadline: number,
	) => {
		const started = now();
		const scratch = await scratchFolder();
		await mkdir(join(scratch, "tmp"));
		if (job.silenced)
			return finish(job, { ok: false, error: "stopped", ms: 0 }, scratch);
		const [file, ...args] = wrap(scratch, spec.command);
		const child = spawn(file as string, args, {
			cwd: scratch,
			detached: true,
			stdio: ["pipe", "pipe", "pipe"],
			env: {
				HOME: scratch,
				TMPDIR: join(scratch, "tmp"),
				PATH: "/usr/bin:/bin",
				LANG: "C.UTF-8",
				KANBAN_JOB_ID: job.id,
				KANBAN_JOB_ATTEMPT: String(job.attempt),
			},
		});
		job.child = child;
		if (config.background && platform !== "darwin" && child.pid !== undefined) {
			try {
				setPriority(child.pid, 19);
			} catch {}
		}
		const out: Buffer[] = [];
		let size = 0;
		let tooBig = false;
		let errTail = "";
		child.stdout?.on("data", (chunk: Buffer) => {
			size += chunk.length;
			if (size > maxOutputBytes) {
				tooBig = true;
				kill(job);
			} else out.push(chunk);
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			errTail = `${errTail}${chunk.toString("utf8")}`.slice(-400);
		});
		child.stdin?.on("error", () => {});
		child.stdin?.end(input);
		const timer = setTimeout(() => kill(job), Math.max(0, deadline - now()));
		const ended = await new Promise<{
			code: number | null;
			error: string | null;
		}>((resolve) => {
			child.on("error", (error) =>
				resolve({ code: null, error: error.message }),
			);
			child.on("close", (code) => resolve({ code, error: null }));
		});
		clearTimeout(timer);
		const ms = now() - started;
		if (job.handedBack) {
			return finish(
				job,
				{ ok: false, error: job.handedBack, ms, requeue: true },
				scratch,
			);
		}
		if (ended.error)
			return finish(job, { ok: false, error: ended.error, ms }, scratch);
		if (tooBig) {
			return finish(
				job,
				{ ok: false, error: `output over ${maxOutputBytes} bytes`, ms },
				scratch,
			);
		}
		if (now() >= deadline)
			return finish(
				job,
				{ ok: false, error: "passed its deadline", ms },
				scratch,
			);
		if (ended.code !== 0) {
			return finish(
				job,
				{
					ok: false,
					error: `exit ${ended.code}: ${errTail.trim().slice(-300)}`,
					ms,
				},
				scratch,
			);
		}
		return finish(
			job,
			{ ok: true, output: Buffer.concat(out).toString("base64"), ms },
			scratch,
		);
	};

	const refuse = (job: RunnerJob["job"], error: string) => {
		log(`kanban-runner: refused job ${job.id} (${job.class}): ${error}`);
		void post(job.id, job.attempt, {
			ok: false,
			error,
			ms: 0,
			refused: true,
		}).catch(() => {});
	};

	return {
		async report(state) {
			config = parseJobConfig(await read(configFile));
			const pressured = config.manners?.memoryPressure
				? await pressure().catch(() => false)
				: false;
			const machine = { ...state, pressured };
			ceiling = ceilingOf(config, state.sessionsWorking);
			const manners = mannersBlock(config.manners, machine);
			const sandbox = await checkSandbox().catch(
				(error: Error) => error.message,
			);
			refusing =
				Object.keys(config.classes).length === 0
					? "this machine's config lists no job class"
					: (sandbox ?? manners);
			const at = now();
			for (const job of running.values()) {
				if (manners && job.pausedAt === null) {
					job.pausedAt = at;
					signal(job, "SIGSTOP");
					log(`kanban-runner: paused job ${job.id}: ${manners}`);
				} else if (!manners && job.pausedAt !== null) {
					job.pausedAt = null;
					signal(job, "SIGCONT");
					log(`kanban-runner: resumed job ${job.id}`);
				} else if (
					job.pausedAt !== null &&
					at - job.pausedAt >= pausedGiveUpMs &&
					!job.handedBack
				) {
					job.handedBack = `paused over a minute: ${manners}`;
					kill(job);
				}
			}
			const { cores, memoryMb } = used();
			const fitsOne = Object.values(config.classes).some(
				(spec) =>
					cores + spec.cores <= ceiling.cores &&
					memoryMb + spec.memoryMb <= ceiling.memoryMb,
			);
			return {
				classes: Object.entries(config.classes).map(([name, spec]) => ({
					name,
					personal: spec.personal,
				})),
				refusing,
				slotsFree:
					refusing || !fitsOne ? 0 : Math.max(0, ceiling.slots - running.size),
				running: [...running.values()].map((job) => ({
					id: job.id,
					attempt: job.attempt,
					paused: job.pausedAt !== null,
				})),
			};
		},
		start(job) {
			const spec = config.classes[job.class];
			if (!spec) {
				return refuse(
					job,
					`${job.class} is not on this machine's list of job classes`,
				);
			}
			if (refusing) return refuse(job, refusing);
			if (running.has(job.id)) return refuse(job, "already running this job");
			const { cores, memoryMb } = used();
			if (
				running.size >= ceiling.slots ||
				cores + spec.cores > ceiling.cores ||
				memoryMb + spec.memoryMb > ceiling.memoryMb
			) {
				return refuse(job, "no room under this machine's ceiling");
			}
			const entry: Running = {
				id: job.id,
				attempt: job.attempt,
				class: job.class,
				cores: spec.cores,
				memoryMb: spec.memoryMb,
				child: null,
				pausedAt: null,
				silenced: false,
				handedBack: null,
			};
			running.set(job.id, entry);
			keepAwake();
			void execute(
				entry,
				spec,
				Buffer.from(job.input, "base64"),
				job.deadline,
			).catch((error: Error) => {
				running.delete(job.id);
				keepAwake();
				if (!entry.silenced) {
					void post(job.id, job.attempt, {
						ok: false,
						error: error.message,
						ms: 0,
					}).catch(() => {});
				}
			});
		},
		stop(ids, why) {
			for (const id of ids) {
				const job = running.get(id);
				if (!job) continue;
				job.silenced = true;
				log(`kanban-runner: stopping job ${id}: ${why}`);
				kill(job);
			}
		},
		stopAll(why) {
			this.stop([...running.keys()], why);
		},
		busy: () => running.size > 0,
	};
};
