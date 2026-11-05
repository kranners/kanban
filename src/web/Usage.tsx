import "./usage.css";
import type { JSX } from "preact";
import { useState } from "preact/hooks";
import type {
	AccountUsage,
	FailoverView,
	Session,
	Usage,
	UsageSample,
	UsageWindow,
} from "../shared/types.ts";
import { ActivityIcon, activityLabel } from "./activity.tsx";
import { RunnersSection } from "./Runners.tsx";
import { board, now, openSession } from "./state.ts";
import { ago } from "./time.ts";
import {
	accountHold,
	accountLabel,
	chartSpanMs,
	defaultAccount,
	type Frame,
	linePath,
	makeDefault,
	nearestSample,
	type Severity,
	sessionsByAccount,
	severity,
	untilReset,
	usage,
	xOf,
	yOf,
} from "./usage.ts";

const series = [
	{ key: "week", label: "Week" },
	{ key: "session", label: "5-hour session" },
] as const;

const percent = (window: UsageWindow | null) =>
	window ? `${Math.round(window.percent)}%` : "–";

const worst = (...windows: (UsageWindow | null)[]) =>
	severity(Math.max(0, ...windows.map((window) => window?.percent ?? 0)));

const clock = (at: number) =>
	new Date(at).toLocaleString(undefined, {
		weekday: "short",
		hour: "numeric",
		minute: "2-digit",
	});

const sparkFrame = (to: number): Frame => ({
	from: to - chartSpanMs,
	to,
	width: 40,
	height: 14,
});

export function usageGlance(current: Usage): {
	level: Severity;
	stale: boolean;
	label: string;
} {
	const { session, week, error, accounts } = current;
	const chosen = accounts.length > 1 ? defaultAccount(current) : null;
	const owner = chosen ? ` on ${accountLabel(chosen)} (${chosen.email})` : "";
	return {
		level: worst(session, week),
		stale: error !== null,
		label: `Claude usage${owner}: 5-hour session ${percent(session)}, week ${percent(week)}${error ? `; ${error}` : ""}`,
	};
}

export function UsageView(): JSX.Element | null {
	const current = usage.value;
	if (!current) {
		return (
			<div class="usage-view">
				<RunnersSection />
			</div>
		);
	}
	const { samples, error, accounts } = current;
	const at = now.value;
	const chosen = accounts.length > 1 ? defaultAccount(current) : null;
	return (
		<div class="usage-view">
			{chosen && (
				<p class="usage-owner">
					<span class="usage-account">{accountLabel(chosen)}</span>
					<span class="usage-owner-email">{chosen.email}</span>
				</p>
			)}
			<dl class="usage-windows">
				{series.map(({ key, label }) => {
					const window = current[key];
					return (
						<div key={key} class={`usage-window series-${key}`}>
							<dt>
								<span class="usage-key" aria-hidden="true" />
								{label}
							</dt>
							<dd>
								<span class="num">{percent(window)}</span>
								{window?.resetsAt != null && (
									<span
										class="usage-reset"
										title={`Resets ${clock(window.resetsAt)}`}
									>
										resets in {untilReset(window.resetsAt, at)}
									</span>
								)}
							</dd>
							<span class="usage-bar" aria-hidden="true">
								<span
									style={{
										width: `${Math.min(100, window?.percent ?? 0)}%`,
									}}
								/>
							</span>
						</div>
					);
				})}
			</dl>
			<UsageChart samples={samples} to={at} />
			{current.failover?.allLimited && (
				<p class="usage-all-limited" role="alert">
					Every Claude account is at its limit.
					{current.failover.allLimited.until !== null &&
						` The first frees up ${clock(current.failover.allLimited.until)}; sessions stopped on a limit move then.`}
				</p>
			)}
			{accounts.some((account) => !account.isDefault) && (
				<AccountList
					accounts={accounts}
					at={at}
					sessions={sessionsByAccount(board.value?.sessions ?? [], accounts)}
					failover={current.failover ?? null}
				/>
			)}
			{current.failover && current.failover.moves.length > 0 && (
				<MovedList moves={current.failover.moves} at={at} />
			)}
			<p class={`usage-status${error ? " usage-error" : ""}`}>
				{error ??
					(current.checkedAt
						? `Checked ${ago(current.checkedAt, at)}`
						: "Checking…")}
			</p>
			<RunnersSection />
		</div>
	);
}

