import type {
	AssistantMessage,
	Context,
	TextContent,
	Tool,
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
const EPHEMERAL: CacheControl = { type: "ephemeral" };

export function piContextToOrchestration(context: Context): {
	messages: ChatMessage[];
	tools: ChatCompletionTool[];
} {
	const messages: ChatMessage[] = [];

	if (context.systemPrompt) {
		messages.push(
			tagCacheControl(
				{ role: "system", content: context.systemPrompt },
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
		const msg = pi[i];

		if (msg.role === "assistant") {
			const assistant = piAssistantToOrchestration(msg);
			const toolCalls = assistant.tool_calls ?? [];
			if (toolCalls.length === 0) {
				messages.push(assistant);
				continue;
			}

			messages.push(assistant);

			// Anthropic (which SAP orchestration wraps for `anthropic--*` models)
			// requires the user turn immediately after an assistant's tool_use
			// blocks to begin with a tool_result for EVERY tool_call_id, with
			// nothing interleaved. Pi stores each tool result as its own top-level
			// message, and image-bearing results (e.g. `read` on a PNG) get
			// hoisted into a synthetic user message. Translating results one at a
			// time therefore produces tool, user(image), tool — and Anthropic
			// rejects the trailing tool_use as unanswered:
			// "tool_use ids were found without tool_result blocks immediately
			// after". Batch all contiguous tool results first: emit every
			// role:"tool" message, THEN any hoisted images, THEN orphans. Mirrors
			// the foundation Bedrock/Azure translators.
			const expectedIds = toolCalls.map((tc) => tc.id);
			const expected = new Set(expectedIds);
			const byId = new Map<string, OrchestrationToolResultParts>();
			const orphaned: ChatMessage[] = [];

			let j = i + 1;
			while (j < pi.length) {
				const toolResult = pi[j];
				if (toolResult.role !== "toolResult") break;
				if (
					expected.has(toolResult.toolCallId) &&
					!byId.has(toolResult.toolCallId)
				) {
					byId.set(
						toolResult.toolCallId,
						piToolResultToOrchestrationParts(toolResult),
					);
				} else {
					orphaned.push(...piToolResultToSyntheticUserMessages(toolResult));
				}
				j++;
			}

			const imageMessages: ChatMessage[] = [];
			for (const id of expectedIds) {
				const parts = byId.get(id);
				if (parts) {
					messages.push(parts.toolMessage);
					imageMessages.push(...parts.imageMessages);
				} else {
					messages.push(missingToolResultMessage(id));
				}
			}
			messages.push(...imageMessages, ...orphaned);
			i = j - 1;
			continue;
		}

		if (msg.role === "toolResult") {
			// A standalone tool result with no preceding assistant tool_use is an
			// invalid bare role:"tool" message for Anthropic. Keep the information
			// available to the model as user-visible transcript text.
			messages.push(...piToolResultToSyntheticUserMessages(msg));
			continue;
		}

		// user
		const user = piUserToOrchestration(msg);
		const tagLast = CACHE_CONTROL_ENABLED && i === lastUserIdx;
		messages.push(tagLast ? tagCacheControl(user, true) : user);
	}

	const tools = (context.tools ?? []).map(piToolToOrchestration);

	return { messages, tools };
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
		return { role: "user", content: msg.content };
	}

	const items: UserChatMessageContentItem[] = msg.content.map((part) => {
		if (part.type === "text") {
			return { type: "text", text: part.text };
		}
		return {
			type: "image_url",
			image_url: { url: `data:${part.mimeType};base64,${part.data}` },
		};
	});

	return { role: "user", content: items as UserChatMessageContent };
}

function piAssistantToOrchestration(msg: AssistantMessage): ChatMessage {
	let text = "";
	const toolCalls: NonNullable<AssistantChatMessage["tool_calls"]> = [];

	for (const block of msg.content) {
		if (block.type === "text") {
			text += block.text;
		} else if (block.type === "toolCall") {
			toolCalls.push({
				id: block.id,
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
		content: hasText ? text : toolCalls.length === 0 ? "(interrupted)" : "",
	};
	if (toolCalls.length > 0) result.tool_calls = toolCalls;
	return result;
}

type OrchestrationToolResultParts = {
	toolMessage: ChatMessage;
	imageMessages: ChatMessage[];
};

// Translate one matched tool result into a role:"tool" message plus any image
// blocks hoisted into synthetic user messages. SAP's ToolChatMessage.content
// schema is text-only (`string | TextContent[]`), so image blocks produced by
// pi tools (most commonly `read` on an image file) can't ride along on the
// tool message; they follow as user messages. The caller batches these so all
// tool messages precede all images — see piContextToOrchestration.
function piToolResultToOrchestrationParts(
	msg: ToolResultMessage,
): OrchestrationToolResultParts {
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
		tool_call_id: msg.toolCallId,
		// Anthropic rejects empty tool_result content; fall back to a
		// non-whitespace placeholder (pointing at the hoisted image when there
		// is one) so the request validates.
		content:
			text ||
			(imageMessages.length > 0
				? "Tool returned image content; image(s) follow in the next user message."
				: "(no output)"),
	};

	return { toolMessage, imageMessages };
}

// Placeholder tool message for a tool_use whose result is absent from the
// local transcript (e.g. a turn interrupted mid tool-call). Without it the
// assistant's tool_use block is left unanswered and Anthropic 400s.
function missingToolResultMessage(toolCallId: string): ChatMessage {
	return {
		role: "tool",
		tool_call_id: toolCallId,
		content: "[Tool result missing from local transcript.]",
	};
}

// Present a tool result as ordinary user-visible transcript text. Used for
// standalone/orphaned tool results that have no matching preceding tool_use,
// where a bare role:"tool" message would be invalid.
function piToolResultToSyntheticUserMessages(
	msg: ToolResultMessage,
): ChatMessage[] {
	const content: UserChatMessageContentItem[] = [
		{
			type: "text",
			text: `Tool result for ${msg.toolName} (${msg.toolCallId}):\n${
				toolResultText(msg) || "[no textual output]"
			}`,
		},
		...toolResultImages(msg).map((img) => ({
			type: "image_url" as const,
			image_url: { url: `data:${img.mimeType};base64,${img.data}` },
		})),
	];
	return [{ role: "user", content: content as UserChatMessageContent }];
}

function toolResultText(msg: ToolResultMessage): string {
	return msg.content
		.filter((part): part is TextContent => part.type === "text")
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
