import assert from "node:assert/strict";
import { OrchestrationClient } from "@sap-ai-sdk/orchestration";
import { constructCompletionPostRequest } from "@sap-ai-sdk/orchestration/internal.js";
import { streamSapAiCore } from "../src/stream.ts";
import { literalPlaceholderContent } from "../src/translate.ts";

const originalStream = OrchestrationClient.prototype.stream;
const previousKey = process.env.AICORE_SERVICE_KEY;
const key = JSON.stringify({
	clientid: "test",
	clientsecret: "test",
	url: "https://auth.test",
	serviceurls: { AI_API_URL: "https://api.test" },
});
const model = {
	id: "gpt-6.1-sol",
	name: "Sol",
	api: "sap-aicore-orchestration",
	provider: "sap-aicore",
	baseUrl: "https://test.invalid",
	reasoning: true,
	input: ["text"],
	contextWindow: 128000,
	maxTokens: 2048,
	cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
	thinkingLevelMap: { high: "high" },
};
const literalPlaceholder = "What is the capital of {{?country}}?";
const toolCallId = "call_context7";
const context = {
	messages: [
		{ role: "user", content: "Check the SDK docs", timestamp: 1 },
		{
			role: "assistant",
			content: [
				{
					type: "toolCall",
					id: toolCallId,
					name: "query-docs",
					arguments: {},
				},
			],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {},
			stopReason: "toolUse",
			timestamp: 2,
		},
		{
			role: "toolResult",
			toolCallId,
			toolName: "query-docs",
			content: [{ type: "text", text: literalPlaceholder }],
			isError: false,
			timestamp: 3,
		},
	],
	tools: [
		{
			name: "query-docs",
			description: "Query SDK documentation",
			parameters: { type: "object", properties: {} },
		},
	],
};

let request;
let config;
OrchestrationClient.prototype.stream = async function (submitted) {
	request = submitted;
	config = this.config;
	return {
		stream: (async function* () {
			yield {
				findChoiceByIndex: () => ({ delta: { content: "ok" } }),
				getDeltaReasoningContent: () => undefined,
				getDeltaContent: () => "ok",
				getDeltaToolCalls: () => undefined,
				getFinishReason: () => "stop",
			};
		})(),
		getFinishReason: () => "stop",
		getTokenUsage: () => undefined,
	};
};

try {
	const stream = streamSapAiCore(model, context, { apiKey: key });
	for await (const _event of stream) {
		// Drain the stream.
	}
	assert.equal((await stream.result()).stopReason, "stop");
	assert.equal(request.messagesHistory, undefined);

	const safeContent = request.messages[2].content;
	assert(Array.isArray(safeContent));
	assert.equal(safeContent.map((block) => block.text).join(""), literalPlaceholder);
	assert(!safeContent.some((block) => block.text.includes("{{?")));

	const body = constructCompletionPostRequest(config, request, false);
	assert.equal(body.config.modules.prompt_templating.prompt.template.length, 3);
	assert.equal(body.config.modules.prompt_templating.prompt.tools.length, 1);
	assert.equal(JSON.stringify(body).includes("{{?country}}"), false);

	assert.equal(literalPlaceholderContent("ordinary text"), "ordinary text");
	assert.deepEqual(literalPlaceholderContent("{{?a}} and {{?b}}"), [
		{ type: "text", text: "{{" },
		{ type: "text", text: "?a}} and {{" },
		{ type: "text", text: "?b}}" },
	]);
	console.log("OMP orchestration keeps literal SAP placeholders without executing them.");
} finally {
	OrchestrationClient.prototype.stream = originalStream;
	if (previousKey === undefined) delete process.env.AICORE_SERVICE_KEY;
	else process.env.AICORE_SERVICE_KEY = previousKey;
}
