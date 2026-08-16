#!/usr/bin/env node

import {
	adaptTenantModel,
	outputLimitFor,
	shouldIncludeTenantModel,
} from "../src/model-catalog.ts";

let failures = 0;
function check(condition, message) {
	if (condition) {
		console.log(`  ✓ ${message}`);
		return;
	}
	console.error(`  ❌ ${message}`);
	failures++;
}

// Real `scenarioQueryModels` resource shapes captured from the tenant.
const resource = (model, overrides = {}) => ({
	model,
	displayName: overrides.displayName,
	allowedScenarios: overrides.allowedScenarios ?? [
		{ scenarioId: "foundation-models" },
		{ scenarioId: "orchestration" },
	],
	versions: [
		{
			name: "1",
			isLatest: true,
			contextLength: overrides.contextLength ?? 200000,
			inputTypes: overrides.inputTypes ?? ["text", "image"],
			capabilities: overrides.capabilities ?? ["text-generation"],
			cost: overrides.cost,
			streamingSupported: true,
		},
	],
});

console.log("Inclusion filter");
check(
	shouldIncludeTenantModel(resource("gpt-5.6-luna")),
	"orchestration-capable chat model in an allowlisted family is included",
);
check(
	!shouldIncludeTenantModel(resource("gemini-embedding", { capabilities: ["embedding"] })),
	"embedding models are excluded",
);
check(
	!shouldIncludeTenantModel(
		resource("gemini-3.1-flash-image", {
			capabilities: ["text-generation", "image-generation"],
			allowedScenarios: [{ scenarioId: "foundation-models" }],
		}),
	),
	"non-orchestration (image-gen) variant is excluded",
);
check(
	!shouldIncludeTenantModel(
		resource("gemini-live-2.5-flash-native-audio", {
			capabilities: ["speech-to-speech"],
			allowedScenarios: [{ scenarioId: "foundation-models" }],
		}),
	),
	"speech-only model is excluded",
);
check(
	!shouldIncludeTenantModel(resource("mistralai--mistral-medium")),
	"out-of-family model is excluded",
);
check(
	!shouldIncludeTenantModel(resource("qwen3.6-plus", { capabilities: ["reasoning"] })),
	"family model without text-generation capability is excluded",
);
check(
	shouldIncludeTenantModel(resource("qwen3.6-plus", { capabilities: ["text-generation"] })),
	"qwen text-generation model is included",
);

console.log("Adapter field mapping");
const luna = adaptTenantModel(
	resource("gpt-5.6-luna", {
		displayName: "GPT-5.6 Luna",
		contextLength: 1050000,
		capabilities: ["text-generation", "image-recognition", "reasoning"],
	}),
);
check(luna.id === "gpt-5.6-luna", "id is preserved");
check(luna.name === "GPT-5.6 Luna", "displayName becomes name");
check(luna.reasoning === true, "reasoning capability enables reasoning");
check(luna.temperature === false, "gpt-* disables temperature");
check(luna.tool_call === true, "tool_call is enabled for chat models");
check(luna.limit.context === 1050000, "context length flows from tenant");
check(luna.limit.output === 128000, "gpt-5 output limit falls back correctly");
check(
	luna.modalities.input.includes("text") && luna.modalities.input.includes("image"),
	"input modalities flow from inputTypes",
);
check(!!luna.thinkingLevelMap, "reasoning model gets a thinking level map");

const gemini = adaptTenantModel(
	resource("gemini-3.5-flash", {
		contextLength: 1000000,
		capabilities: ["text-generation", "image-recognition", "reasoning"],
	}),
);
check(gemini.reasoning === false, "gemini reasoning stays off (undocumented passthrough)");
check(gemini.temperature === true, "non-gpt keeps temperature enabled");

console.log("Cost parsing");
const opus = adaptTenantModel(
	resource("anthropic--claude-4.8-opus", {
		contextLength: 1000000,
		cost: [{ inputCost: "0.00367" }, { outputCost: "0.01806" }],
	}),
);
check(
	Math.abs(opus.cost.input - 3.67) < 1e-9,
	"input cost parses to CU per 1M tokens",
);
check(
	Math.abs(opus.cost.output - 18.06) < 1e-9,
	"output cost parses to CU per 1M tokens",
);
check(opus.cost.cacheRead === 0 && opus.cost.cacheWrite === 0, "cache costs default to 0");

const noCost = adaptTenantModel(resource("gpt-5.5", { cost: undefined }));
check(
	noCost.cost.input === 0 && noCost.cost.output === 0,
	"missing tenant cost yields 0 (overlay overrides)",
);

console.log("Output limit table");
check(outputLimitFor("anthropic--claude-4.8-opus") === 128000, "explicit opus limit");
check(outputLimitFor("anthropic--claude-4-sonnet") === 64000, "claude-4 family fallback");
check(outputLimitFor("anthropic--claude-3-haiku") === 4096, "explicit haiku limit");
check(outputLimitFor("gpt-5.6-terra") === 128000, "gpt-5 family fallback");
check(outputLimitFor("gpt-4.1") === 32768, "gpt-4 explicit limit");
check(outputLimitFor("gemini-3.5-flash") === 65536, "gemini family fallback");
check(outputLimitFor("qwen3.6-plus") === 32768, "qwen family fallback");

if (failures > 0) {
	console.error(`\n${failures} tenant-model check(s) failed`);
	process.exit(1);
}
console.log("\nAll tenant-model checks passed");
