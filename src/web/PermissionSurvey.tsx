import "./focus/focus.css";
import "./actions.css";
import "./permissions.css";
import {
	CircleAlert,
	LoaderCircle,
	ShieldCheck,
	TriangleAlert,
	X,
} from "lucide-preact";
import type { JSX } from "preact";
import { useEffect, useId, useRef, useState } from "preact/hooks";
import type {
	PermissionGrant,
	PermissionGrantResult,
	PermissionSurvey,
	PermissionSurveyEntry,
} from "../shared/permissions.ts";
import { errorOf } from "./exits.ts";
import { commandKey } from "./focus/platform.ts";
import {
	allRuleKeys,
	grantsFor,
	isBroadRule,
	narrowRuleKeys,
	ruleKey,
} from "./permissionSurvey.ts";
import { useRestoreFocus } from "./restoreFocus.ts";

type Fetched<T> = { ok: true; value: T } | { ok: false; error: string };

async function post<T>(path: string, body?: unknown): Promise<Fetched<T>> {
	try {
		const response = await fetch(path, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: body === undefined ? undefined : JSON.stringify(body),
		});
		if (!response.ok) return { ok: false, error: await errorOf(response) };
		return { ok: true, value: (await response.json()) as T };
	} catch (caught) {
		return { ok: false, error: `Couldn't reach the board server (${caught})` };
	}
}

const surveyPermissions = (): Promise<Fetched<PermissionSurvey>> =>
	post("/api/permissions/survey");

const grantPermissions = (
	grants: PermissionGrant[],
): Promise<Fetched<PermissionGrantResult[]>> =>
	post("/api/permissions/grant", grants);

type Phase =
	| { kind: "surveying" }
	| { kind: "failed"; error: string }
	| { kind: "choosing"; entries: PermissionSurveyEntry[]; error?: string }
	| {
			kind: "granting";
			entries: PermissionSurveyEntry[];
			approving: "selected" | "all";
	  }
	| {
			kind: "granted";
			entries: PermissionSurveyEntry[];
			results: PermissionGrantResult[];
	  };

function ErrorNote(props: { error: string; quiet?: boolean }) {
	return (
		<div class="focus-form-error" role={props.quiet ? undefined : "alert"}>
			<CircleAlert size={14} aria-hidden="true" />
			<p>{props.error}</p>
		</div>
	);
}

function GrantOutcome(props: { result: PermissionGrantResult | undefined }) {
	const { result } = props;
	if (!result) return null;
	if (!result.ok) return <ErrorNote error={result.error} />;
	return (
		<p class="permission-outcome">
			{result.added.length > 0
				? `Added ${result.added.length} to ${result.settingsPath}`
				: `Already allowed in ${result.settingsPath}`}
		</p>
	);
}

function SurveyEntry(props: {
	entry: PermissionSurveyEntry;
	selected: ReadonlySet<string>;
	locked: boolean;
	result: PermissionGrantResult | undefined;
	onToggle: (key: string) => void;
}) {
	const { entry } = props;
	return (
		<section class="permission-session">
			<header class="permission-session-header">
				<span class="permission-session-name">{entry.name}</span>
				<span class="permission-session-cwd focus-muted">{entry.cwd}</span>
			</header>
			{!entry.ok ? (
				<ErrorNote error={entry.error} quiet />
			) : entry.permissions.length === 0 ? (
				<p class="permission-skipped focus-muted">Needs nothing more</p>
			) : (
				<ul class="permission-rules">
					{entry.permissions.map((permission, at) => {
						const key = ruleKey(entry.sessionId, permission.rule);
						return (
							<li key={at}>
								<label class="permission-rule">
									<input
										type="checkbox"
										checked={props.selected.has(key)}
										disabled={props.locked}
										onChange={() => props.onToggle(key)}
									/>
									<span class="permission-rule-text">
										<code>{permission.rule}</code>
										{isBroadRule(permission.rule) && (
											<span class="permission-broad">
												<TriangleAlert size={12} aria-hidden="true" />
												Broad: a whole tool, a wildcard, or files outside the
												project
											</span>
										)}
										<span class="focus-muted">{permission.reason}</span>
									</span>
								</label>
							</li>
						);
					})}
				</ul>
			)}
			<GrantOutcome result={props.result} />
		</section>
	);
}

