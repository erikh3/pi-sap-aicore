import assert from "node:assert/strict";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { completeOmpStream } from "../src/omp-stream.ts";

const usage = { input: 12, output: 4, cacheRead: 0, cacheWrite: 0, totalTokens: 16, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
async function run(content, reason = "stop", error = false) {
	const source = createAssistantMessageEventStream();
	const message = { role: "assistant", api: "sap-aicore-orchestration", provider: "sap-aicore", model: "test", content, usage, stopReason: reason, timestamp: 1 };
	const terminal = error ? { type: "error", reason, error: message } : { type: "done", reason, message };
	source.push(terminal);
	source.end();
	const adapted = completeOmpStream(source);
	const events = [];
	for await (const event of adapted) events.push(event);
	return { result: await adapted.result(), events, terminal };
}
for (const content of [[], [{ type: "text", text: " \n" }], [{ type: "thinking", thinking: "private reasoning" }]]) {
	const { result, events } = await run(content);
	assert.equal(result.content.at(-1).text, "No response.");
	assert.equal(result.usage, usage);
	assert.equal(result.stopReason, "stop");
	assert.deepEqual(events.map(e => e.type), ["text_start", "text_delta", "text_end", "done"]);
	assert.equal(events[2].contentIndex, content.length);
}
for (const content of [[{ type: "text", text: "answer" }], [{ type: "toolCall", id: "call", name: "read", arguments: {} }]]) {
	const { events, terminal } = await run(content);
	assert.deepEqual(events, [terminal]);
}
for (const [reason, error] of [["length", false], ["error", true], ["aborted", true]]) {
	const { events, terminal } = await run([], reason, error);
	assert.deepEqual(events, [terminal]);
}
console.log("Empty normal stops get status text; answers, tools, usage and failed turns are preserved.");
