import { afterEach, describe, expect, it, vi } from 'vitest';
import { classifyQuota } from '../cooldown.ts';
import { ApiKeyFailureError } from '../util/apiKeys.ts';
import type { EngineRequest } from './index.ts';
import { baiduProvider, executeBaiduSearch } from './baidu.ts';

afterEach(() => {
  vi.restoreAllMocks();
});

/** Mock global fetch with a JSON response while capturing the request. */
function mockFetchJson(body: unknown, init: { ok?: boolean; status?: number } = {}) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fn = vi.fn(async (url: string, requestInit: RequestInit) => {
    calls.push({ url, init: requestInit });
    const status = init.status ?? 200;
    return {
      ok: init.ok ?? true,
      status,
      statusText: status === 200 ? 'OK' : status === 400 ? 'Bad Request' : status === 500 ? 'Internal Server Error' : 'Error',
      text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    } as unknown as Response;
  });
  vi.stubGlobal('fetch', fn);
  return calls;
}

function searchOptions(overrides: Partial<EngineRequest> = {}): EngineRequest {
  return {
    mode: 'search',
    query: 'Baidu search contract',
    timeoutMs: 1000,
    settings: { apiKey: 'qianfan-test-key' },
    ...overrides,
  };
}

async function rejectedError(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error('Expected the promise to reject.');
}

