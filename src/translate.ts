import type {
	AssistantMessage,
	Context,
	Message,
	TextContent as PiTextContent,
	Tool,
	ToolCall,
	ToolResultMessage,
	UserMessage,
} from "@earendil-works/pi-ai";
import type {
	AssistantChatMessage,
	ChatCompletionTool,
	ChatMessage,
	UserChatMessageContent,
	UserChatMessageContentItem,
} from "@sap-ai-sdk/orchestration";
import { normalizeToolCallId } from "./tool-call-id.ts";

// Anthropic prompt caching via SAP orchestration is undocumented. SAP's
// ChatMessage schemas are strictly typed (no Record<string,any> escape
// hatch on content), `cache_control` appears nowhere in
// @sap-ai-sdk/orchestration, and the orchestration server may reject
// unknown fields with a 400. Opt-in via PI_SAP_AICORE_CACHE_CONTROL=1 so
// users can probe their own tenant without forcing the risk on everyone
// — if SAP accepts it, `cacheRead`/`cacheWrite` in the Usage block start
// reporting non-zero numbers and pi's cost line drops ~10× on cached
// turns. If SAP rejects it, the error chain will say so.
const CACHE_CONTROL_ENABLED =
	process.env.PI_SAP_AICORE_CACHE_CONTROL === "1";

type CacheControl = { type: "ephemeral" };
type OrchestrationTextContent = {
	type: "text";
	text: string;
	cache_control?: CacheControl;
};
const EPHEMERAL: CacheControl = { type: "ephemeral" };
const SAP_PLACEHOLDER_START = "{{?";

// SAP applies placeholder substitution to every message passed as a prompt
// template. Keep literal examples byte-for-byte intact for the model by splitting
// the marker across adjacent text blocks, so no individual block is executable
// templating syntax.
export function literalPlaceholderContent(
	text: string,
): string | OrchestrationTextContent[] {
	let marker = text.indexOf(SAP_PLACEHOLDER_START);
	if (marker === -1) return text;

	const blocks: OrchestrationTextContent[] = [];
	let start = 0;
	while (marker !== -1) {
		blocks.push({ type: "text", text: text.slice(start, marker + 2) });
		start = marker + 2;
		marker = text.indexOf(SAP_PLACEHOLDER_START, start);
	}
	blocks.push({ type: "text", text: text.slice(start) });
	return blocks;
}

export function piContextToOrchestration(context: Context): {
	messages: ChatMessage[];
	tools: ChatCompletionTool[];
} {
	const messages: ChatMessage[] = [];

	if (context.systemPrompt) {
		messages.push(
			tagCacheControl(
				{ role: "system", content: literalPlaceholderContent(context.systemPrompt) },
				CACHE_CONTROL_ENABLED,
			),
		);
	}

	const pi = context.messages;
	// Anthropic caches up to 4 breakpoints; tagging the LAST user message
	// (after the system prompt) is the standard "keep the long prefix
	// cached" pattern. We tag at most 1 here for safety; expand later
	// once SAP behaviour is confirmed.
	const lastUserIdx = lastIndexWhere(pi, (m) => m.role === "user");
	for (let i = 0; i < pi.length; i++) {
		const piIndex = i;
		const before = messages.length;
		const msg = pi[i];

		if (msg.role === "assistant") {
			const assistant = piAssistantToOrchestration(msg);
			messages.push(assistant);
			// Extract raw ids from the pi message for result-matching; the
			// translated assistant already carries normalized ids for the
			// outbound request. pushToolResultBlock matches results by raw id
			// and normalizes only when emitting the tool_call_id field.
			const rawToolCallIds = msg.content
				.filter((b): b is ToolCall => b.type === "toolCall")
				.map((b) => b.id);
			if (rawToolCallIds.length > 0) {
				i = pushToolResultBlock(messages, pi, i, rawToolCallIds);
			}
		} else if (msg.role === "toolResult") {
			// A standalone tool message is invalid for OpenAI-shaped backends.
			// Keep the information available to the model as transcript text.
			messages.push(...piToolResultToSyntheticUserMessages(msg));
		} else if (msg.role === "user") {
			messages.push(piUserToOrchestration(msg));
		}

		const tagLast = CACHE_CONTROL_ENABLED && piIndex === lastUserIdx;
		if (tagLast && messages.length > before) {
			messages[messages.length - 1] = tagCacheControl(
				messages[messages.length - 1],
				true,
			);
		}
	}

	const tools = (context.tools ?? []).map(piToolToOrchestration);

	assertToolMessagePairing(messages);
	return { messages, tools };
}

