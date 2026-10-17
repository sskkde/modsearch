import { afterEach, describe, expect, it, vi } from 'vitest';
import { classifyQuota } from '../cooldown.ts';
import { ApiKeyFailureError } from '../util/apiKeys.ts';
import { doubaoProvider, executeDoubaoSearch } from './doubao.ts';

afterEach(() => {
  vi.restoreAllMocks();
});

/** Mock global fetch with a JSON response, capturing the outgoing request. */
function mockFetchJson(body: unknown, init: { ok?: boolean; status?: number } = {}) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fn = vi.fn(async (url: string, requestInit: RequestInit) => {
    calls.push({ url, init: requestInit });
    return {
      ok: init.ok ?? true,
      status: init.status ?? 200,
      statusText: init.status === 401 ? 'Unauthorized' : init.status === 403 ? 'Forbidden' : 'OK',
      text: async () => JSON.stringify(body),
    } as unknown as Response;
  });
  vi.stubGlobal('fetch', fn);
  return calls;
}

function searchRequest(
  settings: Record<string, unknown> = { apiKey: 'doubao-test-key' },
  extra: Record<string, unknown> = {},
) {
  return {
    mode: 'search' as const,
    query: 'doubao provider test',
    timeoutMs: 1000,
    settings,
    ...extra,
  };
}

