import { describe, expect, it } from "vitest";

import { createErrorResult, getClientErrorStatus, parseUpstreamError, normalizeErrorMessage, isTransientStreamError } from "../../open-sse/utils/error.js";

describe("createErrorResult", () => {
  it("can expose a retryable client status while preserving provider status", async () => {
    const result = createErrorResult(502, "[400]: Bad Request", undefined, 400);

    expect(result.status).toBe(502);
    expect(result.accountStatus).toBe(400);
    expect(result.response.status).toBe(502);
    expect(await result.response.json()).toEqual({
      error: {
        message: "[400]: Bad Request",
        type: "server_error",
        code: "bad_gateway"
      }
    });
  });
});

describe("getClientErrorStatus", () => {
  it("maps Cloudflare 524 to retryable 502", () => {
    expect(getClientErrorStatus(524)).toBe(502);
  });

  it("preserves standard upstream statuses", () => {
    expect(getClientErrorStatus(429)).toBe(429);
    expect(getClientErrorStatus(503)).toBe(503);
  });

  it("maps transient transport failures to a retryable 502", () => {
    expect(getClientErrorStatus(500, "Upstream HTTP/2 stream failed")).toBe(502);
    expect(getClientErrorStatus(500, "upstream_http2_stream_error")).toBe(502);
    expect(getClientErrorStatus(500, "invalid_request_error")).toBe(500);
  });
});

describe("normalizeErrorMessage", () => {
  it("unwraps a double-encoded error body into plain text", () => {
    // Reported shape: the upstream error object arrives as a JSON *string*
    // inside the message, so clients show an unclassifiable blob.
    const body = JSON.stringify({
      message: "Upstream HTTP/2 stream failed",
      type: "upstream_error",
      code: "upstream_http2_stream_error",
    });

    expect(normalizeErrorMessage(body)).toBe("Upstream HTTP/2 stream failed");
  });

  it("unwraps nested error envelopes", () => {
    expect(normalizeErrorMessage({ error: { message: "nested" } })).toBe("nested");
    expect(normalizeErrorMessage({ error: JSON.stringify({ error: { message: "deep" } }) })).toBe("deep");
    expect(normalizeErrorMessage([{ message: "from array" }])).toBe("from array");
  });

  it("keeps plain text and ignores unreadable payloads", () => {
    expect(normalizeErrorMessage("  plain failure  ")).toBe("plain failure");
    expect(normalizeErrorMessage("{not json")).toBe("{not json");
    expect(normalizeErrorMessage({})).toBe("");
    expect(normalizeErrorMessage(null)).toBe("");
  });
});

describe("isTransientStreamError", () => {
  it("recognizes provider-agnostic transport failures", () => {
    expect(isTransientStreamError("upstream_http2_stream_error")).toBe(true);
    expect(isTransientStreamError("Upstream HTTP/2 stream failed")).toBe(true);
    expect(isTransientStreamError("socket hang up")).toBe(true);
  });

  it("does not flag request or credential errors", () => {
    expect(isTransientStreamError("invalid_request_error")).toBe(false);
    expect(isTransientStreamError("model not found")).toBe(false);
    expect(isTransientStreamError("")).toBe(false);
  });
});

describe("parseUpstreamError", () => {
  it("reduces a Cloudflare HTML error page to its title", async () => {
    const response = new Response(`<!DOCTYPE html>
      <html><head><title>524: A timeout occurred</title></head>
      <body><div>large Cloudflare error page</div></body></html>`, {
      status: 524,
      headers: { "Content-Type": "text/html; charset=UTF-8" }
    });

    const executor = {
      parseError: (_response, bodyText) => ({ status: 524, message: bodyText })
    };

    await expect(parseUpstreamError(response, executor)).resolves.toEqual({
      statusCode: 524,
      message: "524: A timeout occurred"
    });
  });

  it("does not expose an HTML body when no title exists", async () => {
    const response = new Response("<html><body>sensitive upstream details</body></html>", {
      status: 502,
      headers: { "Content-Type": "text/html" }
    });

    await expect(parseUpstreamError(response)).resolves.toEqual({
      statusCode: 502,
      message: "Upstream returned an HTML error page (502)"
    });
  });

  it("never forwards a raw JSON body as the client message", async () => {
    // base.parseError hands back the untouched body, so a flat upstream error
    // object used to reach the client as a JSON string ("unknown error" there).
    const response = new Response(JSON.stringify({
      message: "Upstream HTTP/2 stream failed",
      type: "upstream_error",
      code: "upstream_http2_stream_error",
    }), { status: 502, headers: { "Content-Type": "application/json" } });
    const executor = { parseError: (_response, bodyText) => ({ status: 502, message: bodyText }) };

    await expect(parseUpstreamError(response, executor)).resolves.toEqual({
      statusCode: 502,
      message: "Upstream HTTP/2 stream failed",
    });
  });

  it("unwraps a nested error object when no executor parses it", async () => {
    const response = new Response(JSON.stringify({ error: { message: "quota exhausted" } }), {
      status: 429,
      headers: { "Content-Type": "application/json" },
    });

    await expect(parseUpstreamError(response)).resolves.toEqual({
      statusCode: 429,
      message: "quota exhausted",
    });
  });
});