type ToolPairingView = {
	role: string;
	tool_calls?: { id: string }[];
	tool_call_id?: string;
};

// Last line of defence for the rule that wedges whole sessions when it is
// broken: every assistant `tool_calls` id must be answered by a role:"tool"
// message before the next message of any other role. The batching above and
// normalizeContext() upstream both uphold it, so reaching a violation here
// means a case neither anticipated — and the request is then guaranteed to
// fail at SAP with an opaque 400 naming ids the user cannot act on. Fail here
// instead, locally, naming the ids and where the pairing broke, and spend no
// round trip on a request that cannot succeed.
export function assertToolMessagePairing(
	messages: readonly ToolPairingView[],
): void {
	for (let i = 0; i < messages.length; i++) {
		const msg = messages[i];
		if (msg.role !== "assistant" || !msg.tool_calls?.length) continue;

		const answered = new Set<string>();
		let j = i + 1;
		for (; j < messages.length && messages[j].role === "tool"; j++) {
			const id = messages[j].tool_call_id;
			if (id) answered.add(id);
		}

		const unanswered = msg.tool_calls
			.map((toolCall) => toolCall.id)
			.filter((id) => !id || !answered.has(id));
		if (unanswered.length === 0) continue;

		const ids = unanswered.map((id) => id || "(empty id)").join(", ");
		throw new Error(
			`pi-sap-aicore built an invalid request: the assistant message at ` +
				`index ${i} has tool_calls with no matching tool message before the ` +
				`next ${messages[j]?.role ?? "end of conversation"}. Unanswered ` +
				`tool_call_ids: ${ids}. This is a bug in the extension's message ` +
				`translation, not in your conversation — please report it with this ` +
				`message. Set PI_SAP_AICORE_DEBUG_PAYLOAD=<file> and retry to capture ` +
				`the full request alongside it.`,
		);
	}
}

// SAP orchestration fronts OpenAI-shaped backends, which require every
// assistant `tool_calls` entry to be answered by a role:"tool" message for
// *all* of its ids, immediately after the assistant message. Pi stores each
// tool result as a separate top-level message and tool results may carry
// images, which this translator has to hoist into synthetic user messages
// (SAP's ToolChatMessage.content schema is text-only). Translating results
// one-by-one therefore produces `tool, user(image), tool` — and the backend
// rejects the second call as unanswered:
//   "An assistant message with 'tool_calls' must be followed by tool messages
//    responding to each 'tool_call_id'."
// Batch every contiguous tool result first, emit the required tool messages in
// tool_call order, then append hoisted images and any leftovers. Returns the
// index of the last pi message consumed.
function pushToolResultBlock(
	messages: ChatMessage[],
	pi: Message[],
	assistantIndex: number,
	expectedIds: string[],
): number {
	const expected = new Set(expectedIds);
	const byId = new Map<string, OrchestrationToolResultParts>();
	const orphaned: ChatMessage[] = [];

	let j = assistantIndex + 1;
	while (j < pi.length) {
		const toolResult = pi[j];
		if (toolResult.role !== "toolResult") break;
		if (expected.has(toolResult.toolCallId) && !byId.has(toolResult.toolCallId)) {
			byId.set(toolResult.toolCallId, piToolResultToOrchestrationParts(toolResult));
		} else {
			orphaned.push(...piToolResultToSyntheticUserMessages(toolResult));
		}
		j++;
	}

	const imageMessages: ChatMessage[] = [];
	for (const id of expectedIds) {
		const translated = byId.get(id);
		if (translated) {
			messages.push(translated.toolMessage);
			imageMessages.push(...translated.imageMessages);
		} else {
			// The tool call was never answered locally — pi's transformMessages()
			// normally synthesises a result first (see src/normalize-context.ts),
			// so reaching here means a caller bypassed it. Answer it anyway: a
			// missing id fails the whole request, and every later request in the
			// conversation with it.
			messages.push(missingToolResultMessage(id));
		}
	}
	messages.push(...imageMessages, ...orphaned);
	return j - 1;
}