describe('doubao provider', () => {
  it('exports the search provider shape', () => {
    expect(doubaoProvider.name).toBe('doubao');
    expect(doubaoProvider.roles).toEqual(['search']);
    expect(doubaoProvider.execute).toBe(executeDoubaoSearch);
  });

  it('rejects fetch mode and a missing or empty query', async () => {
    await expect(
      executeDoubaoSearch({
        mode: 'fetch',
        url: 'https://example.com',
        timeoutMs: 1000,
        settings: {},
      }),
    ).rejects.toThrow(/does not support page fetch/);

    for (const query of [undefined, '']) {
      await expect(
        executeDoubaoSearch({
          mode: 'search',
          query,
          timeoutMs: 1000,
          settings: { apiKey: 'doubao-test-key' },
        }),
      ).rejects.toThrow(/requires a query/);
    }
  });

  it('reports an actionable missing-key error', async () => {
    await expect(
      executeDoubaoSearch({ mode: 'search', query: 'anything', timeoutMs: 1000, settings: {} }),
    ).rejects.toThrow(/DOUBAO_API_KEY/);
  });

  it('posts the Custom web search body with the key and a capped result count', async () => {
    const calls = mockFetchJson({ Result: { WebResults: [] } });
    await executeDoubaoSearch(searchRequest({ apiKey: 'doubao-test-key' }, { maxResults: 80 }));

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://open.feedcoopapi.com/search_api/web_search');
    expect(calls[0].init.method).toBe('POST');
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer doubao-test-key');
    expect(headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(calls[0].init.body as string)).toEqual({
      Query: 'doubao provider test',
      SearchType: 'web',
      // The Custom edition's Count ceiling is 50, not the Global edition's 20.
      Count: 50,
      Filter: { NeedUrl: true },
    });
    expect(calls[0].init.signal).toBeInstanceOf(AbortSignal);
  });

  it('honours a baseURL override and folds its trailing slash', async () => {
    const calls = mockFetchJson({ Result: { WebResults: [] } });
    await executeDoubaoSearch(
      searchRequest({ apiKey: 'doubao-test-key', baseURL: 'https://gateway.example.com/doubao/' }),
    );
    expect(calls[0].url).toBe('https://gateway.example.com/doubao/search_api/web_search');
  });

  it('rejects an invalid baseURL scheme', async () => {
    mockFetchJson({});
    await expect(
      executeDoubaoSearch(
        searchRequest({ apiKey: 'doubao-test-key', baseURL: 'ftp://gateway.example.com' }),
      ),
    ).rejects.toThrow(/Invalid engine baseURL/);
  });

  it('maps web results into the canonical shape, preferring the model-facing Summary', async () => {
    mockFetchJson({
      Result: {
        ResultCount: 1,
        WebResults: [
          {
            Id: '5f4408b2b5dd9d81-9b8fc02da10ab180',
            SortId: 1,
            Title: 'Example story',
            SiteName: 'Example News',
            Url: 'https://news.example.com/story',
            Snippet: 'Short list-view teaser.',
            Summary: 'Longer passage cut around the query.',
            Content: 'Full page text.',
            PublishTime: '2025-05-30T19:35:24+08:00',
            RankScore: 0.98,
            AuthInfoDes: '正常权威',
            AuthInfoLevel: 2,
          },
        ],
      },
    });

    const output = await executeDoubaoSearch(searchRequest());
    const result = output.result as {
      summary: string;
      items: Array<Record<string, unknown>>;
      uncertainty: string[];
    };
    expect(result).toEqual({
      summary: 'Longer passage cut around the query.',
      items: [
        {
          title: 'Example story',
          url: 'https://news.example.com/story',
          snippet: 'Longer passage cut around the query.',
          source: 'Example News',
          published_at: '2025-05-30T19:35:24+08:00',
        },
      ],
      uncertainty: [],
    });
    expect(output.meta.usage).toEqual({ resultCount: 1 });
  });

  it('falls back to Snippet when the vendor sends no Summary', async () => {
    mockFetchJson({
      Result: {
        WebResults: [{ Title: 'T', Url: 'https://e.example/1', Snippet: 'Teaser only.', SiteName: 'Site' }],
      },
    });
    const output = await executeDoubaoSearch(searchRequest());
    const items = (output.result as { items: Array<Record<string, unknown>> }).items;
    expect(items[0].snippet).toBe('Teaser only.');
    expect(items[0].published_at).toBeUndefined();
  });

  it('returns uncertainty when WebResults is empty or missing', async () => {
    for (const body of [{ Result: { WebResults: [] } }, { Result: {} }]) {
      mockFetchJson(body);
      const output = await executeDoubaoSearch(searchRequest());
      expect((output.result as { uncertainty: string[] }).uncertainty).toEqual([
        'No results found for this query.',
      ]);
      expect(output.meta.usage).toEqual({ resultCount: 0 });
    }
  });

  it.each([401, 403, 429])('classifies HTTP %i as an API-key failure', async (status) => {
    mockFetchJson({ Message: 'request rejected' }, { ok: false, status });
    await expect(executeDoubaoSearch(searchRequest())).rejects.toBeInstanceOf(ApiKeyFailureError);
  });

  it.each([10403, 700901, 700429, 10412, 10408])(
    'classifies API error code %i as an API-key failure',
    async (code) => {
      mockFetchJson({
        ResponseMetadata: { Error: { Code: String(code), Message: `failure ${code}` } },
        Result: null,
      });
      await expect(executeDoubaoSearch(searchRequest())).rejects.toBeInstanceOf(ApiKeyFailureError);
    },
  );

  it('treats a named invalid-key code as an API-key failure', async () => {
    // The live endpoint answers a bad key with a non-numeric Code, e.g.
    // {"Error":{"Code":"invalid_api_key","Message":"invalid api key"}}.
    mockFetchJson({
      ResponseMetadata: { Error: { Code: 'invalid_api_key', Message: 'invalid api key' } },
      Result: null,
    });
    await expect(executeDoubaoSearch(searchRequest())).rejects.toBeInstanceOf(ApiKeyFailureError);
  });

  it('labels a spent plan quota so the cooldown classifier can read it', async () => {
    // Code 10412 is the plan quota wall, and the vendor's own wording is often
    // Chinese. The shared classifier reads neutral English only, so the message
    // this engine builds has to carry the term itself: otherwise the engine is
    // retried on every run and pays a round trip to rediscover the wall.
    mockFetchJson({
      ResponseMetadata: { Error: { Code: '10412', Message: '搜索套餐额度不足' } },
      Result: null,
    });
    const error = await executeDoubaoSearch(searchRequest()).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(ApiKeyFailureError);
    expect((error as Error).message).toContain('(quota)');
    expect(classifyQuota(error, new Date('2026-10-17T00:00:00Z'))).not.toBe(null);
  });

  it('labels a rate limit as transient, so it is never cooled down', async () => {
    mockFetchJson({
      ResponseMetadata: { Error: { Code: '700429', Message: '请求频率超过限制' } },
      Result: null,
    });
    const error = await executeDoubaoSearch(searchRequest()).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(ApiKeyFailureError);
    expect((error as Error).message).toContain('(rate limit)');
    expect(classifyQuota(error, new Date('2026-10-17T00:00:00Z'))).toBe(null);
  });

  it('keeps HTTP 500 and API error 10500 as plain errors', async () => {
    mockFetchJson({ Message: 'temporary server error' }, { ok: false, status: 500 });
    await expect(executeDoubaoSearch(searchRequest())).rejects.toSatisfy(
      (error: unknown) => error instanceof Error && !(error instanceof ApiKeyFailureError),
    );

    mockFetchJson({
      ResponseMetadata: { Error: { Code: '10500', Message: 'internal error' } },
      Result: null,
    });
    await expect(executeDoubaoSearch(searchRequest())).rejects.toSatisfy(
      (error: unknown) => error instanceof Error && !(error instanceof ApiKeyFailureError),
    );
  });

  it('redacts every configured sibling key from a surfaced error', async () => {
    const first = 'first-doubao-secret';
    const sibling = 'sibling-doubao-secret';
    mockFetchJson(
      { Message: `${first} and ${sibling} were rejected` },
      { ok: false, status: 401 },
    );
    let error: Error | undefined;
    try {
      await executeDoubaoSearch(
        searchRequest({ apiKey: `${first}, ${sibling}` }, { apiKeySecrets: [first, sibling] }),
      );
    } catch (caught) {
      error = caught as Error;
    }

    expect(error?.message).not.toContain(first);
    expect(error?.message).not.toContain(sibling);
  });

  it('aborts on timeout and reports the engine label and timeout', async () => {
    let sawAbort = false;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => {
              sawAbort = true;
              reject(new DOMException('The operation was aborted.', 'AbortError'));
            });
          }),
      ),
    );

    await expect(
      executeDoubaoSearch(searchRequest({ apiKey: 'doubao-test-key' }, { timeoutMs: 20 })),
    ).rejects.toThrow(/doubao timed out after 20 ms/);
    expect(sawAbort).toBe(true);
  });
});
