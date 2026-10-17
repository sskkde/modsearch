// Zhihu Data Open Platform global search API, search mode only.
// https://developer.zhihu.com/docs?key=global_search
import { ApiKeyFailureError, isQuotaFailureMessage, splitApiKeys } from '../util/apiKeys.ts';
import { redactSecrets } from '../util/redact.ts';
import { requestText } from '../util/timedRequest.ts';
import type { EngineRequest, EngineOutput, SearchEngine } from './index.ts';
import { resolveEndpoint } from './endpoint.ts';

const ZHIHU_DEFAULT_BASE = 'https://developer.zhihu.com';
const DEFAULT_MAX_RESULTS = 10;
const MAX_RESULTS = 20;

interface ZhihuItem {
  Title?: string;
  ContentType?: string;
  ContentID?: string;
  ContentText?: string;
  Url?: string;
  EditTime?: number;
  AuthorName?: string;
}

interface ZhihuResponse {
  Code?: number;
  Message?: string;
  Data?: {
    HasMore?: boolean;
    Items?: ZhihuItem[];
  };
}

export async function executeZhihuSearch(options: EngineRequest): Promise<EngineOutput> {
  if (options.mode === 'fetch') {
    throw new Error('The zhihu engine does not support page fetch (-u). It searches only.');
  }
  if (!options.query) {
    throw new Error('Search mode requires a query.');
  }

  const apiKeys = splitApiKeys(options.settings.apiKey);
  const apiKey = apiKeys[0];
  const secrets = [...new Set([...apiKeys, ...(options.apiKeySecrets ?? []), options.settings.baseURL])];
  if (!apiKey) {
    throw new Error(
      'The zhihu provider needs an API key. Set ZHIHU_API_KEY, or run: modsearch config set zhihu.apiKey <key>.',
    );
  }

  const maxResults = Math.min(MAX_RESULTS, Math.max(1, Math.floor(options.maxResults ?? DEFAULT_MAX_RESULTS)));
  let endpoint: URL;
  try {
    endpoint = new URL(
      resolveEndpoint(options.settings.baseURL, ZHIHU_DEFAULT_BASE, '/api/v1/content/global_search'),
    );
  } catch (error) {
    throw new Error(redactSecrets(error instanceof Error ? error.message : String(error), secrets));
  }
  endpoint.searchParams.set('Query', options.query);
  endpoint.searchParams.set('Count', String(maxResults));

  const startedAt = Date.now();
  const { response, text } = await requestText(
    'zhihu',
    endpoint.toString(),
    {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'X-Request-Timestamp': String(Math.floor(Date.now() / 1000)),
        'Content-Type': 'application/json',
      },
    },
    AbortSignal.timeout(options.timeoutMs),
    options.timeoutMs,
    secrets,
  );

  if (!response.ok) {
    const detail = redactSecrets(text.trim(), secrets);
    const message = redactSecrets(
      `zhihu returned ${response.status} ${response.statusText}.${detail ? ` ${detail}` : ''}`,
      secrets,
    );
    // A server-side failure is transient, even if an error page mentions a key.
    if (response.status >= 500) {
      throw new Error(message);
    }
    if (
      response.status === 401 ||
      response.status === 403 ||
      response.status === 429 ||
      isKeyRelatedMessage(detail)
    ) {
      throw new ApiKeyFailureError(message);
    }
    throw new Error(message);
  }

  let data: ZhihuResponse;
  try {
    data = JSON.parse(text) as ZhihuResponse;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(redactSecrets(`zhihu returned invalid JSON: ${detail}`, secrets));
  }

  if (typeof data.Code === 'number' && data.Code !== 0) {
    const detail = data.Message ?? 'Unknown error';
    const message = redactSecrets(`zhihu returned Code ${data.Code}: ${detail}`, secrets);
    if (isKeyRelatedMessage(detail)) {
      throw new ApiKeyFailureError(message);
    }
    throw new Error(message);
  }

  const items = (data.Data?.Items ?? []).map((item) => ({
    title: item.Title ?? '',
    url: item.Url ?? '',
    snippet: cleanSnippet(item.ContentText ?? ''),
    // `source` is the result URL's hostname (for example, www.zhihu.com).
    source: item.Url ? safeHostname(item.Url) : undefined,
    published_at: toIsoTimestamp(item.EditTime),
  }));
  const snippets = items.map((item) => item.snippet).filter(Boolean);

  return {
    result: {
      summary: snippets.join(' '),
      items,
      uncertainty: items.length === 0 ? ['No results found for this query.'] : [],
    },
    meta: {
      conversationId: null,
      durationSeconds: (Date.now() - startedAt) / 1000,
      usage: { resultCount: items.length },
    },
  };
}

function cleanSnippet(value: string): string {
  return value.replace(/<\/?em>/gi, '').replace(/\s+/g, ' ').trim();
}

function safeHostname(url: string): string | undefined {
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

function toIsoTimestamp(value: number | undefined): string | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  try {
    return new Date(value * 1000).toISOString();
  } catch {
    return undefined;
  }
}

function isKeyRelatedMessage(message: string): boolean {
  return (
    isQuotaFailureMessage(message) ||
    /\b(?:rate|limit|auth(?:entication|orization)?|permission|token|forbidden|unauthori[sz]ed)\b/i.test(
      message,
    )
  );
}

export const zhihuProvider: SearchEngine = {
  name: 'zhihu',
  roles: ['search'],
  requirement: 'set a Zhihu Data Open Platform API key (ZHIHU_API_KEY)',
  isAvailable: (settings, env) =>
    splitApiKeys(settings.apiKey).length > 0 || splitApiKeys(env.ZHIHU_API_KEY).length > 0,
  defaultModel: 'zhihu-global-search',
  execute: executeZhihuSearch,
};