function lastIndexWhere<T>(arr: T[], pred: (t: T) => boolean): number {
	for (let i = arr.length - 1; i >= 0; i--) if (pred(arr[i])) return i;
	return -1;
}

// Tag a translated message's last text content with Anthropic's
// `cache_control: {type: "ephemeral"}`. Casts through `any` because
// SAP's typings forbid it (Anthropic-native field that SAP doesn't
// expose in its schema — see note at top of file).
function tagCacheControl(msg: ChatMessage, enabled: boolean): ChatMessage {
	if (!enabled) return msg;
	if (typeof msg.content === "string") {
		return {
			...msg,
			content: [
				{ type: "text", text: msg.content, cache_control: EPHEMERAL } as any,
			],
		} as ChatMessage;
	}
	if (Array.isArray(msg.content) && msg.content.length > 0) {
		const items = msg.content.slice();
		const last = items[items.length - 1] as any;
		items[items.length - 1] = { ...last, cache_control: EPHEMERAL };
		return { ...msg, content: items } as ChatMessage;
	}
	return msg;
}

function piUserToOrchestration(msg: UserMessage): ChatMessage {
	if (typeof msg.content === "string") {
		return { role: "user", content: literalPlaceholderContent(msg.content) };
	}

	const items: UserChatMessageContentItem[] = [];
	for (const part of msg.content) {
		if (part.type === "text") {
			const content = literalPlaceholderContent(part.text);
			if (typeof content === "string") items.push({ type: "text", text: content });
			else items.push(...content);
		} else {
			items.push({
				type: "image_url",
				image_url: { url: `data:${part.mimeType};base64,${part.data}` },
			});
		}
	}

	return { role: "user", content: items as UserChatMessageContent };
}

function piAssistantToOrchestration(
	msg: AssistantMessage,
): AssistantChatMessage {
	let text = "";
	const toolCalls: NonNullable<AssistantChatMessage["tool_calls"]> = [];

	for (const block of msg.content) {
		if (block.type === "text") {
			text += block.text;
		} else if (block.type === "toolCall") {
			toolCalls.push({
				id: normalizeToolCallId(block.id),
				type: "function",
				function: {
					name: block.name,
					arguments: JSON.stringify(block.arguments),
				},
			});
		}
	}

	// Bedrock (which SAP orchestration wraps) rejects assistant messages with
	// no text AND no tool_calls — "Assistant message has neither text nor
	// tool_use blocks." Pi can produce these when a prior stream was
	// interrupted (e.g. aborting mid tool-call) or the turn contained only
	// block types we don't translate (e.g. reasoning-only).
	//
	// A whitespace-only placeholder does NOT work: Anthropic-on-Bedrock trims
	// text content back to empty, so a single space collapses and the request
	// still 400s with the same "neither text nor tool_use" error — poisoning
	// every subsequent request in the conversation. Substitute NON-whitespace
	// text so the message validates, while preserving conversation alternation
	// 1:1 with pi's log. Only needed when there are no tool_calls to carry the
	// turn; a whitespace-only accumulated `text` is treated as empty too.
	const hasText = text.trim().length > 0;
	const result: AssistantChatMessage = {
		role: "assistant",
		content: hasText
			? literalPlaceholderContent(text)
			: toolCalls.length === 0
				? "(interrupted)"
				: "",
	};
	if (toolCalls.length > 0) result.tool_calls = toolCalls;
	return result;
}

