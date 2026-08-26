#!/usr/bin/env node
// Offline regression test for orchestration tool_call/tool-message pairing.
//
// SAP orchestration fronts OpenAI-shaped backends, which reject any request
// where an assistant `tool_calls` message is not answered by a role:"tool"
// message for every id, immediately after it:
//   "An assistant message with 'tool_calls' must be followed by tool messages
//    responding to each 'tool_call_id'. The following tool_call_ids did not
//    have response messages: ..."
// Two distinct causes are covered here:
//   1. A turn that died mid-stream (SSE drop, user interrupt) is persisted by
//      pi with the tool calls it had emitted and no results. Replaying it wedges
//      every later request in the session. normalizeContext() runs pi's shared
//      transformMessages(), which drops errored/aborted turns and synthesises
//      results for orphaned calls.
//   2. A tool result carrying an image has to be hoisted into a synthetic user
//      message (SAP's tool-message content schema is text-only). Translating
//      results one-by-one yields `tool, user(image), tool`, which fails the
//      "immediately after" rule for every id past the first.
// This test makes no network calls.

import { pathToFileURL } from "node:url";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const load = (file) => import(pathToFileURL(join(ROOT, file)).href);

const { piContextToOrchestration } = await load("src/translate.ts");
const { normalizeContext } = await load("src/normalize-context.ts");

let failures = 0;
function check(condition, message) {
	if (condition) {
		console.log(`  ✓ ${message}`);
		return;
	}
	console.error(`  ❌ ${message}`);
	failures++;
}

const MODEL = {
	id: "gpt-5.6-sol",
	name: "GPT-5.6 Sol",
	api: "sap-aicore-orchestration",
	provider: "sap-aicore",
	baseUrl: "https://example.invalid",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 400000,
	maxTokens: 64000,
};

const assistant = (content, stopReason) => ({
	role: "assistant",
	content,
	api: MODEL.api,
	provider: MODEL.provider,
	model: MODEL.id,
	usage: {},
	stopReason,
	timestamp: 1,
});
const toolCall = (id, name) => ({ type: "toolCall", id, name, arguments: {} });
const toolResult = (id, name, content) => ({
	role: "toolResult",
	toolCallId: id,
	toolName: name,
	content,
	isError: false,
	timestamp: 2,
});

// Every assistant tool_calls id must be answered before the next non-tool
// message. Returns the list of unanswered ids, i.e. what SAP would reject.
function unansweredToolCallIds(messages) {
	const unanswered = [];
	for (let i = 0; i < messages.length; i++) {
		const msg = messages[i];
		if (msg.role !== "assistant" || !msg.tool_calls?.length) continue;
		const answered = new Set();
		for (let j = i + 1; j < messages.length && messages[j].role === "tool"; j++) {
			answered.add(messages[j].tool_call_id);
		}
		for (const call of msg.tool_calls) {
			if (!answered.has(call.id)) unanswered.push(call.id);
		}
	}
	return unanswered;
}

console.log("\nerrored turn with orphaned tool calls is not replayed");
{
	const context = normalizeContext(
		{
			systemPrompt: "sys",
			messages: [
				{ role: "user", content: "go" },
				assistant(
					[
						toolCall("call_a", "read"),
						toolCall("call_b", "read"),
						toolCall("call_c", "read"),
					],
					"error",
				),
				{ role: "user", content: "continue" },
			],
			tools: [],
		},
		MODEL,
	);
	const { messages } = piContextToOrchestration(context);
	check(
		unansweredToolCallIds(messages).length === 0,
		"no unanswered tool_call_ids reach the request",
	);
	check(
		!messages.some((m) => m.role === "assistant" && m.tool_calls?.length),
		"the errored turn's tool calls are dropped, not answered with placeholders",
	);
}

console.log("\ninterrupted toolUse turn gets synthetic tool messages");
{
	const context = normalizeContext(
		{
			systemPrompt: "sys",
			messages: [
				{ role: "user", content: "go" },
				assistant([toolCall("call_a", "read"), toolCall("call_b", "read")], "toolUse"),
				toolResult("call_a", "read", [{ type: "text", text: "ok" }]),
				{ role: "user", content: "stop, do this instead" },
			],
			tools: [],
		},
		MODEL,
	);
	const { messages } = piContextToOrchestration(context);
	check(
		unansweredToolCallIds(messages).length === 0,
		"the unexecuted call_b is answered before the interrupting user message",
	);
	const toolIds = messages.filter((m) => m.role === "tool").map((m) => m.tool_call_id);
	check(
		toolIds.join(",") === "call_a,call_b",
		"tool messages appear in tool_calls order",
	);
}

