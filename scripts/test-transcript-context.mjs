#!/usr/bin/env node

import assert from "node:assert/strict";
import { test } from "node:test";
import * as piAi from "@earendil-works/pi-ai";

import { normalizeContext } from "../src/normalize-context.ts";
import { piContextToOrchestration } from "../src/translate.ts";
import { piContextToAzureOpenAi } from "../src/translate-foundation.ts";
import { piContextToBedrockConverse } from "../src/translate-foundation-bedrock.ts";
import { piContextToVertexGenerateContent } from "../src/translate-foundation-vertexai.ts";

const model = {
	id: "gpt-5.5", api: "sap-aicore-orchestration", provider: "sap-aicore",
	input: ["text"],
};
const tool = (name, description = name) => ({ name, description, parameters: { type: "object" } });
const user = { role: "user", content: "hello", timestamp: 1 };
const legacy = { systemPrompt: "Base prompt", tools: [tool("read")], messages: [user] };
const translators = [
	["orchestration", piContextToOrchestration],
	["Azure OpenAI", piContextToAzureOpenAi],
	["Bedrock", piContextToBedrockConverse],
	["Vertex AI", piContextToVertexGenerateContent],
];
const modern = typeof piAi.normalizeContext === "function";

test("legacy contexts still preserve their prompt, messages, and tools", () => {
	assert.deepEqual(normalizeContext(legacy, model), legacy);
});

test("Pi transcript normalization is equivalent to legacy input on every route", { skip: !modern }, () => {
	const transcript = piAi.normalizeContext(legacy);
	for (const [name, translate] of translators) {
		assert.deepEqual(translate(normalizeContext(transcript, model)), translate(legacy), name);
	}
});

test("transcript deltas replay prompt sections and tool additions, removals, and replacements", () => {
	const context = {
		messages: [
			{ role: "system", content: "Base prompt", sections: { rules: "Old rules", obsolete: "Remove me" },
				toolsAdded: [tool("read"), tool("bash")], timestamp: 0 },
			user,
			{ role: "system", content: [
				{ type: "text", text: "Later instructions" },
				{ type: "text", text: "Keep boundaries." },
			],
				sections: { rules: "New rules", obsolete: null }, toolsRemoved: [{ name: "read" }],
				toolsAdded: [tool("bash", "Updated bash"), tool("write")], timestamp: 2 },
		],
	};
	const expected = {
		systemPrompt: "Base prompt\n\nLater instructions\nKeep boundaries.\n\nNew rules",
		tools: [tool("bash", "Updated bash"), tool("write")], messages: [user],
	};
	const original = structuredClone(context);
	const normalized = normalizeContext(context, model);
	assert.deepEqual(context, original, "normalization must not mutate the transcript");
	assert.deepEqual(normalized, expected);
	for (const [name, translate] of translators) {
		assert.deepEqual(translate(normalized), translate(expected), name);
		assert.deepEqual(
			translate(normalizeContext(context, model, { toolChoice: "none" })),
			translate({ ...expected, tools: [] }),
			`${name} suppresses transcript tools on compaction`,
		);
	}
});

test("system deltas between a tool call and its result do not create synthetic results", () => {
	const assistant = {
		role: "assistant", api: model.api, provider: model.provider, model: model.id,
		content: [{ type: "toolCall", id: "call_1", name: "read", arguments: {} }],
		stopReason: "toolUse", timestamp: 1,
	};
	const result = { role: "toolResult", toolCallId: "call_1", toolName: "read",
		content: [{ type: "text", text: "ok" }], isError: false, timestamp: 3 };
	const context = { messages: [
		{ role: "system", content: "Base prompt", timestamp: 0 },
		assistant,
		{ role: "system", content: "More instructions", timestamp: 2 },
		result,
	] };
	const normalized = normalizeContext(context, model);
	assert.deepEqual(normalized.messages, [assistant, result]);
	assert.deepEqual(piContextToOrchestration(normalized).messages.map((message) => message.role),
		["system", "assistant", "tool"]);
});
