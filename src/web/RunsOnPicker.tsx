import type { JSX } from "preact";
import { useCallback, useEffect, useState } from "preact/hooks";
import {
	type FixedRunsOn,
	isRemoteHost,
	type RemoteHost,
	type RunsOn,
	runsOnChoices,
} from "../shared/types.ts";
import {
	directoryName,
	remoteHostsUrl,
	runsOnBlockerUrl,
} from "./focus/paths.ts";

const runsOnLabels: Record<FixedRunsOn, string> = {
	cloud: "Cloud",
	local: "This Mac",
};

const remoteHostLabel = (host: RemoteHost): string =>
	`${host.machine} · ${directoryName(host.directory)}`;

export function RunsOnPicker(props: {
	runsOn: RunsOn;
	onPick: (runsOn: RunsOn) => void;
	account?: number;
	disabled?: boolean;
	class?: string;
	labelledBy?: string;
}): JSX.Element {
	const [hosts, refresh] = useRemoteHosts(props.account);
	const lost =
		isRemoteHost(props.runsOn) && !hosts.some(({ id }) => id === props.runsOn);
	return (
		<select
			aria-labelledby={props.labelledBy}
			aria-label={props.labelledBy ? undefined : "Where it runs"}
			class={props.class}
			value={props.runsOn}
			disabled={props.disabled}
			title="Where this session runs"
			onFocus={refresh}
			onChange={(event) => props.onPick(event.currentTarget.value as RunsOn)}
		>
			{runsOnChoices.map((choice) => (
				<option key={choice} value={choice}>
					{runsOnLabels[choice]}
				</option>
			))}
			{hosts.map((host) => (
				<option key={host.id} value={host.id} title={host.directory}>
					{remoteHostLabel(host)}
				</option>
			))}
			{lost && <option value={props.runsOn}>Stopped host</option>}
		</select>
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

export function useRunsOnBlocker(
	cwd: string,
	runsOn: RunsOn,
	account?: number,
): string | null {
	const key = `${cwd}\n${runsOn}\n${account ?? ""}`;
	const [checked, setChecked] = useState<{
		key: string;
		reason: string | null;
	} | null>(null);
	useEffect(() => {
		if (runsOn === "local" || cwd === "") return;
		let current = true;
		fetch(runsOnBlockerUrl(cwd, runsOn, account))
			.then((response) => response.json())
			.then(({ reason }: { reason: string | null }) => {
				if (current) setChecked({ key, reason });
			})
			.catch(() => {});
		return () => {
			current = false;
		};
	}, [key, cwd, runsOn, account]);
	return runsOn !== "local" && checked?.key === key ? checked.reason : null;
}
