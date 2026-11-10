import type { JSX } from "preact";
import type { RunnerView } from "../shared/runners.ts";
import { ActivityIcon, activityLabel } from "./activity.tsx";
import {
	type Meter,
	meters,
	platformName,
	runners,
	sessionsMeter,
	signalWords,
	stateLabel,
} from "./runners.ts";
import { now, openSession } from "./state.ts";
import { ago } from "./time.ts";
import { severity } from "./usage.ts";

// The machines sessions can run on, in the Usage sidebar: what each is using
// and what the board has placed on it.
export function RunnersSection(): JSX.Element | null {
	const views = runners.value;
	if (views.length === 0) return null;
	const at = now.value;
	return (
		<section class="usage-runners" aria-labelledby="usage-runners-title">
			<h3 id="usage-runners-title" class="usage-section-title">
				Runners
			</h3>
			<ul class="usage-runner-list">
				{views.map((runner) => (
					<RunnerRow key={runner.id} runner={runner} at={at} />
				))}
			</ul>
		</section>
	);
}

function RunnerRow(props: { runner: RunnerView; at: number }): JSX.Element {
	const { runner } = props;
	const usage = meters(runner);
	const online = runner.state === "online";
	const platform = platformName(runner.platform);
	const label = stateLabel(runner, (at) => ago(at, props.at));
	const signals = online ? signalWords(runner) : null;
	return (
		<li
			class={`usage-runner-row runner-${runner.state}`}
			aria-label={`${runner.label}, ${label}`}
		>
			<div class="usage-runner-head">
				<span class="usage-runner-dot" aria-hidden="true" />
				<span class="usage-runner-name" title={runner.hostname ?? runner.name}>
					{runner.label}
				</span>
				{runner.local && runner.name !== runner.label && (
					<span class="usage-runner-host">{runner.name}</span>
				)}
				{platform && <span class="usage-runner-platform">{platform}</span>}
				<span class="usage-runner-state">{label}</span>
			</div>
			{usage && (
				<>
					<RunnerMeter label="CPU" meter={usage.cpu} />
					<RunnerMeter label="Mem" meter={usage.memory} />
					{usage.disk && <RunnerMeter label="Disk" meter={usage.disk} />}
				</>
			)}
			{signals && <div class="usage-runner-signals">{signals}</div>}
			{(online || runner.sessions.length > 0) && (
				<RunnerMeter
					label="Claude"
					meter={sessionsMeter(runner)}
					kind="allocation"
				/>
			)}
			{runner.sessions.length > 0 && (
				<ul class="usage-runner-sessions" aria-label={`On ${runner.label}`}>
					{runner.sessions.map((session) => (
						<li key={session.id}>
							<button
								type="button"
								class={`usage-runner-session act-${session.activity}`}
								title={`${activityLabel[session.activity]} · ${session.cwd}`}
								onClick={(event) =>
									openSession(
										session.id,
										event.currentTarget.getBoundingClientRect(),
									)
								}
							>
								<ActivityIcon activity={session.activity} size={11} />
								<span class="usage-runner-session-name">{session.name}</span>
								{session.cpuPercent !== null && (
									<span class="num usage-runner-session-load">
										{Math.round(session.cpuPercent)}%
									</span>
								)}
							</button>
						</li>
					))}
				</ul>
			)}
		</li>
	);
}

function RunnerMeter(props: {
	label: string;
	meter: Meter;
	kind?: "usage" | "allocation";
}): JSX.Element {
	const { meter } = props;
	const level =
		props.kind === "allocation"
			? meter.percent >= 100
				? "warning"
				: "normal"
			: severity(meter.percent);
	return (
		<div
			class={`usage-runner-meter usage-${level}${props.kind === "allocation" ? " is-allocation" : ""}`}
			title={`${props.label} ${meter.value}${meter.extra ? ` · ${meter.extra}` : ""}`}
		>
			<span class="usage-account-label">{props.label}</span>
			<span class="usage-bar" aria-hidden="true">
				<span style={{ width: `${meter.percent}%` }} />
			</span>
			<span class="num usage-account-percent">{meter.value}</span>
			<span class="usage-runner-extra">{meter.extra}</span>
		</div>
	);
}
