#!/usr/bin/env node
// Offline regression test for the SAP orchestration (Anthropic-via-SAP)
// tool_result ordering.
//
// Anthropic (which SAP orchestration wraps for anthropic--* models) requires
// the user turn immediately after an assistant tool_use turn to contain a
// tool_result for EVERY tool_use id, with nothing interleaved. Pi stores each
// tool result as a separate top-level message, and image-bearing results
// (e.g. `read` on a PNG) get hoisted into a synthetic user message. Translating
// results one at a time produced:
//   assistant(tool_use a,b), tool(a), user(image), tool(b)
// which SAP rejected with a 400:
//   "messages.2: `tool_use` ids were found without `tool_result` blocks
//    immediately after: <id>."
// This test reproduces that exact shape (mirrors the real failing session) and
// makes no network calls.

import { pathToFileURL } from "node:url";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;

const { piContextToOrchestration } = await import(
	pathToFileURL(join(ROOT, "src/translate.ts")).href
);

let failures = 0;
function check(condition, message) {
	if (condition) {
		console.log(`  ✓ ${message}`);
		return;
	}
	console.error(`  ❌ ${message}`);
	failures++;
}

const context = {
	messages: [
		{ role: "user", content: "customize the welcome message" },
		{
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "read image + check docs" },
				{ type: "toolCall", id: "toolu_read", name: "read", arguments: {} },
				{ type: "toolCall", id: "toolu_bash", name: "bash", arguments: {} },
			],
			api: "test",
			provider: "test",
			model: "test",
			usage: {},
			stopReason: "toolUse",
			timestamp: 1,
		},
		{
			role: "toolResult",
			toolCallId: "toolu_read",
			toolName: "read",
			content: [
				{ type: "text", text: "Read image file [image/png]" },
				{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
			],
			isError: false,
			timestamp: 2,
		},
		{
			role: "toolResult",
			toolCallId: "toolu_bash",
			toolName: "bash",
			content: [{ type: "text", text: "docs.json\ntui.md\n" }],
			isError: false,
			timestamp: 3,
		},
	],
	tools: [],
};

const { messages } = piContextToOrchestration(context);

// Sequence must be: user, assistant(tool_calls), tool(read), tool(bash),
// user(image). The two tool messages must be contiguous — no user message
// interleaved between them.
const roles = messages.map((m) => m.role);
check(
	roles.join(",") === "user,assistant,tool,tool,user",
	`role order is user,assistant,tool,tool,user (got: ${roles.join(",")})`,
);

const assistant = messages.find((m) => m.role === "assistant");
check(
	(assistant?.tool_calls ?? []).map((t) => t.id).join(",") ===
		"toolu_read,toolu_bash",
	"assistant carries both tool_calls in order",
);

const toolMsgs = messages.filter((m) => m.role === "tool");
check(toolMsgs.length === 2, "exactly two tool result messages emitted");
check(
	toolMsgs.map((m) => m.tool_call_id).join(",") === "toolu_read,toolu_bash",
	"tool result ids match the assistant tool_call ids in order",
);

// The critical invariant: every tool message index must come before any
// user message that follows the assistant, and the two tool messages must be
// adjacent (indices differ by 1).
const toolIdx = messages
	.map((m, i) => (m.role === "tool" ? i : -1))
	.filter((i) => i >= 0);
check(
	toolIdx[1] - toolIdx[0] === 1,
	"the two tool result messages are contiguous (no interleaved user/image)",
);

const lastRole = roles[roles.length - 1];
check(lastRole === "user", "hoisted image is preserved as a trailing user message");

// A tool_use whose result is missing (interrupted turn) must still get a
// placeholder tool_result so the assistant turn is not left unanswered.
const interrupted = {
	messages: [
		{ role: "user", content: "hi" },
		{
			role: "assistant",
			content: [
				{ type: "toolCall", id: "toolu_x", name: "bash", arguments: {} },
			],
			api: "test",
			provider: "test",
			model: "test",
			usage: {},
			stopReason: "toolUse",
			timestamp: 1,
		},
		{ role: "user", content: "actually never mind" },
	],
	tools: [],
};
const out2 = piContextToOrchestration(interrupted);
const roles2 = out2.messages.map((m) => m.role);
check(
	roles2.join(",") === "user,assistant,tool,user",
	`interrupted tool_use gets a synthetic tool_result (got: ${roles2.join(",")})`,
);
check(
	out2.messages[2]?.tool_call_id === "toolu_x",
	"synthetic tool_result targets the unanswered tool_call id",
);

if (failures > 0) {
	console.error(
		`\n❌ orchestration tool-result ordering test: ${failures} check(s) failed`,
	);
	process.exit(1);
}
console.log("\n✅ orchestration tool-result ordering test passed");