function AccountList(props: {
	accounts: readonly AccountUsage[];
	at: number;
	sessions: Map<string, Session[]>;
	failover: FailoverView | null;
}): JSX.Element {
	const [pending, setPending] = useState<number | null>(null);
	const [failure, setFailure] = useState<{
		account: number;
		error: string;
	} | null>(null);
	const choose = async (account: number) => {
		setPending(account);
		setFailure(null);
		const result = await makeDefault(account);
		setPending(null);
		if (!result.ok) setFailure({ account, error: result.error });
	};
	return (
		<ul class="usage-accounts" aria-label="Claude accounts">
			{props.accounts.map((account) => (
				<AccountRow
					key={account.id}
					account={account}
					at={props.at}
					pending={pending}
					error={
						failure?.account === account.number
							? failure.error
							: (account.blocked ?? account.error)
					}
					hold={accountHold(account, props.failover?.cooldowns ?? {}, props.at)}
					sessions={props.sessions.get(account.id) ?? []}
					onChoose={() => void choose(account.number)}
				/>
			))}
		</ul>
	);
}

function AccountRow(props: {
	account: AccountUsage;
	at: number;
	pending: number | null;
	error: string | null;
	hold: string | null;
	sessions: readonly Session[];
	onChoose: () => void;
}): JSX.Element {
	const { account } = props;
	const name = account.alias ?? account.email;
	return (
		<li class={`usage-account-row${account.isDefault ? " is-default" : ""}`}>
			<div class="usage-account-head">
				<span class="usage-account-name" title={account.organization}>
					{account.alias ?? account.email}
				</span>
				<svg
					class="usage-spark"
					viewBox="0 0 40 14"
					width="40"
					height="14"
					aria-hidden="true"
				>
					<path d={linePath(account.samples, "week", sparkFrame(props.at))} />
				</svg>
				{account.disabled && (
					<span class="usage-default-tag" title="Held out with cswap disable">
						Held out
					</span>
				)}
				{account.isDefault ? (
					<span class="usage-default-tag">Default</span>
				) : (
					<button
						type="button"
						class="usage-make-default"
						aria-label={`Make ${account.alias ?? account.email} the default account`}
						title="Switch the default Claude login; sessions on it move to this account"
						disabled={props.pending !== null}
						onClick={props.onChoose}
					>
						{props.pending === account.number ? "Switching…" : "Make default"}
					</button>
				)}
			</div>
			<AccountWindow
				series="session"
				label="5h"
				window={account.session}
				at={props.at}
			/>
			<AccountWindow
				series="week"
				label="Week"
				window={account.week}
				at={props.at}
			/>
			{props.error && <p class="usage-account-error">{props.error}</p>}
			{props.hold && <p class="usage-account-hold">{props.hold}</p>}
			<p class="usage-account-count">
				{props.sessions.length === 0
					? "No sessions on it"
					: `${props.sessions.length} ${props.sessions.length === 1 ? "session" : "sessions"} on it`}
			</p>
			{props.sessions.length > 0 && (
				<ul class="usage-runner-sessions" aria-label={`On ${name}`}>
					{props.sessions.map((session) => (
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
							</button>
						</li>
					))}
				</ul>
			)}
		</li>
	);
}

function MovedList(props: {
	moves: FailoverView["moves"];
	at: number;
}): JSX.Element {
	return (
		<section class="usage-moves" aria-labelledby="usage-moves-title">
			<h3 id="usage-moves-title" class="usage-section-title">
				Moved off a limit
			</h3>
			<ul class="usage-runner-sessions">
				{props.moves.slice(0, 6).map((move) => (
					<li key={`${move.sessionId}-${move.at}`}>
						<button
							type="button"
							class="usage-runner-session"
							title={`Moved ${ago(move.at, props.at)}`}
							onClick={(event) =>
								openSession(
									move.sessionId,
									event.currentTarget.getBoundingClientRect(),
								)
							}
						>
							<span class="usage-runner-session-name">
								{move.name}: {move.from} to {move.to}
							</span>
						</button>
					</li>
				))}
			</ul>
		</section>
	);
}

