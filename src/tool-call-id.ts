import { createHash } from "node:crypto";

// SAP's OpenAI-compatible backends (orchestration chat/completions and the
// Azure OpenAI foundation deployment) enforce OpenAI's documented 64-character
// cap on `tool_calls[].id` / `tool_call_id`. SAP's Bedrock Converse executable
// additionally requires `toolUseId` to match `[a-zA-Z0-9_-]+`.
//
// Pi's own tool-call ids are provider-native and do NOT universally satisfy
// those rules. The common offender is pi's `openai-responses` provider, which
// stores each call as a `call_<id>|fc_<item-id>` COMPOSITE (both parts are
// needed to replay a Responses-API turn); that is ~83 chars and contains a
// `|`. Switching such a conversation into a SAP model carries the composite id
// into the SAP request verbatim and SAP 400s:
//   "Invalid 'messages[2].tool_calls[0].id': string too long. Expected a
//    string with maximum length 64, but got a string with length 83 instead."
// Long synthetic Gemini ids (`<toolName>_<timestamp>_<counter>`) can trip the
// same length wall. This is a cross-provider history-replay problem, not an
// OpenAI-only one.
//
// Normalize any id that violates either rule to a deterministic, safe-char,
// <=64 id. HASH rather than truncate so two ids sharing a 64-char prefix can't
// collide into one (which would corrupt tool_call <-> tool_result pairing).
// Ids that already satisfy both rules pass through byte-identical, so
// Anthropic (`toolu_...`) and plain OpenAI (`call_...`) ids are untouched.
//
// The id only needs internal consistency within a single outgoing request:
// SAP's response carries fresh backend-generated ids that pi stores anew, so
// rewriting the replayed id never desynchronizes future turns. Pairing within
// the request is preserved because `piContextTo*` matches results to calls on
// the RAW id before translation, and the same raw id always maps to the same
// normalized id here.

const MAX_LENGTH = 64;
const SAFE_ID = /^[a-zA-Z0-9_-]+$/;

export function normalizeToolCallId(id: string): string {
	if (id.length <= MAX_LENGTH && SAFE_ID.test(id)) return id;
	// "call_" + 59 hex chars = 64 chars total, matches [a-zA-Z0-9_-]+.
	const digest = createHash("sha256").update(id).digest("hex").slice(0, 59);
	return `call_${digest}`;
}