console.log("\nimage tool results do not split the tool-message block");
{
	const context = normalizeContext(
		{
			systemPrompt: "sys",
			messages: [
				{ role: "user", content: "go" },
				assistant(
					[toolCall("call_a", "read"), toolCall("call_b", "bash")],
					"toolUse",
				),
				toolResult("call_a", "read", [
					{ type: "text", text: "screenshot" },
					{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
				]),
				toolResult("call_b", "bash", [{ type: "text", text: "ok" }]),
			],
			tools: [],
		},
		MODEL,
	);
	const { messages } = piContextToOrchestration(context);
	check(
		unansweredToolCallIds(messages).length === 0,
		"both tool_call_ids are answered despite the hoisted image",
	);
	const roles = messages.map((m) => m.role).join(",");
	check(
		roles === "system,user,assistant,tool,tool,user",
		`tool messages are contiguous after the assistant turn (got ${roles})`,
	);
	const hoisted = messages[messages.length - 1];
	check(
		hoisted.content?.[0]?.type === "image_url",
		"the image is preserved in a user message after the tool block",
	);
}

console.log("\nstandalone tool result without a matching call");
{
	const { messages } = piContextToOrchestration({
		systemPrompt: "sys",
		messages: [toolResult("call_orphan", "read", [{ type: "text", text: "ok" }])],
		tools: [],
	});
	check(
		!messages.some((m) => m.role === "tool"),
		"a tool result with no assistant tool_call becomes user transcript text",
	);
}

console.log("\ntoolChoice: none suppresses tools (pi 0.84.3 compaction turns)");
{
	const base = {
		systemPrompt: "sys",
		messages: [{ role: "user", content: "summarize the conversation" }],
		tools: [
			{ name: "bash", description: "run a command", parameters: { type: "object" } },
		],
	};

	const withTools = piContextToOrchestration(normalizeContext(base, MODEL));
	check(withTools.tools.length === 1, "tools flow through by default");

	const auto = piContextToOrchestration(
		normalizeContext(base, MODEL, { toolChoice: "auto" }),
	);
	check(auto.tools.length === 1, 'toolChoice "auto" leaves tools in place');

	const none = piContextToOrchestration(
		normalizeContext(base, MODEL, { toolChoice: "none" }),
	);
	check(
		none.tools.length === 0,
		'toolChoice "none" sends no tools, so a compaction turn cannot emit tool calls',
	);
	check(
		none.messages.length === withTools.messages.length,
		"suppressing tools does not disturb the messages",
	);
}

console.log("\ntoolChoice: none reaches the foundation routes too");
{
	// The suppression lives in normalizeContext, so every route inherits it —
	// but "no tools" has a different shape per backend, so check the two that
	// differ from the OpenAI one.
	const { piContextToBedrockConverse } = await load(
		"src/translate-foundation-bedrock.ts",
	);
	const { piContextToVertexGenerateContent } = await load(
		"src/translate-foundation-vertexai.ts",
	);
	const base = {
		systemPrompt: "sys",
		messages: [{ role: "user", content: "summarize" }],
		tools: [
			{ name: "bash", description: "run a command", parameters: { type: "object" } },
		],
	};

	const bedrock = piContextToBedrockConverse(
		normalizeContext(base, MODEL, { toolChoice: "none" }),
	);
	check(
		bedrock.toolConfig === undefined,
		"bedrock omits toolConfig entirely (Converse has no 'none' toolChoice)",
	);
	check(
		piContextToBedrockConverse(normalizeContext(base, MODEL)).toolConfig
			?.tools?.length === 1,
		"bedrock still sends toolConfig by default",
	);

	const vertex = piContextToVertexGenerateContent(
		normalizeContext(base, MODEL, { toolChoice: "none" }),
	);
	check(
		vertex.tools === undefined || vertex.tools.length === 0,
		"vertex sends no function declarations",
	);
}

console.log("\ntruncated tool arguments are recovered, not dropped");
{
	const { parseStreamingJson } = await import("@earendil-works/pi-ai");
	// What the streaming loop accumulates when a model hits its output cap or the
	// SSE stream drops part-way through a tool call. A plain JSON.parse throws
	// here, which used to leave `arguments` as `{}` — silently executing e.g. an
	// edit with no target file.
	const truncated = '{"file_path":"/a.ts","old_string":"foo';
	const recovered = parseStreamingJson(truncated);
	check(
		recovered.file_path === "/a.ts" && recovered.old_string === "foo",
		"a half-streamed argument object keeps the fields the model did emit",
	);
	check(
		Object.keys(parseStreamingJson("")).length === 0,
		"an empty argument buffer still yields an object",
	);
}

console.log("\npreflight assertion catches a pairing violation");
{
	const { assertToolMessagePairing } = await load("src/translate.ts");
	const bad = [
		{ role: "user", content: "go" },
		{ role: "assistant", content: "", tool_calls: [{ id: "call_a" }, { id: "call_b" }] },
		{ role: "tool", tool_call_id: "call_a", content: "ok" },
		{ role: "user", content: "next" },
	];
	let thrown;
	try {
		assertToolMessagePairing(bad);
	} catch (error) {
		thrown = error;
	}
	// Require the assertion's own message: a missing export would otherwise make
	// this check pass on the resulting TypeError.
	check(
		thrown?.message.includes("Unanswered tool_call_ids"),
		"an unanswered tool_call_id throws before the request",
	);
	check(
		thrown?.message.includes("call_b") && !thrown.message.includes("call_a"),
		"the error names only the unanswered id",
	);
	// pi retries on error-message *text*; a deterministic translation bug must not
	// burn the retry budget on a request that cannot succeed.
	const { isRetryableAssistantError } = await import("@earendil-works/pi-ai");
	check(
		!isRetryableAssistantError({ stopReason: "error", errorMessage: thrown?.message }),
		"the error is classified non-retryable by pi",
	);

	let ok = true;
	try {
		assertToolMessagePairing([
			...bad.slice(0, 3),
			{ role: "tool", tool_call_id: "call_b", content: "ok" },
			{ role: "user", content: "next" },
		]);
	} catch {
		ok = false;
	}
	check(ok, "a fully answered tool block passes");
}

if (failures > 0) {
	console.error(
		`\n❌ orchestration tool-result pairing test: ${failures} check(s) failed`,
	);
	process.exit(1);
}
console.log("\n✅ orchestration tool-result pairing test passed");