function AccountWindow(props: {
	series: (typeof series)[number]["key"];
	label: string;
	window: UsageWindow | null;
	at: number;
}): JSX.Element {
	const { window } = props;
	return (
		<div
			class={`usage-account-window series-${props.series} usage-${severity(window?.percent ?? 0)}`}
		>
			<span class="usage-account-label">{props.label}</span>
			<span class="usage-bar" aria-hidden="true">
				<span style={{ width: `${Math.min(100, window?.percent ?? 0)}%` }} />
			</span>
			<span class="num usage-account-percent">{percent(window)}</span>
			{window?.resetsAt != null ? (
				<span class="usage-reset" title={`Resets ${clock(window.resetsAt)}`}>
					{untilReset(window.resetsAt, props.at)}
				</span>
			) : (
				<span class="usage-reset" />
			)}
		</div>
	);
}

const chart = { width: 288, height: 96, left: 30, top: 8, bottom: 18 };

function UsageChart(props: {
	samples: readonly UsageSample[];
	to: number;
}): JSX.Element {
	const [hovered, setHovered] = useState<UsageSample | null>(null);
	const frame: Frame = {
		from: props.to - chartSpanMs,
		to: props.to,
		width: chart.width - chart.left,
		height: chart.height - chart.top - chart.bottom,
	};
	const hover = (event: PointerEvent) => {
		const svg = event.currentTarget as SVGSVGElement;
		const box = svg.getBoundingClientRect();
		const x = ((event.clientX - box.left) / box.width) * chart.width;
		const at =
			frame.from + ((x - chart.left) / frame.width) * (frame.to - frame.from);
		setHovered(nearestSample(props.samples, at, frame));
	};
	return (
		<figure class="usage-chart">
			<svg
				viewBox={`0 0 ${chart.width} ${chart.height}`}
				role="img"
				aria-label="Usage over the last 7 days"
				onPointerMove={hover}
				onPointerLeave={() => setHovered(null)}
			>
				{[0, 50, 100].map((tick) => (
					<g key={tick} class="usage-grid">
						<line
							x1={chart.left}
							x2={chart.width}
							y1={chart.top + yOf(tick, frame)}
							y2={chart.top + yOf(tick, frame)}
						/>
						<text x={chart.left - 6} y={chart.top + yOf(tick, frame) + 3}>
							{tick}%
						</text>
					</g>
				))}
				<text
					class="usage-axis usage-axis-start"
					x={chart.left}
					y={chart.height - 3}
				>
					7 days ago
				</text>
				<text class="usage-axis" x={chart.width} y={chart.height - 3}>
					now
				</text>
				<g transform={`translate(${chart.left} ${chart.top})`}>
					{series.map(({ key }) => (
						<path
							key={key}
							class={`usage-line series-${key}`}
							d={linePath(props.samples, key, frame)}
						/>
					))}
					{hovered && (
						<g class="usage-crosshair">
							<line
								x1={xOf(hovered.at, frame)}
								x2={xOf(hovered.at, frame)}
								y1={0}
								y2={frame.height}
							/>
							{series.map(({ key }) => (
								<circle
									key={key}
									class={`series-${key}`}
									cx={xOf(hovered.at, frame)}
									cy={yOf(hovered[key], frame)}
									r={4}
								/>
							))}
						</g>
					)}
				</g>
			</svg>
			<figcaption>
				{hovered
					? `${clock(hovered.at)} · week ${Math.round(hovered.week)}% · session ${Math.round(hovered.session)}%`
					: props.samples.length > 0
						? "Hover the chart for a reading"
						: "No history yet"}
			</figcaption>
		</figure>
	);
}
