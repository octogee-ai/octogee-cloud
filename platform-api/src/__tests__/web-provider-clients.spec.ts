import { describe, expect, it, vi } from "vitest";

import {
  WebProviderError,
  createBraveSearchClient,
  createTavilyClient,
} from "../lib/web-provider-clients.js";

describe("Brave search client", () => {
  it("calls only the fixed web endpoint with bounded locale and freshness parameters", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({
          web: {
            results: [
              {
                title: "Octopus research",
                url: "https://example.com/octopus",
                description: "Eight useful arms",
                age: "2 hours ago",
                profile: { long_name: "Example" },
              },
            ],
          },
        }),
        { status: 200, headers: { "content-type": "application/json", "x-request-id": "br-1" } },
      ),
    );
    const client = createBraveSearchClient({ apiKey: "brave-secret", fetchImpl });

    await expect(
      client.search({
        query: "octopus",
        count: 5,
        country: "US",
        searchLang: "en",
        freshness: "week",
      }),
    ).resolves.toEqual({
      provider: "brave",
      requestId: "br-1",
      results: [
        {
          title: "Octopus research",
          url: "https://example.com/octopus",
          snippet: "Eight useful arms",
          age: "2 hours ago",
          source: "Example",
        },
      ],
    });

    const [url, init] = fetchImpl.mock.calls[0];
    expect(String(url)).toBe(
      "https://api.search.brave.com/res/v1/web/search?q=octopus&count=5&country=US&search_lang=en&freshness=pw",
    );
    expect(new Headers(init?.headers).get("X-Subscription-Token")).toBe("brave-secret");
  });

  it("maps provider rate limiting without leaking the upstream body", async () => {
    const client = createBraveSearchClient({
      apiKey: "secret",
      fetchImpl: vi.fn(async () => new Response("account secret detail", { status: 429 })),
    });
    await expect(client.search({ query: "octopus" })).rejects.toMatchObject({
      code: "provider_rate_limited",
      status: 429,
      message: "Brave search rate limited",
    });
  });

  it("stops reading a successful provider body once the response cap is crossed", async () => {
    let reads = 0;
    let canceled = false;
    const response = new Response(
      new ReadableStream({
        pull(controller) {
          reads += 1;
          controller.enqueue(new TextEncoder().encode("12345678"));
          if (reads === 10) controller.close();
        },
        cancel() {
          canceled = true;
        },
      }),
      { status: 200 },
    );
    const client = createBraveSearchClient({
      apiKey: "secret",
      maxResponseBytes: 10,
      fetchImpl: vi.fn(async () => response),
    });
    await expect(client.search({ query: "octopus" })).rejects.toMatchObject({
      code: "provider_response_too_large",
    });
    expect(reads).toBeLessThan(10);
    expect(canceled).toBe(true);
  });
});

describe("Tavily client", () => {
  it("searches with usage enabled and normalizes results", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({
          request_id: "tv-1",
          results: [{ title: "Result", url: "https://example.com", content: "Useful" }],
          usage: { credits: 2 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const client = createTavilyClient({ apiKey: "tavily-secret", fetchImpl });
    await expect(
      client.search({ query: "research", searchDepth: "advanced", maxResults: 7 }),
    ).resolves.toMatchObject({
      provider: "tavily",
      requestId: "tv-1",
      credits: 2,
      results: [{ title: "Result", url: "https://example.com/", snippet: "Useful" }],
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.tavily.com/search",
      expect.objectContaining({
        method: "POST",
        headers: {
          Accept: "application/json",
          Authorization: "Bearer tavily-secret",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          query: "research",
          search_depth: "advanced",
          max_results: 7,
          include_answer: false,
          include_usage: true,
        }),
      }),
    );
  });

  it("extracts bounded URL batches and reports successful URLs", async () => {
    const client = createTavilyClient({
      apiKey: "secret",
      fetchImpl: vi.fn(async () =>
        new Response(
          JSON.stringify({
            request_id: "tv-x",
            results: [{ url: "https://example.com", raw_content: "Rendered" }],
            failed_results: [{ url: "https://bad.example", error: "blocked" }],
            usage: { credits: 0 },
          }),
          { status: 200 },
        ),
      ),
    });
    await expect(
      client.extract({
        urls: ["https://example.com", "https://bad.example"],
        extractDepth: "advanced",
      }),
    ).resolves.toMatchObject({
      requestId: "tv-x",
      successfulUrlCount: 1,
      results: [{ url: "https://example.com", content: "Rendered" }],
      failures: [{ url: "https://bad.example", error: "blocked" }],
    });
  });

  it("accepts an extract response with no failed_results field", async () => {
    const client = createTavilyClient({
      apiKey: "secret",
      fetchImpl: vi.fn(async () =>
        new Response(
          JSON.stringify({
            request_id: "tv-clean",
            results: [{ url: "https://example.com", raw_content: "Rendered" }],
          }),
          { status: 200 },
        ),
      ),
    });
    await expect(
      client.extract({ urls: ["https://example.com"] }),
    ).resolves.toMatchObject({ successfulUrlCount: 1, failures: [] });
  });

  it("rejects malformed provider responses", async () => {
    const client = createTavilyClient({
      apiKey: "secret",
      fetchImpl: vi.fn(async () => new Response(JSON.stringify({ results: "wrong" }), { status: 200 })),
    });
    await expect(client.search({ query: "research" })).rejects.toBeInstanceOf(WebProviderError);
  });
});
