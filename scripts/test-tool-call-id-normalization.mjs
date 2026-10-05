#!/usr/bin/env node
// Offline regression test for cross-provider tool-call id normalization.
//
// Switching a conversation from pi's `openai-responses` provider (hai-openai,
// azure-codex) into a SAP model carries that provider's COMPOSITE tool-call id
// `call_<...>|fc_<...>` (up to ~83 chars, contains `|`) into the SAP request
// verbatim. SAP's OpenAI-compatible endpoints 400 on it:
//   "Invalid 'messages[2].tool_calls[0].id': string too long. Expected a
//    string with maximum length 64, but got a string with length 83 instead."
// SAP's Bedrock Converse executable additionally rejects the `|` because
// toolUseId must match [a-zA-Z0-9_-]+.
//
// normalizeToolCallId() rewrites any over-length or unsafe-char id to a
// deterministic <=64 safe-char id, identically on the assistant tool_call and
// its paired tool_result, so the pairing SAP requires survives the rewrite.
// This reproduces the real failing id and asserts the invariant across the
// orchestration, Azure OpenAI, and Bedrock translators. No network calls.

import { pathToFileURL } from "node:url";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;

const imp = (p) => import(pathToFileURL(join(ROOT, p)).href);

const { normalizeToolCallId } = await imp("src/tool-call-id.ts");
const { piContextToOrchestration } = await imp("src/translate.ts");
const { piContextToAzureOpenAi } = await imp("src/translate-foundation.ts");
const { piContextToBedrockConverse } = await imp(
	"src/translate-foundation-bedrock.ts",
);

let failures = 0;
function check(condition, message) {
	if (condition) {
		console.log(`  ✓ ${message}`);
	} else {
		console.error(`  ✗ ${message}`);
		failures++;
	}
}

// The exact composite id captured from the reproduced failing session.
const COMPOSITE =
	"call_2Za07rsDKiRL2kbMQ6Cmdy68|fc_04d4e9c1ee8b58af006ac3ccc717f88193985281fe970ba5bf";
const SAFE = /^[a-zA-Z0-9_-]+$/;

// --- helper-level invariants ------------------------------------------------
console.log("normalizeToolCallId:");
check(COMPOSITE.length === 83, "fixture composite id is 83 chars (over SAP's 64 cap)");

const normalized = normalizeToolCallId(COMPOSITE);
check(normalized.length <= 64, `composite id normalized to <=64 chars (got ${normalized.length})`);
check(SAFE.test(normalized), "normalized id contains only [a-zA-Z0-9_-]");
check(
	normalizeToolCallId(COMPOSITE) === normalized,
	"normalization is deterministic (same input → same output)",
);

// Short, safe ids pass through byte-identical (Anthropic/plain OpenAI).
check(normalizeToolCallId("toolu_abc123") === "toolu_abc123", "short safe id passes through untouched");
check(normalizeToolCallId("call_2Za07rsDKiRL2kbMQ6Cmdy68") === "call_2Za07rsDKiRL2kbMQ6Cmdy68", "plain OpenAI call_ id passes through untouched");

// A 64-char safe id is at the boundary and must pass through.
const boundary = "a".repeat(64);
check(normalizeToolCallId(boundary) === boundary, "64-char safe id passes through (boundary)");

// An under-limit id with an unsafe char still gets rewritten (Bedrock pattern).
const unsafeShort = "call_a|fc_b";
check(normalizeToolCallId(unsafeShort) !== unsafeShort, "short id with '|' is rewritten (unsafe char)");
check(SAFE.test(normalizeToolCallId(unsafeShort)), "rewritten short-unsafe id is safe-char");

// Distinct inputs sharing a long prefix must not collide (hash, not truncate).
const a = "call_" + "x".repeat(70) + "A";
const b = "call_" + "x".repeat(70) + "B";
check(
	normalizeToolCallId(a) !== normalizeToolCallId(b),
	"ids sharing a 64-char prefix do not collide",
);

// --- translator-level pairing invariant -------------------------------------
// Build a context whose assistant tool_call and its tool_result both carry the
// composite id, exactly as a post-switch transcript would.
function contextWith(id) {
	return {
		messages: [
			{ role: "user", content: "read a file" },
			{
				role: "assistant",
				content: [{ type: "toolCall", id, name: "read", arguments: {} }],
				api: "test",
				provider: "test",
				model: "test",
				usage: {},
				stopReason: "toolUse",
				timestamp: 1,
			},
			{
				role: "toolResult",
				toolCallId: id,
				toolName: "read",
				content: [{ type: "text", text: "file contents" }],
				isError: false,
				timestamp: 2,
			},
		],
		tools: [],
	};
}

const expected = normalizeToolCallId(COMPOSITE);

console.log("orchestration (SAP chat/completions):");
{
	const { messages } = piContextToOrchestration(contextWith(COMPOSITE));
	const assistant = messages.find((m) => m.role === "assistant");
	const tool = messages.find((m) => m.role === "tool");
	const callId = assistant?.tool_calls?.[0]?.id;
	check(callId === expected, `assistant tool_call id normalized (got ${callId})`);
	check(tool?.tool_call_id === expected, "tool_result id normalized to the same value");
	check(callId === tool?.tool_call_id, "assistant and tool_result ids still match (pairing preserved)");
	check((callId?.length ?? 99) <= 64 && SAFE.test(callId ?? ""), "orchestration id satisfies SAP constraints");
}

console.log("foundation Azure OpenAI:");
{
	const { messages } = piContextToAzureOpenAi(contextWith(COMPOSITE));
	const assistant = messages.find((m) => m.role === "assistant");
	const tool = messages.find((m) => m.role === "tool");
	const callId = assistant?.tool_calls?.[0]?.id;
	check(callId === expected, `assistant tool_call id normalized (got ${callId})`);
	check(tool?.tool_call_id === expected, "tool_result id normalized to the same value");
	check(callId === tool?.tool_call_id, "assistant and tool_result ids still match (pairing preserved)");
	check((callId?.length ?? 99) <= 64 && SAFE.test(callId ?? ""), "azure openai id satisfies SAP constraints");
}

console.log("foundation Bedrock Converse:");
{
	const { messages } = piContextToBedrockConverse(contextWith(COMPOSITE));
	const assistant = messages.find((m) => m.role === "assistant");
	const toolUse = assistant?.content?.find((b) => b.toolUse)?.toolUse;
	const userMsg = messages.find(
		(m) => m.role === "user" && m.content.some((b) => b.toolResult),
	);
	const toolResult = userMsg?.content?.find((b) => b.toolResult)?.toolResult;
	check(toolUse?.toolUseId === expected, `assistant toolUseId normalized (got ${toolUse?.toolUseId})`);
	check(toolResult?.toolUseId === expected, "tool_result toolUseId normalized to the same value");
	check(toolUse?.toolUseId === toolResult?.toolUseId, "toolUse and toolResult ids still match (pairing preserved)");
	check((toolUse?.toolUseId?.length ?? 99) <= 64 && SAFE.test(toolUse?.toolUseId ?? ""), "bedrock id satisfies SAP constraints");
}

if (failures > 0) {
	console.error(`\n❌ ${failures} check(s) failed`);
	process.exit(1);
}
console.log("\n✅ tool-call id normalization test passed");
