import type {
	Api,
	Context,
	Model,
	SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { transformMessages } from "./transform-messages.ts";

// Pi hands `provider.stream()` the *raw* conversation log. Every built-in pi
// API adapter (openai-completions, anthropic-messages, bedrock-converse,
// google-shared, mistral-conversations) runs it through pi's shared
// `transformMessages()` before translating; this extension previously did not,
// so it replayed the log 1:1 and inherited two failure modes the helper exists
// to prevent:
//
//  1. Errored/aborted assistant turns were replayed. A turn that dies mid-stream
//     (SSE drop, user interrupt) is persisted by pi with the tool calls it had
//     emitted so far — and no tool results, because the turn never reached
//     execution. Replaying it produces a permanently wedged conversation:
//     "An assistant message with 'tool_calls' must be followed by tool messages
//     responding to each 'tool_call_id'". Every later request in that session
//     fails the same way. `transformMessages` drops those turns.
//  2. Orphaned tool calls survived. Where a tool call has no result for any other
//     reason (compaction dropped it, a user message interrupted the tool flow),
//     `transformMessages` synthesises an `isError` "No result provided" result so
//     the assistant/tool pairing stays complete.
//
// It also downgrades images for text-only models and normalises thinking blocks
// across a mid-conversation model switch, both of which the translators below
// otherwise get wrong.
//
// `./transform-messages.ts` is a vendored copy: pi's extension loader maps only
// a fixed set of pi-ai entrypoints, the real module is not among them, and
// `transformMessages` is re-exported from none of the ones that are. Unmapped
// specifiers resolve on an npm-layout pi and fail on a bundled one, so the map
// is the contract. See that file's header.
//
// Tool-call-id normalisation is intentionally not passed: SAP's OpenAI-style ids
// are already within Anthropic's `^[a-zA-Z0-9_-]{1,64}` constraint, and every
// translator here reads ids straight back out of the same transformed messages.
export function normalizeContext(
	context: Context,
	model: Model<Api>,
	options?: SimpleStreamOptions,
): Context {
	return {
		...context,
		messages: transformMessages(context.messages, model),
		tools: resolveTools(context, options),
	};
}

// pi 0.84.3 added `toolChoice` ("auto" | "none") to SimpleStreamOptions, and
// sets "none" on its summarization/compaction turns — the request that rewrites
// a long conversation into a summary has no business calling tools. Ignoring it
// let the model answer a compaction request with tool calls, which then have no
// results and poison the rest of the session (see the note above).
//
// Every route here therefore drops the tool list rather than translating the
// flag. That is uniform and cannot fail: SAP documents orchestration's
// `tool_choice` only as an unvalidated passthrough whose "behavior depends on
// the underlying model provider", and Bedrock's Converse `toolChoice` has no
// "none" member at all — omitting the tools is the only expression of "none"
// that every backend here understands. Nothing is lost: pi only sends "none"
// where the model does not need to see the tools, and that same call already
// opts out of prompt caching (`cacheRetention: "none"`), so shortening the
// prefix costs nothing.
//
// "auto" is every backend's default, so it needs no encoding. On pi < 0.84.3
// the field is simply absent and tools always flow through.
function resolveTools(
	context: Context,
	options?: SimpleStreamOptions,
): Context["tools"] {
	return options?.toolChoice === "none" ? [] : context.tools;
}