describe('baidu provider', () => {
  it('exposes the search provider shape', () => {
    expect(baiduProvider.name).toBe('baidu');
    expect(baiduProvider.roles).toEqual(['search']);
    expect(baiduProvider.execute).toBeTypeOf('function');
    expect(baiduProvider.isAvailable({}, { BAIDU_API_KEY: 'env-key' }, 'search')).toBe(true);
  });

  it('refuses fetch mode', async () => {
    await expect(
      executeBaiduSearch({
        mode: 'fetch',
        url: 'https://example.com',
        timeoutMs: 1000,
        settings: {},
      }),
    ).rejects.toThrow(/does not support page fetch/);
  });

  it('refuses a missing query', async () => {
    await expect(executeBaiduSearch(searchOptions({ query: undefined }))).rejects.toThrow(/requires a query/);
  });

  it('refuses an empty query', async () => {
    await expect(executeBaiduSearch(searchOptions({ query: '' }))).rejects.toThrow(/requires a query/);
  });

  it('reports an actionable error when the API key is missing', async () => {
    await expect(
      executeBaiduSearch(searchOptions({ settings: {} })),
    ).rejects.toThrow(/BAIDU_API_KEY/);
  });

  it('posts to the Qianfan endpoint with the documented headers and body', async () => {
    const calls = mockFetchJson({ references: [] });
    await executeBaiduSearch(searchOptions({ maxResults: 100 }));

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://qianfan.baidubce.com/v2/ai_search/web_search');
    expect(calls[0].init.method).toBe('POST');
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer qianfan-test-key');
    expect(headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(calls[0].init.body as string)).toEqual({
      messages: [{ role: 'user', content: 'Baidu search contract' }],
      search_source: 'baidu_search_v2',
      resource_type_filter: [{ type: 'web', top_k: 50 }],
      edition: 'standard',
    });
    expect(calls[0].init.signal).toBeInstanceOf(AbortSignal);
  });

  it('honours a configured baseURL with a trailing slash', async () => {
    const calls = mockFetchJson({ references: [] });
    await executeBaiduSearch(
      searchOptions({ settings: { apiKey: 'qianfan-test-key', baseURL: 'https://gw.example.com/baidu/' } }),
    );
    expect(calls[0].url).toBe('https://gw.example.com/baidu/v2/ai_search/web_search');
  });

  it('rejects a baseURL with an invalid scheme', async () => {
    mockFetchJson({ references: [] });
    await expect(
      executeBaiduSearch(
        searchOptions({ settings: { apiKey: 'qianfan-test-key', baseURL: 'ftp://gw.example.com' } }),
      ),
    ).rejects.toThrow(/Invalid engine baseURL/);
  });

  it('maps web references to canonical results and skips other resource types', async () => {
    mockFetchJson({
      references: [
        {
          content: 'Hebei weather snippet',
          date: '2025-04-27 18:02:00',
          title: 'Hebei weather',
          type: 'web',
          url: 'https://www.weather.com.cn/html/weather/101031600.shtml',
        },
        {
          content: 'Second snippet',
          title: 'Second result',
          type: 'web',
          url: 'https://docs.example.org/result',
        },
        {
          content: 'This is not a web result',
          title: 'Video result',
          type: 'video',
          url: 'https://video.example.org/watch',
        },
        { content: 'Missing URL', title: 'No URL', type: 'web' },
      ],
      request_id: 'request-123',
    });

    const output = await executeBaiduSearch(searchOptions());
    const result = output.result as {
      summary: string;
      items: Array<Record<string, unknown>>;
      uncertainty: string[];
    };
    expect(result).toEqual({
      summary: 'Hebei weather snippet Second snippet',
      items: [
        {
          title: 'Hebei weather',
          url: 'https://www.weather.com.cn/html/weather/101031600.shtml',
          snippet: 'Hebei weather snippet',
          source: 'www.weather.com.cn',
          published_at: '2025-04-27 18:02:00',
        },
        {
          title: 'Second result',
          url: 'https://docs.example.org/result',
          snippet: 'Second snippet',
          source: 'docs.example.org',
        },
      ],
      uncertainty: [],
    });
    expect(output.meta.usage).toEqual({ resultCount: 2 });
  });

  it('reports uncertainty when references are empty', async () => {
    mockFetchJson({ references: [] });
    const output = await executeBaiduSearch(searchOptions());
    const result = output.result as { items: unknown[]; uncertainty: string[] };
    expect(result.items).toEqual([]);
    expect(result.uncertainty.length).toBeGreaterThan(0);
  });

  it.each([401, 403, 429])('classifies HTTP %i as an API-key failure', async (status) => {
    mockFetchJson({ message: 'request rejected' }, { ok: false, status });
    const error = await rejectedError(executeBaiduSearch(searchOptions()));
    expect(error).toBeInstanceOf(ApiKeyFailureError);
  });

  it.each(['invalid authentication token', 'quota has been exceeded'])(
    'classifies a body error code with key/quota message as an API-key failure (%s)',
    async (message) => {
      mockFetchJson({ code: 1001, message }, { ok: false, status: 400 });
      const error = await rejectedError(executeBaiduSearch(searchOptions()));
      expect(error).toBeInstanceOf(ApiKeyFailureError);
    },
  );

  it('classifies an error code in a successful HTTP response by its message', async () => {
    mockFetchJson({ code: 1001, message: 'permission denied' });
    const error = await rejectedError(executeBaiduSearch(searchOptions()));
    expect(error).toBeInstanceOf(ApiKeyFailureError);
  });

  it('labels a Chinese quota code so the cooldown classifier can read it', async () => {
    // Qianfan answers in its own language. The shared classifier reads neutral
    // English only, so the message this engine builds has to carry the term
    // itself, or a spent free tier is never remembered.
    mockFetchJson({ code: 216101, message: '配额已用尽' });
    const error = await rejectedError(executeBaiduSearch(searchOptions()));
    expect(error).toBeInstanceOf(ApiKeyFailureError);
    expect(error.message).toContain('(quota)');
    expect(classifyQuota(error, new Date('2026-10-17T00:00:00Z'))).not.toBe(null);
  });

  it('labels a Chinese rate limit as transient, so it is never cooled down', async () => {
    mockFetchJson({ code: 216102, message: '请求频率超过限制' });
    const error = await rejectedError(executeBaiduSearch(searchOptions()));
    expect(error).toBeInstanceOf(ApiKeyFailureError);
    expect(error.message).toContain('(rate limit)');
    expect(classifyQuota(error, new Date('2026-10-17T00:00:00Z'))).toBe(null);
  });

  it('keeps HTTP 500 as a plain transient error', async () => {
    mockFetchJson({ code: 5001, message: 'quota is not the cause' }, { ok: false, status: 500 });
    const error = await rejectedError(executeBaiduSearch(searchOptions()));
    expect(error).toBeInstanceOf(Error);
    expect(error instanceof ApiKeyFailureError).toBe(false);
  });

  it('keeps an unrelated body error code as a plain error and includes its code and message', async () => {
    mockFetchJson({ code: 9876, message: 'invalid search parameter' }, { ok: false, status: 400 });
    const error = await rejectedError(executeBaiduSearch(searchOptions()));
    expect(error).toBeInstanceOf(Error);
    expect(error instanceof ApiKeyFailureError).toBe(false);
    expect(error.message).toContain('9876');
    expect(error.message).toContain('invalid search parameter');
  });

  it('redacts every configured sibling key from surfaced errors', async () => {
    const first = 'first-qianfan-secret';
    const second = 'second-qianfan-secret';
    mockFetchJson(
      { message: `${first} was rejected and ${second} was echoed` },
      { ok: false, status: 401 },
    );
    const error = await rejectedError(
      executeBaiduSearch(searchOptions({ settings: { apiKey: `${first}, ${second}` } })),
    );
    expect(error.message).not.toContain(first);
    expect(error.message).not.toContain(second);
  });

  it('aborts the request on timeout and reports it', async () => {
    let sawAbort = false;
    const fn = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            sawAbort = true;
            reject(new DOMException('The operation was aborted.', 'AbortError'));
          });
        }),
    );
    vi.stubGlobal('fetch', fn);

    await expect(
      executeBaiduSearch(searchOptions({ timeoutMs: 20 })),
    ).rejects.toThrow(/baidu timed out after 20 ms\./);
    expect(sawAbort).toBe(true);
  });
});
