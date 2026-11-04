import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { AssistantMessageEventStream } from "@earendil-works/pi-ai";

/** Give OMP a visible status for an empty normal stop without hiding failed turns. */
export function completeOmpStream(source: AssistantMessageEventStream): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	void (async () => {
		for await (const event of source) {
			if (event.type === "done" && event.reason === "stop" &&
				!event.message.content.some((block) => block.type === "toolCall" ||
					(block.type === "text" && block.text.trim().length > 0))) {
				const message = { ...event.message, content: [...event.message.content, { type: "text" as const, text: "No response." }] };
				const contentIndex = message.content.length - 1;
				stream.push({ type: "text_start", contentIndex, partial: message });
				stream.push({ type: "text_delta", contentIndex, delta: "No response.", partial: message });
				stream.push({ type: "text_end", contentIndex, content: "No response.", partial: message });
				stream.push({ ...event, message });
			} else {
				stream.push(event);
			}
		}
		stream.end();
	})();
	return stream;
}
