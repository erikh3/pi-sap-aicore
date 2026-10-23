import assert from "node:assert/strict";
import { OrchestrationClient } from "@sap-ai-sdk/orchestration";
import { streamSapAiCore } from "../src/stream.ts";

const original = OrchestrationClient.prototype.stream;
const oldKey = process.env.AICORE_SERVICE_KEY;
const model = { id: "gpt-6-luna", name: "Luna", api: "sap-aicore-orchestration", provider: "sap-aicore", baseUrl: "https://test.invalid", reasoning: true, input: ["text"], contextWindow: 128000, maxTokens: 2048, cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 }, thinkingLevelMap: { high: "high" } };
const apiKey = JSON.stringify({ clientid: "test", clientsecret: "test", url: "https://auth.test", serviceurls: { AI_API_URL: "https://api.test" } });
const context = { messages: [{ role: "user", content: "Read a file", timestamp: 1 }], tools: [{ name: "read", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } } } }] };
let args;
let abort;
OrchestrationClient.prototype.stream = async () => ({
	stream: (async function* () {
		yield {
			findChoiceByIndex: () => ({ delta: {} }),
			getDeltaReasoningContent: () => undefined,
			getDeltaContent: () => undefined,
			getDeltaToolCalls: () => [{ index: 0, function: { name: "read", arguments: args } }],
			getFinishReason: () => "length",
		};
		abort?.abort();
	})(),
	getFinishReason: () => "length",
	getTokenUsage: () => undefined,
});
async function run(argumentText, controller) {
	args = argumentText;
	abort = controller;
	const stream = streamSapAiCore(model, context, { apiKey, reasoning: "high", signal: controller?.signal });
	const events = [];
	for await (const event of stream) events.push(event);
	return { result: await stream.result(), events };
}
try {
	const truncated = await run('{"path":"/tmp/unfin');
	assert.equal(truncated.result.stopReason, "error");
	assert(!truncated.events.some(e => e.type === "toolcall_end"));
	const aborted = await run('{"path":"README.md"}', new AbortController());
	assert.equal(aborted.result.stopReason, "aborted");
	assert(!aborted.events.some(e => e.type === "toolcall_end"));
	const complete = await run('{"path":"README.md"}');
	const call = complete.events.find(e => e.type === "toolcall_end").toolCall;
	assert.deepEqual(call.arguments, { path: "README.md" });
	assert(call.id);
	assert.equal(complete.result.content.find(b => b.type === "toolCall").id, call.id);
	console.log("Truncated and aborted calls never dispatch; complete id-less calls receive a consistent ID.");
} finally {
	OrchestrationClient.prototype.stream = original;
	if (oldKey === undefined) delete process.env.AICORE_SERVICE_KEY; else process.env.AICORE_SERVICE_KEY = oldKey;
}
