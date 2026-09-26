import { describe, expect, it } from "vitest";

import { normalizeResponsesErrorEvent } from "../../open-sse/utils/responsesStreamHelpers.js";
import { createPassthroughStreamWithLogger } from "../../open-sse/utils/stream.js";
import { openaiResponsesToOpenAIResponse } from "../../open-sse/translator/response/openai-responses.js";

async function runPassthrough(input) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(input));
      controller.close();
    },
  });

  const output = stream.pipeThrough(createPassthroughStreamWithLogger(null, null, "gpt-5.6-sol"));
  const reader = output.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

describe("normalizeResponsesErrorEvent", () => {
  it("adds the nested error envelope to a flat upstream error", () => {
    // Reported shape: a Responses upstream reports a transport failure flat
    // ({ message, type, code }), which clients cannot classify — they surface it
    // as an unknown error and never retry.
    const out = normalizeResponsesErrorEvent({
      message: "Upstream HTTP/2 stream failed",
      type: "upstream_error",
      code: "upstream_http2_stream_error",
    });

    expect(out.error).toEqual({
      message: "Upstream HTTP/2 stream failed",
      type: "upstream_error",
      code: "upstream_http2_stream_error",
    });
    // Original fields survive so nothing is lost for clients reading them.
    expect(out.message).toBe("Upstream HTTP/2 stream failed");
  });

  it("unwraps a stringified message into plain text", () => {
    const out = normalizeResponsesErrorEvent({
      message: JSON.stringify({
        message: "Upstream HTTP/2 stream failed",
        code: "upstream_http2_stream_error",
      }),
    });

    expect(out.error.message).toBe("Upstream HTTP/2 stream failed");
    expect(out.error.code).toBe("upstream_http2_stream_error");
    // The top-level message is replaced too — clients that read it must not get
    // the raw JSON blob (the reported "UnknownError" payload).
    expect(out.message).toBe("Upstream HTTP/2 stream failed");
  });

  it("leaves an already-canonical error untouched", () => {
    const payload = { type: "error", error: { message: "boom", type: "server_error", code: "x" } };

    expect(normalizeResponsesErrorEvent(payload)).toBe(payload);
  });

  it("leaves normal stream events untouched", () => {
    const delta = { type: "response.output_text.delta", delta: "hi" };
    const completed = { type: "response.completed", response: { status: "completed" } };

    expect(normalizeResponsesErrorEvent(delta)).toBe(delta);
    expect(normalizeResponsesErrorEvent(completed)).toBe(completed);
  });
});

describe("passthrough stream error framing", () => {
  it("forwards a flat upstream error frame with the nested envelope", async () => {
    // OpenAI-compatible / Responses-speaking providers stream this flat shape;
    // passthrough used to forward it verbatim, so clients showed "unknown error".
    const payload = {
      message: "Upstream HTTP/2 stream failed",
      type: "upstream_error",
      code: "upstream_http2_stream_error",
    };

    const text = await runPassthrough(`event: error\ndata: ${JSON.stringify(payload)}\n\n`);
    const dataLine = text.split("\n").find((line) => line.startsWith("data: {"));

    expect(JSON.parse(dataLine.slice(5)).error).toEqual(payload);
  });
});

describe("Responses upstream → Chat client error translation", () => {
  it("surfaces a flat upstream error instead of dropping it", () => {
    // A flat payload has no `error` key, so the translator used to return null
    // and the Chat client saw the stream end with no explanation.
    const out = openaiResponsesToOpenAIResponse({
      type: "error",
      message: "Upstream HTTP/2 stream failed",
      code: "upstream_http2_stream_error",
    }, {});

    expect(out?.choices?.[0]?.delta?.content).toContain("Upstream HTTP/2 stream failed");
  });
});
