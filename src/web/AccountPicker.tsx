import type { JSX } from "preact";
import { accountLabel, pickableAccounts, usage } from "./usage.ts";

export function AccountPicker(props: {
	account: number | undefined;
	onPick: (account: number | undefined) => void;
	disabled?: boolean;
	class?: string;
	labelledBy?: string;
}): JSX.Element | null {
	const pickable = pickableAccounts(usage.value);
	if (!pickable) return null;
	const { accounts, fallback } = pickable;
	return (
		<select
			aria-labelledby={props.labelledBy}
			class={props.class}
			value={String(props.account ?? fallback.number)}
			disabled={props.disabled}
			aria-label="Claude account"
			title="Claude account for this session"
			onChange={(event) => {
				const picked = Number(event.currentTarget.value);
				props.onPick(picked === fallback.number ? undefined : picked);
			}}
		>
			{accounts.map((account) => (
				<option key={account.id} value={String(account.number)}>
					{`${accountLabel(account)} · ${account.email}${account.isDefault ? " (default)" : ""}`}
				</option>
			))}
		</select>
	);
}
