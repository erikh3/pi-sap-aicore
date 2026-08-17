#!/usr/bin/env node
// Offline regression test for streamed reasoning selection.
//
// SAP orchestration (@sap-ai-sdk/orchestration >= 2.x) streams native
// reasoning as `reasoning_content: ReasoningBlock[]`, exposed by the SDK's
// typed `chunk.getDeltaReasoningContent()` as a string[]. The stream reader
// previously only accepted STRING-typed reasoning fields on the raw delta, so
// the array-shaped native content was silently dropped and pi rendered no
// thinking block on sap-aicore turns. `selectReasoningDelta` fixes that by
// preferring the SDK blocks and falling back to the string-shaped fields used
// by OpenAI-compatible routes. This locks that behavior; no network calls.

import { pathToFileURL } from "node:url";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;

const { selectReasoningDelta } = await import(
	pathToFileURL(join(ROOT, "src/stream.ts")).href
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

// --- SAP native array shape (the regression) -----------------------------

// The exact bug: reasoning arrives as getDeltaReasoningContent() -> string[].
// It must surface as thinking text, not be dropped.
const sap = selectReasoningDelta(["Let me think"], {}, undefined);
check(
	sap?.text === "Let me think",
	"SAP native reasoning_content blocks surface as thinking text",
);

// Multiple blocks in one chunk concatenate.
const multi = selectReasoningDelta(["foo", "bar"], {}, undefined);
check(multi?.text === "foobar", "multiple reasoning blocks are joined");

// getDeltaReasoningContent maps missing content to "" — an all-empty array is
// treated as absent so the string fallback still gets a chance.
const emptyBlocks = selectReasoningDelta(
	[""],
	{ reasoning_content: "from-string" },
	undefined,
);
check(
	emptyBlocks?.text === "from-string",
	"all-empty blocks fall through to the string-shaped delta",
);

// --- OpenAI-compat string fallback ---------------------------------------

check(
	selectReasoningDelta(undefined, { reasoning_content: "abc" }, undefined)
		?.text === "abc",
	"string reasoning_content is picked when no SDK blocks",
);
check(
	selectReasoningDelta(undefined, { reasoning: "xyz" }, undefined)?.text ===
		"xyz",
	"legacy `reasoning` string field is picked",
);

// Field latching: once a provider's field is chosen, it is returned so the
// caller can prefer it on later chunks (double-count defense for providers
// that echo the same text on `reasoning` AND `reasoning_content`).
const latched = selectReasoningDelta(
	undefined,
	{ reasoning: "dup", reasoning_content: "dup" },
	undefined,
);
check(
	latched?.field === "reasoning_content",
	"string fallback returns the chosen field for latching",
);
const relatched = selectReasoningDelta(
	undefined,
	{ reasoning: "dup", reasoning_content: "dup" },
	"reasoning",
);
check(
	relatched?.field === "reasoning",
	"a previously-latched field is honored on subsequent chunks",
);

// --- absence --------------------------------------------------------------

check(
	selectReasoningDelta(undefined, {}, undefined) === undefined,
	"no reasoning on the chunk returns undefined",
);
check(
	selectReasoningDelta([], { content: "hi" }, undefined) === undefined,
	"a chunk with only visible content has no reasoning",
);

if (failures > 0) {
	console.error(`\n❌ ${failures} check(s) failed`);
	process.exit(1);
}
console.log("\n✅ reasoning-delta selection test passed");
