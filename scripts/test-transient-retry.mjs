#!/usr/bin/env node
// Offline regression test for transient server-error classification.
//
// SAP's orchestration gateway occasionally returns a retryable failure after
// templating succeeds: a mid-stream 400 whose body says "Try your request
// again" (observed as "LLM Module: ... unexpected error during processing" on
// newly-added models like opus-4.8), or an Envoy/Istio "upstream connect
// error" when the backend is briefly unreachable. streamSapAiCore retries
// these a bounded number of times before any chunk reaches pi. This test locks
// which errors isTransientServerError classifies as retryable vs. terminal; it
// makes no network calls.

import { pathToFileURL } from "node:url";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;

const { isTransientServerError, formatError } = await import(
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

// Mirror the SAP SSE error shape formatError extracts: the SDK throws
// `Error("Error received from the server.\n" + JSON.stringify(data.error))`.
function sapSseError(body) {
	return new Error(`Error received from the server.\n${JSON.stringify(body)}`);
}

// --- retryable: SAP "try again" 400 (the opus-4.8 report) -----------------

const llmModule400 = sapSseError({
	code: 400,
	location: "LLM Module",
	message:
		"The system encountered an unexpected error during processing. Try your request again.",
	request_id: "8b1dcd46-f40b-97c4-905f-61b581aaef18",
});
check(
	isTransientServerError(llmModule400),
	'SAP 400 "Try your request again" (LLM Module) is transient',
);
// The matcher must not depend on the system-prompt echo being stripped first;
// confirm formatError produced the signal it keys on.
check(
	/try your request again/i.test(formatError(llmModule400)),
	"formatError surfaces the retryable phrase",
);

// --- retryable: gateway 5xx / unavailability ------------------------------

check(
	isTransientServerError(sapSseError({ code: 503, message: "Service Unavailable" })),
	"SAP 503 Service Unavailable is transient",
);
check(
	isTransientServerError(sapSseError({ code: 500, message: "upstream connect error or disconnect/reset before headers" })),
	"gateway upstream connect error is transient",
);

// The gateway's plain-text body makes the SDK throw a raw JSON.parse
// SyntaxError (V8 echoes the offending input). Matched structurally.
check(
	isTransientServerError(
		new SyntaxError(`Unexpected token 'u', "upstream c"... is not valid JSON`),
	),
	"gateway JSON.parse SyntaxError is transient",
);

// --- terminal: never retried ----------------------------------------------

check(
	!isTransientServerError(
		sapSseError({ code: 400, message: "Streaming is not supported for this model." }),
	),
	"streaming-not-supported 400 is NOT transient (handled by its own fallback)",
);
check(
	!isTransientServerError(
		sapSseError({ code: 400, message: "Invalid value for parameter 'temperature'." }),
	),
	"bad-parameter 400 is NOT transient",
);
check(
	!isTransientServerError(
		sapSseError({ code: 413, message: "Request entity too large" }),
	),
	"oversized-context 413 is NOT transient",
);
check(
	!isTransientServerError(new Error("some unrelated local failure")),
	"unrelated local error is NOT transient",
);

if (failures > 0) {
	console.error(`\n❌ ${failures} check(s) failed`);
	process.exit(1);
}
console.log("\n✅ transient server-error classification test passed");
