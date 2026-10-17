import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiKeyFailureError } from '../util/apiKeys.ts';
import type { EngineRequest } from './index.ts';
import { executeZhihuSearch, zhihuProvider } from './zhihu.ts';

afterEach(() => {
  vi.restoreAllMocks();
});

/** Mock the global fetch with a JSON response, capturing the request. */
function mockFetchJson(body: unknown, init: { ok?: boolean; status?: number } = {}) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fn = vi.fn(async (url: string, requestInit: RequestInit) => {
    calls.push({ url, init: requestInit });
    return {
      ok: init.ok ?? true,
      status: init.status ?? 200,
      statusText: 'OK',
      text: async () => JSON.stringify(body),
    } as unknown as Response;
  });
  vi.stubGlobal('fetch', fn);
  return calls;
}

function request(overrides: Partial<EngineRequest> = {}): EngineRequest {
  return {
    mode: 'search',
    query: '知乎搜索',
    timeoutMs: 1000,
    settings: { apiKey: 'zhihu-test-key' },
    ...overrides,
  };
}

describe('zhihu provider', () => {
  it('exposes the search provider shape', () => {
    expect(zhihuProvider.name).toBe('zhihu');
    expect(zhihuProvider.roles).toEqual(['search']);
    expect(zhihuProvider.execute).toBeTypeOf('function');
  });

  it('rejects fetch mode', async () => {
    await expect(
      executeZhihuSearch(
        request({ mode: 'fetch', url: 'https://example.com' }),
      ),
    ).rejects.toThrow(/does not support page fetch/);
  });

  it('refuses a missing query', async () => {
    await expect(
      executeZhihuSearch({ mode: 'search', timeoutMs: 1000, settings: { apiKey: 'key' } }),
    ).rejects.toThrow(/requires a query/);
  });

  it('refuses an empty query', async () => {
    await expect(executeZhihuSearch(request({ query: '' }))).rejects.toThrow(/requires a query/);
  });

  it('gives an actionable error when no key is configured', async () => {
    await expect(
      executeZhihuSearch(request({ settings: {} })),
    ).rejects.toThrow(/ZHIHU_API_KEY/);
  });

  it('GETs the global search endpoint with encoded parameters, headers, and no body', async () => {
    const calls = mockFetchJson({ Code: 0, Message: 'success', Data: { Items: [] } });
    const query = '知乎 global search &';
    await executeZhihuSearch(request({ query, maxResults: 99 }));

    expect(calls).toHaveLength(1);
    const call = calls[0];
    const url = new URL(call.url);
    expect(url.pathname).toBe('/api/v1/content/global_search');
    expect(url.searchParams.get('Query')).toBe(query);
    expect(url.searchParams.get('Count')).toBe('20');
    expect(url.search).toContain(new URLSearchParams({ Query: query }).toString());
    expect(call.init.method).toBe('GET');
    const headers = call.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer zhihu-test-key');
    expect(headers['X-Request-Timestamp']).toMatch(/^\d+$/);
    expect(Number(headers['X-Request-Timestamp'])).toBeGreaterThan(0);
    expect(headers['Content-Type']).toBe('application/json');
    expect(call.init.body).toBeUndefined();
  });

  it('honours a configured baseURL with a trailing slash', async () => {
    const calls = mockFetchJson({ Code: 0, Data: { Items: [] } });
    await executeZhihuSearch(
      request({ settings: { apiKey: 'zhihu-test-key', baseURL: 'https://gw.example.com/zhihu/' } }),
    );
    expect(new URL(calls[0].url).origin).toBe('https://gw.example.com');
    expect(new URL(calls[0].url).pathname).toBe('/zhihu/api/v1/content/global_search');
  });

  it('rejects a baseURL with an invalid scheme', async () => {
    mockFetchJson({ Code: 0, Data: { Items: [] } });
    await expect(
      executeZhihuSearch(
        request({ settings: { apiKey: 'zhihu-test-key', baseURL: 'file:///tmp/zhihu' } }),
      ),
    ).rejects.toThrow(/Invalid engine baseURL/);
  });

  it('maps a realistic response to the canonical result shape', async () => {
    mockFetchJson({
      Code: 0,
      Message: 'success',
      Data: {
        HasMore: false,
        Items: [
          {
            Title: 'ChatGPT现在还值得开会员吗？',
            ContentType: 'Answer',
            ContentID: '1903044959663284716',
            ContentText: '摘要 <em>高亮部分</em>  和后文',
            Url: 'https://www.zhihu.com/answer/1903044959663284716',
            CommentCount: 22,
            VoteUpCount: 18,
            AuthorName: '时光纪',
            EditTime: 1748355858,
          },
        ],
      },
    });

    const output = await executeZhihuSearch(request());
    const result = output.result as {
      summary: string;
      items: Array<Record<string, unknown>>;
      uncertainty: string[];
    };
    expect(result).toEqual({
      summary: '摘要 高亮部分 和后文',
      items: [
        {
          title: 'ChatGPT现在还值得开会员吗？',
          url: 'https://www.zhihu.com/answer/1903044959663284716',
          snippet: '摘要 高亮部分 和后文',
          source: 'www.zhihu.com',
          published_at: new Date(1748355858 * 1000).toISOString(),
        },
      ],
      uncertainty: [],
    });
    expect(output.meta.usage).toEqual({ resultCount: 1 });
  });

  it('reports uncertainty when Data.Items is empty', async () => {
    mockFetchJson({ Code: 0, Message: 'success', Data: { HasMore: false, Items: [] } });
    const output = await executeZhihuSearch(request());
    const result = output.result as { uncertainty: string[] };
    expect(result.uncertainty).toEqual(['No results found for this query.']);
  });

  it.each([401, 403, 429])('classifies HTTP %i as an API-key failure', async (status) => {
    mockFetchJson({ Message: 'request rejected' }, { ok: false, status });
    await expect(executeZhihuSearch(request())).rejects.toBeInstanceOf(ApiKeyFailureError);
  });

  it('classifies a non-zero auth or quota Code as an API-key failure', async () => {
    for (const message of ['token expired', 'quota exceeded']) {
      mockFetchJson({ Code: 1001, Message: message });
      await expect(executeZhihuSearch(request())).rejects.toBeInstanceOf(ApiKeyFailureError);
    }
  });

  it('keeps HTTP 500 and unrelated non-zero Code failures as plain errors', async () => {
    mockFetchJson({ Message: 'internal server error' }, { ok: false, status: 500 });
    let httpError: unknown;
    try {
      await executeZhihuSearch(request());
    } catch (error) {
      httpError = error;
    }
    expect(httpError).toBeInstanceOf(Error);
    expect(httpError).not.toBeInstanceOf(ApiKeyFailureError);

    mockFetchJson({ Code: 1002, Message: 'invalid request shape' });
    let codeError: unknown;
    try {
      await executeZhihuSearch(request());
    } catch (error) {
      codeError = error;
    }
    expect(codeError).toBeInstanceOf(Error);
    expect(codeError).not.toBeInstanceOf(ApiKeyFailureError);
  });

  it('redacts every configured sibling key from surfaced errors', async () => {
    const first = 'alpha-plain-secret';
    const second = 'bravo-plain-secret';
    mockFetchJson({ Code: 1001, Message: `${first} and ${second}: quota exceeded` });
    let error: unknown;
    try {
      await executeZhihuSearch(
        request({ settings: { apiKey: `${first}, ${second}` } }),
      );
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ApiKeyFailureError);
    expect((error as Error).message).not.toContain(first);
    expect((error as Error).message).not.toContain(second);
  });

  it('aborts the request on timeout and reports the timeout', async () => {
    let sawAbort = false;
    const fn = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener(
            'abort',
            () => {
              sawAbort = true;
              reject(new DOMException('The operation was aborted.', 'AbortError'));
            },
            { once: true },
          );
        }),
    );
    vi.stubGlobal('fetch', fn);

    await expect(
      executeZhihuSearch(request({ timeoutMs: 20 })),
    ).rejects.toThrow(/zhihu timed out after 20 ms\./);
    expect(sawAbort).toBe(true);
  });
});
