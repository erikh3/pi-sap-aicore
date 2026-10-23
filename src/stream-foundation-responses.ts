import { randomUUID } from "node:crypto";

import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Context,
	createAssistantMessageEventStream,
	type Model,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import type * as ResponsesHelpers from "@earendil-works/pi-ai/api/openai-responses-shared";
import { SapOpenAi } from "@sap-ai-sdk/openai";
import type { ResponseCreateParamsStreaming } from "openai/resources/responses/responses";

import { debugLog, ensureServiceKey, formatError, resolveResourceGroup } from "./stream.ts";
import { normalizeContext } from "./normalize-context.ts";

// Pi's converter requires an iterable set of providers whose tool IDs it preserves.
const SAP_TOOL_CALL_PROVIDERS: ReadonlySet<string> = new Set(["sap-aicore", "sap-aicore-foundation"]);

/** Stream native GPT reasoning summaries and tool calls through an existing SAP foundation deployment. */
export function streamSapFoundationResponses(
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	const output: AssistantMessage = {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
	(async () => {
		const requestId = randomUUID();
		try {
			// omp rewrites static Pi imports into host modules; resolve the installed helper at runtime.
			const helperUrl = import.meta.resolve("@earendil-works/pi-ai/api/openai-responses-shared");
			const { convertResponsesMessages, convertResponsesTools, processResponsesStream }: typeof ResponsesHelpers = await import(helperUrl);
			context = normalizeContext(context, model, options);
			const transcript = {
				messages: [
					{
						role: "system" as const,
						content: context.systemPrompt ?? "",
						toolsAdded: context.tools ?? [],
						timestamp: 0,
					},
					...context.messages,
				],
			};
			const key = ensureServiceKey(options?.apiKey);
			process.env.AICORE_SERVICE_KEY = key.raw;
			const resourceGroup = resolveResourceGroup(key);
			const client = await SapOpenAi.createClient({
				deployment: { modelName: model.id, ...(resourceGroup ? { resourceGroup } : {}) },
			});
			const level = options?.reasoning;
			const effort = level
				? model.thinkingLevelMap?.[level as keyof NonNullable<typeof model.thinkingLevelMap>] ?? level
				: "none";
			const request: Omit<ResponseCreateParamsStreaming, "model"> = {
				// Pi uses OpenAI 6 types; SAP uses OpenAI 7. These converters emit shared message types only.
				// The manually normalized transcript has Pi's runtime shape; its private type brand is compile-time only.
				input: convertResponsesMessages(model, transcript as unknown as Parameters<typeof convertResponsesMessages>[1], SAP_TOOL_CALL_PROVIDERS) as unknown as ResponseCreateParamsStreaming["input"],
				stream: true,
				store: false,
				max_output_tokens: options?.maxTokens ?? model.maxTokens,
				...(context.tools?.length ? { tools: convertResponsesTools(context.tools) } : {}),
				reasoning: {
					effort: effort as NonNullable<ResponseCreateParamsStreaming["reasoning"]>["effort"],
					...(level ? { summary: "auto" as const } : {}),
				},
				...(level ? { include: ["reasoning.encrypted_content" as const] } : {}),
			};
			debugLog({ requestId, kind: "request", provider: "foundation-responses", model: model.id, resourceGroup });
			const response = await client.responses.create(request, { signal: options?.signal });
			stream.push({ type: "start", partial: output });
			// Pi ignores additional OpenAI 7 event variants and handles the shared Responses events.
			await processResponsesStream(response as unknown as Parameters<typeof processResponsesStream>[0], output, stream, model);
			if (options?.signal?.aborted) throw new Error("Request aborted");
			stream.push({ type: "done", reason: output.stopReason as "stop" | "length" | "toolUse", message: output });
		} catch (error) {
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage = formatError(error);
			stream.push({ type: "error", reason: output.stopReason, error: output });
		} finally {
			stream.end();
		}
	})();
	return stream;
}