export function PermissionSurveyDialog(props: {
	onClose: () => void;
}): JSX.Element {
	const dialog = useRef<HTMLDialogElement>(null);
	const pressedBackdrop = useRef(false);
	const id = useId();
	const [phase, setPhase] = useState<Phase>({ kind: "surveying" });
	const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
	useRestoreFocus();

	useEffect(() => {
		dialog.current?.showModal();
		let live = true;
		void surveyPermissions().then((survey) => {
			if (!live) return;
			if (!survey.ok) {
				setPhase({ kind: "failed", error: survey.error });
				return;
			}
			setSelected(narrowRuleKeys(survey.value.entries));
			setPhase({ kind: "choosing", entries: survey.value.entries });
		});
		return () => {
			live = false;
		};
	}, []);

	const entries = "entries" in phase ? phase.entries : [];
	const results = phase.kind === "granted" ? phase.results : [];
	const everything = allRuleKeys(entries);
	const locked = phase.kind !== "choosing";
	const granting = phase.kind === "granting";
	const close = () => {
		if (!granting) props.onClose();
	};

	const grant = async (
		keys: ReadonlySet<string>,
		approving: "selected" | "all",
	) => {
		if (locked) return;
		const grants = grantsFor(entries, keys);
		if (grants.length === 0) return;
		setPhase({ kind: "granting", entries, approving });
		const granted = await grantPermissions(grants);
		setPhase(
			granted.ok
				? { kind: "granted", entries, results: granted.value }
				: { kind: "choosing", entries, error: granted.error },
		);
	};

	const toggle = (key: string) => {
		const next = new Set(selected);
		if (!next.delete(key)) next.add(key);
		setSelected(next);
	};

	return (
		<dialog
			class="focus-dialog permission-dialog"
			ref={dialog}
			onClose={props.onClose}
			onCancel={(event) => {
				if (granting) event.preventDefault();
			}}
			onPointerDown={(event) => {
				pressedBackdrop.current = event.target === event.currentTarget;
			}}
			onClick={(event) => {
				if (event.target === event.currentTarget && pressedBackdrop.current)
					close();
			}}
			onKeyDown={(event) => {
				if ((event.metaKey || event.ctrlKey) && event.key === "Enter")
					void grant(selected, "selected");
			}}
			aria-labelledby={`${id}-title`}
		>
			<div class="focus-form">
				<header class="focus-form-header">
					<h2 id={`${id}-title`} class="confirm-title">
						<ShieldCheck size={16} aria-hidden="true" />
						Permissions sessions expect to need
					</h2>
					<button
						type="button"
						class="focus-button focus-icon-button"
						onClick={close}
						disabled={granting}
						aria-label="Close"
					>
						<X size={16} />
					</button>
				</header>
				<div class="permission-body">
					{phase.kind === "surveying" && (
						<p class="permission-waiting focus-muted" role="status">
							<LoaderCircle size={14} class="focus-spin" aria-hidden="true" />
							Asking every running session what it will need…
						</p>
					)}
					{phase.kind === "failed" && <ErrorNote error={phase.error} />}
					{"entries" in phase && entries.length === 0 && (
						<p class="focus-muted">No sessions are running.</p>
					)}
					{entries.map((entry) => (
						<SurveyEntry
							key={entry.sessionId}
							entry={entry}
							selected={selected}
							locked={locked}
							result={results.find(
								(result) => result.sessionId === entry.sessionId,
							)}
							onToggle={toggle}
						/>
					))}
					{phase.kind === "choosing" && phase.error && (
						<ErrorNote error={phase.error} />
					)}
				</div>
				<footer class="focus-form-footer">
					<span class="focus-muted focus-form-shortcut">
						{phase.kind === "choosing" && (
							<>
								<kbd>{commandKey}Enter</kbd> to approve selected ·{" "}
							</>
						)}
						{!granting && (
							<>
								<kbd>Esc</kbd> to close
							</>
						)}
					</span>
					{phase.kind === "granted" ? (
						<button
							type="button"
							class="focus-button focus-button-primary"
							onClick={props.onClose}
						>
							Done
						</button>
					) : (
						<>
							<button
								type="button"
								class="focus-button"
								disabled={locked || grantsFor(entries, selected).length === 0}
								onClick={() => void grant(selected, "selected")}
							>
								{phase.kind === "granting" &&
									phase.approving === "selected" && (
										<LoaderCircle
											size={14}
											class="focus-spin"
											aria-hidden="true"
										/>
									)}
								Approve selected
							</button>
							<button
								type="button"
								class="focus-button focus-button-primary"
								disabled={locked || everything.size === 0}
								onClick={() => void grant(everything, "all")}
							>
								{phase.kind === "granting" && phase.approving === "all" && (
									<LoaderCircle
										size={14}
										class="focus-spin"
										aria-hidden="true"
									/>
								)}
								Approve all
							</button>
						</>
					)}
				</footer>
			</div>
		</dialog>
	);
}
