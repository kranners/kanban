import { asObject, asString, parseJson } from "./ingest/json.ts";

export type AgentStreamEvent =
	| { kind: "init"; sessionId: string }
	| { kind: "text"; text: string }
	| { kind: "tool-start"; id: string; name: string; input: unknown }
	| { kind: "tool-end"; id: string; text: string; isError: boolean }
	| { kind: "result"; isError: boolean; text: string };

const resultText = (content: unknown): string => {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.flatMap((block) => {
			const text = asString(asObject(block)?.text);
			return text === null ? [] : [text];
		})
		.join("\n");
};

const blocksOf = (
	record: Record<string, unknown>,
): Record<string, unknown>[] => {
	const content = asObject(record.message)?.content;
	return Array.isArray(content)
		? content.flatMap((block) => {
				const record = asObject(block);
				return record ? [record] : [];
			})
		: [];
};

export const parseStreamLine = (line: string): AgentStreamEvent[] => {
	const record = asObject(parseJson(line));
	if (!record) return [];
	switch (record.type) {
		case "system": {
			const sessionId = asString(record.session_id);
			return record.subtype === "init" && sessionId
				? [{ kind: "init", sessionId }]
				: [];
		}
		case "assistant":
			if (record.parent_tool_use_id) return [];
			return blocksOf(record).flatMap((block): AgentStreamEvent[] => {
				if (block.type === "text") {
					const text = asString(block.text)?.trim();
					return text ? [{ kind: "text", text }] : [];
				}
				if (block.type === "tool_use") {
					const id = asString(block.id);
					const name = asString(block.name);
					return id && name
						? [{ kind: "tool-start", id, name, input: block.input ?? {} }]
						: [];
				}
				return [];
			});
		case "user":
			return blocksOf(record).flatMap((block): AgentStreamEvent[] => {
				const id = asString(block.tool_use_id);
				if (block.type !== "tool_result" || !id) return [];
				return [
					{
						kind: "tool-end",
						id,
						text: resultText(block.content),
						isError: block.is_error === true,
					},
				];
			});
		case "result":
			return [
				{
					kind: "result",
					isError: record.is_error === true || record.subtype !== "success",
					text: asString(record.result) ?? "",
				},
			];
		default:
			return [];
	}
};

export const lineSplitter = (onLine: (line: string) => void) => {
	let buffered = "";
	return {
		push(chunk: string) {
			buffered += chunk;
			const lines = buffered.split("\n");
			buffered = lines.pop() ?? "";
			for (const line of lines) if (line.trim()) onLine(line);
		},
		flush() {
			if (buffered.trim()) onLine(buffered);
			buffered = "";
		},
	};
};
