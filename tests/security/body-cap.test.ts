import { describe, expect, it } from "vitest";
import { readTextCapped } from "@serp/contracts";
import { HttpBingApiClient } from "@serp/provider-bing";
import { HttpClarityApiClient } from "@serp/provider-clarity";

/** A body that never ends: reading it to the end would exhaust memory. */
function endlessResponse(chunkBytes = 1024 * 1024) {
  let sent = 0;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      sent += chunkBytes;
      controller.enqueue(new Uint8Array(chunkBytes).fill(0x20));
    },
    cancel() {
      cancelled = true;
    },
  });
  return { res: new Response(body, { status: 200 }), sentBytes: () => sent, cancelled: () => cancelled };
}

describe("provider response size cap", () => {
  it("stops reading an endless body shortly after the limit and cancels it", async () => {
    const { res, sentBytes, cancelled } = endlessResponse();
    expect(await readTextCapped(res, 4 * 1024 * 1024)).toBeNull();
    expect(sentBytes()).toBeLessThanOrEqual(8 * 1024 * 1024);
    expect(cancelled()).toBe(true);
  });

  it("rejects up front when Content-Length already exceeds the limit", async () => {
    const res = new Response("x", { headers: { "content-length": "999999999" } });
    expect(await readTextCapped(res, 1024)).toBeNull();
  });

  it("returns normal bodies unchanged", async () => {
    expect(await readTextCapped(new Response('{"d":[1,2,3]}'), 1024)).toBe('{"d":[1,2,3]}');
    expect(await readTextCapped(new Response(null), 1024)).toBe("");
  });

  it("Clarity and Bing clients turn an oversized body into a bad_response, not a memory spike", async () => {
    const clarity = new HttpClarityApiClient({ fetchImpl: (async () => endlessResponse().res) as typeof fetch });
    await expect(clarity.exportLiveInsights("tok", { numOfDays: 1, dimensions: [] })).rejects.toMatchObject({ kind: "bad_response" });

    const bing = new HttpBingApiClient({ fetch: (async () => endlessResponse().res) as typeof fetch });
    await expect(bing.getUserSites({ method: "api_key", apiKey: "k".repeat(32) })).rejects.toMatchObject({ kind: "bad_response" });
  });
});
