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

// Envoy "no healthy upstream" (zero healthy backend pods). Bun truncates the
// body to its first token ("no"); V8 reports the full body without a trailing
// ellipsis. Both must still classify as transient AND be diagnosed as Envoy.
check(
	isTransientServerError(
		new SyntaxError(`JSON Parse error: Unexpected identifier "no"`),
	),
	"Bun no-healthy-upstream SyntaxError is transient",
);
check(
	isTransientServerError(
		new SyntaxError(`Unexpected token 'o', "no healthy upstream" is not valid JSON`),
	),
	"V8 no-healthy-upstream SyntaxError is transient",
);
check(
	/gateway \(Envoy\)/.test(
		formatError(new SyntaxError(`JSON Parse error: Unexpected identifier "no"`)),
	),
	"Bun no-healthy-upstream is diagnosed as Envoy",
);
check(
	/gateway \(Envoy\)/.test(
		formatError(
			new SyntaxError(`Unexpected token 'o', "no healthy upstream" is not valid JSON`),
		),
	),
	"V8 no-healthy-upstream is diagnosed as Envoy",
);

// --- patched SDK path: full body recovered on error.response.data ---------
// patches/@sap-ai-sdk+core+2.17.0.patch makes handleStreamError keep the raw
// plain-text body instead of throwing a SyntaxError, so the gateway error now
// arrives as ErrorWithCause(message, axiosError) with the full body on
// axiosError.response.data. formatError must surface the complete body (not a
// truncated "no" token) plus the Envoy diagnosis.
function sapGatewayError(body, status) {
	const axiosErr = new Error(`Request failed with status code ${status}`);
	axiosErr.response = { data: body };
	const wrapper = new Error(`Request failed with status code ${status}.`);
	wrapper.cause = axiosErr;
	return wrapper;
}

const patched503 = sapGatewayError("no healthy upstream", 503);
check(
	/no healthy upstream/.test(formatError(patched503)),
	"patched path surfaces the full gateway body verbatim",
);
check(
	/gateway \(Envoy\)/.test(formatError(patched503)),
	"patched no-healthy-upstream is diagnosed as Envoy",
);
check(
	isTransientServerError(patched503),
	"patched no-healthy-upstream is transient",
);
// No status code in the wrapper: classification must come from the body phrase
// alone, proving the "no healthy upstream" regex alternative pulls its weight.
check(
	isTransientServerError(sapGatewayError("no healthy upstream", undefined)),
	"no-healthy-upstream body is transient even without a 5xx status code",
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
