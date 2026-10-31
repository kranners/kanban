import { UserRound } from "lucide-preact";
import type { JSX } from "preact";
import { ChoiceMenu } from "./ChoiceMenu.tsx";
import { accountLabel, pickableAccounts, usage } from "./usage.ts";

export function AccountPicker(props: {
	account: number | undefined;
	onPick: (account: number | undefined) => void;
	variant: "chip" | "field";
	disabled?: boolean;
	labelledBy?: string;
}): JSX.Element | null {
	const pickable = pickableAccounts(usage.value);
	if (!pickable) return null;
	const { accounts, fallback } = pickable;
	return (
		<ChoiceMenu
			choices={accounts.map((account) => ({
				value: String(account.number),
				label: accountLabel(account),
				detail: `${account.email}${account.isDefault ? " (default)" : ""}`,
				icon: UserRound,
			}))}
			value={String(props.account ?? fallback.number)}
			onPick={(value) => {
				const picked = Number(value);
				props.onPick(picked === fallback.number ? undefined : picked);
			}}
			label="Claude account"
			title="Claude account for this session"
			variant={props.variant}
			labelledBy={props.labelledBy}
			disabled={props.disabled}
		/>
	);
}
