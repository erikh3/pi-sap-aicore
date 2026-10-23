import type { Api, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";

// Non-reasoning Azure models use Chat Completions. Reasoning models use Responses.
export type AzureOpenAiParams = {
	max_tokens?: number;
	temperature?: number;
};

/** Build the Chat Completions parameters for a non-reasoning Azure model. */
export function buildAzureOpenAiParams(
	model: Model<Api>,
	options: SimpleStreamOptions | undefined,
): AzureOpenAiParams {
	// Pi may pass a tighter budget than the model's hard cap (to reserve room
	// for thinking). Respect it; otherwise use the model's documented max output.
	const effectiveMaxTokens = options?.maxTokens ?? model.maxTokens;

	const params: AzureOpenAiParams = {};
	params.max_tokens = effectiveMaxTokens;

	// Only forward temperature for models that accept it. gpt-5* reject it; the
	// snapshot records `temperature:false`, but we gate on the id prefix here to
	// stay self-contained (mirrors `modelSupportsTemperature` in stream.ts).
	if (options?.temperature !== undefined && !model.id.startsWith("gpt-5")) {
		params.temperature = options.temperature;
	}

	return params;
}
