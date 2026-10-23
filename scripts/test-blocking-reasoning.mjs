import assert from "node:assert/strict";
import { OrchestrationClient } from "@sap-ai-sdk/orchestration";
import { streamSapAiCore } from "../src/stream.ts";

const original = OrchestrationClient.prototype.chatCompletion;
const previousKey = process.env.AICORE_SERVICE_KEY;
const previousBlocking = process.env.PI_SAP_AICORE_FORCE_BLOCKING;
const key = JSON.stringify({ clientid: "test", clientsecret: "test", url: "https://auth.test", serviceurls: { AI_API_URL: "https://api.test" } });
const model = { id: "gpt-6-luna", name: "Luna", api: "sap-aicore-orchestration", provider: "sap-aicore", baseUrl: "https://test.invalid", reasoning: true, input: ["text"], contextWindow: 128000, maxTokens: 2048, cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 }, thinkingLevelMap: { high: "high" } };
const context = { messages: [{ role: "user", content: "Find the minimum", timestamp: 1 }], tools: [{ name: "read", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } }] };
OrchestrationClient.prototype.chatCompletion = async function () {
	return {
		getRefusal: () => undefined,
		getReasoningContent: () => ["Check the divisor count.", "Compare the minimum."],
		getContent: () => "180",
		getToolCalls: () => undefined,
		getFinishReason: () => "stop",
		getTokenUsage: () => ({ prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 }),
	};
};
try {
	process.env.PI_SAP_AICORE_FORCE_BLOCKING = "1";
	const stream = streamSapAiCore(model, context, { apiKey: key, reasoning: "high" });
	const events = [];
	for await (const event of stream) events.push(event.type);
	const result = await stream.result();
	assert.equal(result.stopReason, "stop");
	assert.deepEqual(result.content, [{ type: "thinking", thinking: "Check the divisor count.\n\nCompare the minimum." }, { type: "text", text: "180" }]);
	assert(events.indexOf("thinking_end") < events.indexOf("text_start"));
	console.log("Blocking reasoning precedes the answer with tools available.");
} finally {
	OrchestrationClient.prototype.chatCompletion = original;
	if (previousKey === undefined) delete process.env.AICORE_SERVICE_KEY; else process.env.AICORE_SERVICE_KEY = previousKey;
	if (previousBlocking === undefined) delete process.env.PI_SAP_AICORE_FORCE_BLOCKING; else process.env.PI_SAP_AICORE_FORCE_BLOCKING = previousBlocking;
}
