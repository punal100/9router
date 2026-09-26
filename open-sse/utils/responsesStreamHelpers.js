// Helpers for OpenAI Responses API streaming termination + event framing
import { FORMATS } from "../translator/formats.js";
import { formatSSE } from "./streamHelpers.js";
import { normalizeErrorMessage } from "./error.js";

// Responses API events that signal the stream has reached a terminal state
const OPENAI_RESPONSES_TERMINAL_EVENTS = new Set([
  "response.completed",
  "response.done",
  "response.failed",
  "error"
]);

export function getOpenAIResponsesEventName(eventName, chunk) {
  if (eventName) return eventName;
  if (chunk && typeof chunk.type === "string") return chunk.type;
  return null;
}

export function isOpenAIResponsesTerminalEvent(eventName, chunk) {
  const type = getOpenAIResponsesEventName(eventName, chunk);
  if (OPENAI_RESPONSES_TERMINAL_EVENTS.has(type)) return true;
  const status = chunk?.response?.status;
  return status === "completed" || status === "failed";
}

const sharedEncoder = new TextEncoder();

// Encoded response.failed + [DONE] payload for aborted/stalled Responses passthrough streams
export function buildAbortedResponsesTerminalBytes() {
  return sharedEncoder.encode(`${formatIncompleteOpenAIResponsesStreamFailure()}data: [DONE]\n\n`);
}

// Canonicalize an upstream error payload for Responses clients. The wire contract
// is `{ error: { message, type, code } }`, but upstreams also emit a flat
// `{ message, type, code }` — or a stringified copy of one. Clients cannot
// classify those, so they surface as an unknown error and never retry. Keep the
// original fields, replace any JSON-blob message with plain text, and add the
// nested envelope when it is missing.
export function normalizeResponsesErrorEvent(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
  if (payload.error && typeof payload.error === "object" && typeof payload.error.message === "string") {
    return payload;
  }
  // Only payloads that actually carry a message are error-shaped; leave normal
  // Responses events (deltas, completed, …) untouched.
  const message = normalizeErrorMessage(payload.message ?? payload.error);
  if (!message) return payload;

  // A double-encoded message hides the upstream code/type inside the same blob.
  let nested = null;
  if (typeof payload.message === "string") {
    const trimmed = payload.message.trim();
    if (trimmed.startsWith("{")) {
      try { nested = JSON.parse(trimmed); } catch { nested = null; }
    }
  }

  const code = [payload.code, payload.error?.code, nested?.code]
    .find((value) => typeof value === "string" && value);
  const type = [payload.type, nested?.type]
    .find((value) => typeof value === "string" && value && value !== "error");

  return {
    ...payload,
    // Clients read the top-level message too — never hand them the raw blob.
    message,
    error: {
      message,
      type: type || "upstream_error",
      ...(code ? { code } : {}),
    },
  };
}

// Synthesize a response.failed event for streams that close without a terminal event
export function formatIncompleteOpenAIResponsesStreamFailure() {
  return formatSSE({
    event: "response.failed",
    data: {
      type: "response.failed",
      response: {
        id: `resp_${Date.now()}`,
        status: "failed",
        error: {
          type: "stream_error",
          code: "stream_disconnected",
          message: "stream closed before response.completed"
        }
      }
    }
  }, FORMATS.OPENAI_RESPONSES);
}
