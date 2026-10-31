const architecture = [
	"```mermaid",
	"flowchart LR",
	'  web["Checkout"] --> gateway["Gateway"]',
	'  mobile["Mobile app"] --> gateway',
	'  gateway --> orders["/v3/orders"]',
	'  gateway --> payments["/v3/payments"]',
	'  orders --> db["Orders DB"]',
	'  payments --> provider["Card provider"]',
	"```",
].join("\n");

const draft = [
	"# Orders v3 handbook",
	"",
	"How the v3 orders API fits together, kept up to date by the sessions building it.",
	"",
	"## Architecture",
	"",
	architecture,
].join("\n");

const index = [
	draft,
	"",
	"A checkout request crosses three services before it is confirmed:",
	"",
	"![Request flow through the v3 API](assets/request-flow.svg)",
	"",
	"## Guides",
	"",
	"- [Orders](guides/orders.md): endpoints, totals and tax lines",
	"- [Payments](guides/payments.md): refunds and idempotency keys",
	"- [Moving from v2](guides/migration.md): what clients must change",
	"- [Rolling out v3](guides/rollout.md): canary steps and rollback",
].join("\n");

const orders = [
	"# Orders",
	"",
	"[Back to the handbook](../index.md)",
	"",
	"v3 keeps every v2 order field and adds explicit tax lines and currency.",
	"",
	"| Endpoint | Method | Notes |",
	"| --- | --- | --- |",
	"| `/v3/orders` | `POST` | Idempotent with `Idempotency-Key` |",
	"| `/v3/orders/:id` | `GET` | Includes `totals.tax[]` |",
	"| `/v3/orders/:id/cancel` | `POST` | Refunds through [payments](payments.md#refunds) |",
	"",
	"## Totals",
	"",
	"```json",
	"{",
	'  "totals": {',
	'    "currency": "AUD",',
	'    "subtotal": 4200,',
	'    "tax": [{ "name": "GST", "amount": 420 }],',
	'    "total": 4620',
	"  }",
	"}",
	"```",
	"",
	"Amounts are integers in cents. `currency` is always present.",
].join("\n");

const payments = [
	"# Payments",
	"",
	"[Back to the handbook](../index.md)",
	"",
	"## Refunds",
	"",
	"Refunds go through four code paths, and every one now checks the idempotency key before it writes.",
	"",
	"1. Full refund on cancel",
	"2. Partial refund from support",
	"3. Refund after a failed capture",
	"4. Chargeback reversal",
	"",
	"## Idempotency keys",
	"",
	"Send `Idempotency-Key` on every `POST`. A retry with the same key returns the first response.",
].join("\n");

const migration = [
	"# Moving from v2",
	"",
	"[Back to the handbook](../index.md)",
	"",
	"- Read totals from `totals.total`, not `amount`",
	"- Show each line of `totals.tax`",
	"- Three payment fields are renamed; see [Payments](payments.md)",
	"",
	"v2 stays up for 90 days after v3 reaches 100%.",
].join("\n");

const rollout = [
	"# Rolling out v3",
	"",
	"[Back to the handbook](../index.md)",
	"",
	"| Step | Traffic | Check |",
	"| --- | --- | --- |",
	"| Canary | 5% | Error rate under 0.1% |",
	"| Widen | 25% | p99 under 250 ms, then the rollback drill |",
	"| Half | 50% | Contract tests green |",
	"| Full | 100% | Turn off v2 writes |",
	"",
	"Rollback: point the gateway back at v2. Orders written on v3 stay readable from v2.",
].join("\n");

const box = (x: number, label: string, fill: string) =>
	`<rect x="${x}" y="40" width="150" height="64" rx="12" fill="${fill}"/><text x="${x + 75}" y="78" text-anchor="middle">${label}</text>`;

const arrow = (x: number) =>
	`<path d="M${x} 72h44" stroke="#64748b" stroke-width="3" marker-end="url(#head)"/>`;

const requestFlow = [
	'<svg xmlns="http://www.w3.org/2000/svg" width="640" height="144" viewBox="0 0 640 144" font-family="Inter, system-ui, sans-serif" font-size="16" font-weight="600" fill="#0f172a">',
	'<defs><marker id="head" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0L10 5L0 10z" fill="#64748b"/></marker></defs>',
	'<rect width="640" height="144" rx="16" fill="#f8fafc"/>',
	box(24, "Checkout", "#ccfbf1"),
	arrow(178),
	box(226, "/v3/orders", "#e0e7ff"),
	arrow(380),
	box(428, "/v3/payments", "#fef3c7"),
	'<text x="320" y="128" text-anchor="middle" font-size="13" font-weight="400" fill="#475569">p99 at 2x peak: 182 ms</text>',
	"</svg>",
].join("");

export const handbook = {
	id: "v3-handbook",
	title: "Orders v3 handbook",
	draft,
	index,
	orders,
	payments,
	migration,
	rollout,
	requestFlow,
};