type OrchestrationToolResultParts = {
	toolMessage: ChatMessage;
	imageMessages: ChatMessage[];
};

function piToolResultToOrchestrationParts(
	msg: ToolResultMessage,
): OrchestrationToolResultParts {
	// SAP's ToolChatMessage.content schema is text-only (`string |
	// TextContent[]`), so any image blocks produced by pi tools (most
	// commonly the `read` tool on an image file) would be silently dropped.
	// Hoist them into synthetic user messages placed after the required
	// tool-message block so vision-capable models actually see the bytes.
	const text = toolResultText(msg);
	const imageMessages: ChatMessage[] = toolResultImages(msg).map((img) => ({
		role: "user",
		content: [
			{
				type: "image_url",
				image_url: { url: `data:${img.mimeType};base64,${img.data}` },
			},
		] as UserChatMessageContent,
	}));

	const toolMessage: ChatMessage = {
		role: "tool",
		tool_call_id: normalizeToolCallId(msg.toolCallId),
		// Anthropic rejects empty tool_result content; fall back to a
		// non-whitespace placeholder (pointing at the hoisted image when there
		// is one) so the request validates.
		content: literalPlaceholderContent(
			text ||
				(imageMessages.length > 0
					? "Tool returned image content; image(s) follow in the next user message."
					: "(no output)"),
		),
	};

	return { toolMessage, imageMessages };
}

// Placeholder tool message for a tool_use whose result is absent from the
// local transcript (e.g. a turn interrupted mid tool-call). Without it the
// assistant's tool_use block is left unanswered and Anthropic 400s.
function missingToolResultMessage(toolCallId: string): ChatMessage {
	return {
		role: "tool",
		tool_call_id: normalizeToolCallId(toolCallId),
		content: "[Tool result missing from local transcript.]",
	};
}

// Present a tool result as ordinary user-visible transcript text. Used for
// standalone/orphaned tool results that have no matching preceding tool_use,
// where a bare role:"tool" message would be invalid.
function piToolResultToSyntheticUserMessages(
	msg: ToolResultMessage,
): ChatMessage[] {
	const text = `Tool result for ${msg.toolName} (${msg.toolCallId}):\n${
		toolResultText(msg) || "[no textual output]"
	}`;
	const safeText = literalPlaceholderContent(text);
	const content: UserChatMessageContentItem[] = [
		...(typeof safeText === "string"
			? [{ type: "text" as const, text: safeText }]
			: safeText),
		...toolResultImages(msg).map((img) => ({
			type: "image_url" as const,
			image_url: { url: `data:${img.mimeType};base64,${img.data}` },
		})),
	];
	return [{ role: "user", content: content as UserChatMessageContent }];
}

function toolResultText(msg: ToolResultMessage): string {
	return msg.content
		.filter((part): part is PiTextContent => part.type === "text")
		.map((part) => part.text)
		.join("\n");
}

function toolResultImages(
	msg: ToolResultMessage,
): { type: "image"; data: string; mimeType: string }[] {
	return msg.content.filter(
		(part): part is { type: "image"; data: string; mimeType: string } =>
			part.type === "image",
	);
}

function piToolToOrchestration(tool: Tool): ChatCompletionTool {
	return {
		type: "function",
		function: {
			name: tool.name,
			description: tool.description,
			// SAFETY: Pi and SAP both use JSON Schema objects; their TS types differ.
			parameters: tool.parameters as unknown as Record<string, unknown>,
		},
	};
}

export function mapFinishReason(
	reason: string | undefined,
): "stop" | "length" | "toolUse" {
	switch (reason) {
		case "length":
			return "length";
		case "tool_calls":
		case "function_call":
			return "toolUse";
		default:
			return "stop";
	}
}
