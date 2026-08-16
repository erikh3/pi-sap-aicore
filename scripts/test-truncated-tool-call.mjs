#!/usr/bin/env node
// Offline regression test for truncated tool-call detection.
//
// When SAP ends a stream with finish_reason "length" while a tool call's
// arguments JSON is still open, the accumulated fragment fails to parse.
// Dispatching such a call would run the tool with stale/empty arguments,
// which downstream surfaces as a confusing schema violation (observed with
// opus-4.8 adaptive high thinking exhausting max_tokens mid-`yield`). The
// stream finalizer must detect this and raise a visible, actionable error
// instead of emitting a well-formed-looking tool call. This test locks the
// detection + message behavior; it makes no network calls.

import { pathToFileURL } from "node:url";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;

const { toolArgsTruncated, truncatedToolCallError } = await import(
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

// --- toolArgsTruncated ---------------------------------------------------

// Empty fragment: the model emitted no arguments at all. Not a truncation —
// a legitimate zero-arg tool call parses `{}` elsewhere; nothing to reject.
check(!toolArgsTruncated(""), "empty partialJson is not treated as truncated");

// Complete objects parse cleanly and must pass through.
check(
	!toolArgsTruncated('{"overall_correctness":"pass"}'),
	"complete JSON object is not truncated",
);
check(!toolArgsTruncated("{}"), "empty JSON object is not truncated");
check(
	!toolArgsTruncated('{"a":{"b":[1,2,3]}}'),
	"complete nested JSON is not truncated",
);

// The failure mode: arguments cut mid-string / mid-object never parse.
check(
	toolArgsTruncated('{"overall_correctness":"pa'),
	"JSON cut mid-string is truncated",
);
check(
	toolArgsTruncated('{"findings":[{"title":"x"'),
	"JSON cut mid-object is truncated",
);
check(toolArgsTruncated("{"), "lone opening brace is truncated");

// --- truncatedToolCallError ----------------------------------------------

const lengthMsg = truncatedToolCallError("length");
check(
	lengthMsg.includes("max_tokens") && lengthMsg.includes("finish_reason=length"),
	"length error names max_tokens and finish_reason=length",
);
check(
	/thinking level|output size|retry/i.test(lengthMsg),
	"length error is actionable (mentions thinking level / output size / retry)",
);

const otherMsg = truncatedToolCallError("stop");
check(
	otherMsg.includes("finish_reason=stop"),
	"non-length error echoes the actual finish reason",
);

const unknownMsg = truncatedToolCallError(undefined);
check(
	unknownMsg.includes("unknown"),
	"missing finish reason renders as unknown",
);

if (failures > 0) {
	console.error(`\n❌ ${failures} check(s) failed`);
	process.exit(1);
}
console.log("\n✅ truncated tool-call detection test passed");
