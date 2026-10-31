import { Cloud, Laptop, RadioTower } from "lucide-preact";
import type { JSX } from "preact";
import { useCallback, useEffect, useState } from "preact/hooks";
import {
	defaultRunsOn,
	type RemoteHost,
	type RunsOn,
} from "../shared/types.ts";
import { type Choice, ChoiceMenu } from "./ChoiceMenu.tsx";
import {
	directoryName,
	remoteHostsUrl,
	runsOnBlockerUrl,
} from "./focus/paths.ts";

export type RunsOnChoices = {
	runsOn: RunsOn;
	choices: Choice<RunsOn>[];
	pick: (runsOn: RunsOn) => void;
	refresh: () => void;
};

export function useRunsOn(cwd: string, account?: number): RunsOnChoices {
	const [picked, pick] = useState<RunsOn>(defaultRunsOn);
	const [hosts, refresh] = useRemoteHosts(account);
	const unchecked: RunsOn[] = ["cloud", ...hosts.map(({ id }) => id as RunsOn)];
	const blocked = useBlockers(cwd, unchecked, account);
	const choices: Choice<RunsOn>[] = [
		{
			value: "cloud",
			label: "Cloud",
			icon: Cloud,
			blocked: blocked.get("cloud"),
		},
		{ value: "local", label: "This Mac", icon: Laptop },
		...hosts.map(
			(host): Choice<RunsOn> => ({
				value: host.id as RunsOn,
				label: host.machine,
				detail: directoryName(host.directory),
				icon: RadioTower,
				blocked: blocked.get(host.id as RunsOn),
			}),
		),
	];
	const usable = choices.some(
		({ value, blocked }) => value === picked && !blocked,
	);
	return { runsOn: usable ? picked : "local", choices, pick, refresh };
}

export function RunsOnPicker(props: {
	runs: RunsOnChoices;
	variant: "chip" | "field";
	disabled?: boolean;
	lockedBecause?: string;
	labelledBy?: string;
	onPicked?: () => void;
}): JSX.Element {
	const { runs } = props;
	return (
		<ChoiceMenu
			choices={runs.choices}
			value={runs.runsOn}
			onPick={(runsOn) => {
				runs.pick(runsOn);
				props.onPicked?.();
			}}
			onOpen={runs.refresh}
			label="Where it runs"
			title={props.lockedBecause ?? "Where this session runs"}
			variant={props.variant}
			labelledBy={props.labelledBy}
			disabled={props.disabled || props.lockedBecause !== undefined}
		/>
	);
}

function useRemoteHosts(account?: number): [RemoteHost[], () => void] {
	const [hosts, setHosts] = useState<RemoteHost[]>([]);
	const [asked, setAsked] = useState(0);
	const refresh = useCallback(() => setAsked((count) => count + 1), []);
	useEffect(() => {
		let current = true;
		fetch(remoteHostsUrl(account))
			.then((response) => response.json())
			.then((listed: { hosts: RemoteHost[] }) => {
				if (current) setHosts(listed.hosts);
			})
			.catch(() => {});
		return () => {
			current = false;
		};
	}, [account, asked]);
	return [hosts, refresh];
}

function useBlockers(
	cwd: string,
	choices: RunsOn[],
	account?: number,
): Map<RunsOn, string | null> {
	const scope = `${cwd}\n${account ?? ""}`;
	const key = [scope, ...choices].join("\n");
	const [checked, setChecked] = useState<{
		scope: string;
		reasons: Map<RunsOn, string | null>;
	} | null>(null);
	useEffect(() => {
		if (cwd === "") return;
		let current = true;
		const runsOns = key.split("\n").slice(2) as RunsOn[];
		Promise.all(
			runsOns.map((runsOn) =>
				fetch(runsOnBlockerUrl(cwd, runsOn, account))
					.then((response) => response.json())
					.then(({ reason }: { reason: string | null }) => [runsOn, reason])
					.catch(() => [runsOn, null]),
			),
		).then((reasons) => {
			if (current)
				setChecked({
					scope,
					reasons: new Map(reasons as [RunsOn, string | null][]),
				});
		});
		return () => {
			current = false;
		};
	}, [key, scope, cwd, account]);
	return checked?.scope === scope ? checked.reasons : new Map();
}
