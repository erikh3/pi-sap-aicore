#!/usr/bin/env node
// Offline regression test for token-usage → pi Usage mapping.
//
// @sap-ai-sdk 2.14's orchestration `TokenUsage` nests Anthropic cache writes
// under `prompt_tokens_details.cache_creation_tokens` (cache reads under
// `prompt_tokens_details.cached_tokens`), while the Bedrock foundation route
// maps its Anthropic usage onto the top-level
// `cache_read_input_tokens`/`cache_creation_input_tokens` fields. `mapUsage`
// must surface BOTH shapes so `cacheWrite`/`cacheRead` stop reading 0 the
// moment SAP forwards the fields — and must keep pi's convention that
// `input` is non-cached prompt tokens only (cached tokens are subtracted so the
// cost line is not inflated ~10× on cached turns). No network calls.

import { pathToFileURL } from "node:url";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;

const { mapUsage } = await import(
	pathToFileURL(join(ROOT, "src/stream.ts")).href
);

let failures = 0;
function check(condition, message) {
	if (condition) {
		console.log(`  ✓ ${message}`);
	} else {
		failures++;
		console.error(`  ✗ ${message}`);
	}
}

console.log("OpenAI convention (gpt-*): cached tokens are a subset of prompt");
// prompt_tokens INCLUDES cached_tokens; no cache-creation bucket exists.
const openai = mapUsage({
	prompt_tokens: 1000,
	completion_tokens: 200,
	prompt_tokens_details: { cached_tokens: 600 },
});
check(openai.cacheRead === 600, "cached_tokens maps to cacheRead");
check(openai.cacheWrite === 0, "OpenAI has no cache-creation bucket");
check(openai.input === 400, "input SUBTRACTS cacheRead (1000-600=400)");
check(openai.output === 200, "completion_tokens maps to output");
check(openai.totalTokens === 1200, "total = 400+200+600");

const openaiFull = mapUsage({
	prompt_tokens: 600,
	completion_tokens: 10,
	prompt_tokens_details: { cached_tokens: 600 },
});
check(openaiFull.input === 0, "OpenAI 100% cache hit → input 0 (cacheRead==prompt)");

console.log("Anthropic convention (orchestration): cache buckets are additive");
// Real observed shape (blocking path, claude-4.6-sonnet, ~43k prompt):
// prompt_tokens is the NON-cached input; cached/creation are separate.
const anthWrite = mapUsage({
	prompt_tokens: 3,
	completion_tokens: 4,
	prompt_tokens_details: { cached_tokens: 34217, cache_creation_tokens: 8991 },
});
check(anthWrite.cacheRead === 34217, "cached_tokens maps to cacheRead");
check(anthWrite.cacheWrite === 8991, "cache_creation_tokens maps to cacheWrite");
check(
	anthWrite.input === 3,
	"cache-creation bucket ⇒ Anthropic: input = prompt_tokens as-is (NOT subtracted)",
);
check(anthWrite.totalTokens === 43215, "total = 3+4+34217+8991");

// Cache-read-only turn: no creation bucket, but cacheRead > prompt_tokens still
// signals the additive Anthropic convention.
const anthRead = mapUsage({
	prompt_tokens: 3,
	completion_tokens: 4,
	prompt_tokens_details: { cached_tokens: 43208, cache_creation_tokens: 0 },
});
check(
	anthRead.input === 3,
	"cacheRead>prompt ⇒ Anthropic: input = prompt_tokens (not clamped to 0)",
);
check(anthRead.cacheRead === 43208, "cache-read-only turn maps cacheRead");

console.log("Bedrock top-level Anthropic fields (also additive)");
const bedrock = mapUsage({
	prompt_tokens: 800,
	completion_tokens: 100,
	cache_read_input_tokens: 500,
	cache_creation_input_tokens: 120,
});
check(bedrock.cacheRead === 500, "top-level cache_read_input_tokens maps to cacheRead");
check(bedrock.cacheWrite === 120, "top-level cache_creation_input_tokens maps to cacheWrite");
check(bedrock.input === 800, "Anthropic (creation bucket) ⇒ input = prompt (800)");
check(bedrock.totalTokens === 1520, "total = 800+100+500+120");

console.log("Defensive max() across nested + top-level shapes");
const both = mapUsage({
	prompt_tokens: 1000,
	completion_tokens: 0,
	prompt_tokens_details: { cached_tokens: 400, cache_creation_tokens: 90 },
	cache_read_input_tokens: 700,
	cache_creation_input_tokens: 50,
});
check(both.cacheRead === 700, "cacheRead takes the max of nested/top-level reads");
check(both.cacheWrite === 90, "cacheWrite takes the max of nested/top-level writes");
check(both.input === 1000, "creation bucket ⇒ Anthropic: input = prompt (1000)");

console.log("Uncached turn (both conventions agree)");
const bare = mapUsage({ prompt_tokens: 300, completion_tokens: 42 });
check(bare.cacheRead === 0 && bare.cacheWrite === 0, "no detail fields → cache 0");
check(bare.input === 300, "input equals prompt_tokens when nothing is cached");
check(bare.totalTokens === 342, "total = input+output when uncached");

if (failures > 0) {
	console.error(`\n❌ ${failures} usage-mapping check(s) failed`);
	process.exit(1);
}
console.log("\n✅ usage-mapping test passed");
