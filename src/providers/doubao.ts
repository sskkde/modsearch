// Volcengine Doubao Search, Custom edition: POST /search_api/web_search.
// See https://docs.volcengine.com/docs/Networkedsearch/Networkedsearch-2
//
// The Custom edition is the one to talk to. It serves both billing modes —
// pay-as-you-go and subscription plan — each with its own API key, whereas the
// Global edition (/search_api/global_search) covers more of the world but
// answers a subscription-plan key with 10409, "this plan does not support this
// search type". A key bought as a package would never work there.
import { ApiKeyFailureError, quotaClassOf, splitApiKeys } from '../util/apiKeys.ts';
import { redactSecrets } from '../util/redact.ts';
import { requestText } from '../util/timedRequest.ts';
import type { EngineRequest, EngineOutput, SearchEngine } from './index.ts';
import { resolveEndpoint } from './endpoint.ts';

const DEFAULT_MAX_RESULTS = 10;
/** The Custom edition's `Count` ceiling. */
const MAX_RESULTS = 50;
const DOUBAO_DEFAULT_BASE = 'https://open.feedcoopapi.com';
const DOUBAO_PATH = '/search_api/web_search';

/**
 * The codes that make the key itself the problem, so the next sibling key
 * deserves a turn: a permission error, a search type the account cannot use, an
 * exhausted free allowance or plan quota, and the QPS ceiling.
 */
const KEY_FAILURE_CODES = new Set([
  '10403', // permission error
  '10406', // free search allowance exhausted
  '10408', // service not paid for
  '10409', // this plan does not support this search type
  '10410', // no available subscription plan
  '10412', // subscription plan quota exhausted
  '700429', // concurrent QPS ceiling
  '700901', // invalid API key (Global edition wording)
]);

/**
 * The codes whose meaning the shared classifiers need spelled out, in the
 * neutral terms they read. The vendor also answers with its own wording, which
 * for this API is often Chinese, and a message the cooldown classifier cannot
 * read would leave a spent quota unremembered: every run would pay a round trip
 * to rediscover the wall. `quota` parks the engine; `rate` stays transient.
 */
const CODE_CLASS: Record<string, 'quota' | 'rate'> = {
  '10406': 'quota', // free search allowance exhausted
  '10412': 'quota', // subscription plan quota exhausted
  '700429': 'rate', // concurrent QPS ceiling
};

interface DoubaoWebItem {
  Title?: string;
  Url?: string;
  Snippet?: string;
  Summary?: string;
  SiteName?: string;
  PublishTime?: string;
}

interface DoubaoResponse {
  ResponseMetadata?: {
    Error?: { Code?: string | number; CodeN?: string | number; Message?: string };
  };
  Result?: {
    ErrorCode?: string | number;
    ErrorMsg?: string;
    WebResults?: DoubaoWebItem[];
  } | null;
}

interface DoubaoApiError {
  code: string;
  message: string;
}

export async function executeDoubaoSearch(options: EngineRequest): Promise<EngineOutput> {
  if (options.mode === 'fetch') {
    throw new Error('The doubao engine does not support page fetch (-u). It searches only.');
  }
  if (!options.query) {
    throw new Error('Search mode requires a query.');
  }

  const apiKeys = splitApiKeys(options.settings.apiKey);
  const apiKey = apiKeys[0];
  const apiKeySecrets = [...new Set([...apiKeys, ...(options.apiKeySecrets ?? [])])];
  const secrets = [...apiKeySecrets, options.settings.baseURL];
  if (!apiKey) {
    throw new Error(
      'The doubao provider needs an API key. Set DOUBAO_API_KEY, or run: modsearch config set doubao.apiKey <key>.',
    );
  }

  let endpoint: string;
  try {
    endpoint = resolveEndpoint(options.settings.baseURL, DOUBAO_DEFAULT_BASE, DOUBAO_PATH);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(redactSecrets(message, secrets));
  }

  const count = Math.min(options.maxResults ?? DEFAULT_MAX_RESULTS, MAX_RESULTS);
  const startedAt = Date.now();
  const { response, text } = await requestText(
    'doubao',
    endpoint,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        Query: options.query,
        SearchType: 'web',
        Count: count,
        // A result with no landing page cannot become a citation, and the
        // canonical item is built around one. `NeedUrl` also drops the 火山如意
        // card results, which carry structured data but no URL.
        Filter: { NeedUrl: true },
      }),
    },
    AbortSignal.timeout(options.timeoutMs),
    options.timeoutMs,
    secrets,
  );

  if (!response.ok) {
    const detail = redactSecrets(text.trim(), secrets);
    const cls = quotaClassOf(detail);
    const message = redactSecrets(
      `doubao returned ${response.status} ${response.statusText}${classLabel(cls)}.${detail ? ` ${detail}` : ''}`,
      secrets,
    );
    // A server error is transient even if its body happens to mention a key or quota.
    if (response.status >= 500) {
      throw new Error(message);
    }
    if (response.status === 401 || response.status === 403 || response.status === 429) {
      throw new ApiKeyFailureError(message);
    }

    const bodyError = parseJsonIfPossible(text);
    const apiError = getApiError(bodyError);
    if (apiError) {
      throw createApiError(apiError, secrets);
    }
    if (cls !== null) {
      throw new ApiKeyFailureError(message);
    }
    throw new Error(message);
  }

  let data: DoubaoResponse | null;
  try {
    data = JSON.parse(text) as DoubaoResponse | null;
  } catch {
    throw new Error('doubao returned invalid JSON.');
  }

  const apiError = getApiError(data);
  if (apiError) {
    throw createApiError(apiError, secrets);
  }

  const webResults = data?.Result?.WebResults ?? [];
  const items = webResults.map((result) => {
    const item: {
      title: string;
      url: string;
      snippet: string;
      source: string | undefined;
      published_at?: string;
    } = {
      title: result.Title ?? '',
      url: result.Url ?? '',
      // The vendor documents `Summary` as the 500–1000 character passage cut
      // around the query and recommends it for model use; `Snippet` is the
      // ~200 character list-view teaser. Prefer the one meant for this.
      snippet: result.Summary?.trim() || result.Snippet?.trim() || '',
      source: result.SiteName,
    };
    const publishedAt = result.PublishTime?.trim();
    if (publishedAt) {
      item.published_at = publishedAt;
    }
    return item;
  });

  return {
    result: {
      summary: items
        .map((item) => item.snippet)
        .filter(Boolean)
        .slice(0, 3)
        .join(' '),
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

/** Spell the class in the neutral English the shared cooldown classifier reads. */
function classLabel(cls: 'quota' | 'rate' | null): string {
  if (cls === 'quota') return ' (quota)';
  if (cls === 'rate') return ' (rate limit)';
  return '';
}

function parseJsonIfPossible(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function getApiError(payload: unknown): DoubaoApiError | null {
  if (!isRecord(payload)) {
    return null;
  }

  const metadata = isRecord(payload.ResponseMetadata) ? payload.ResponseMetadata : undefined;
  const metadataError = metadata && isRecord(metadata.Error) ? metadata.Error : undefined;
  if (metadataError) {
    const rawCode = metadataError.Code ?? metadataError.CodeN;
    const code = rawCode === undefined || rawCode === null ? '' : String(rawCode);
    const message = typeof metadataError.Message === 'string' ? metadataError.Message : '';
    if (code || message) {
      return { code, message };
    }
  }

  const result = isRecord(payload.Result) ? payload.Result : undefined;
  if (result && result.ErrorCode !== undefined && result.ErrorCode !== null) {
    const code = String(result.ErrorCode);
    if (code !== '0') {
      return {
        code,
        message: typeof result.ErrorMsg === 'string' ? result.ErrorMsg : '',
      };
    }
  }
  return null;
}

function createApiError(apiError: DoubaoApiError, secrets: ReadonlyArray<string | undefined | null>): Error {
  const detail = redactSecrets(apiError.message, secrets);
  const cls = CODE_CLASS[apiError.code] ?? quotaClassOf(detail);
  const message = redactSecrets(
    `doubao returned API error${apiError.code ? ` ${apiError.code}` : ''}${classLabel(cls)}.${detail ? ` ${detail}` : ''}`,
    secrets,
  );
  if (KEY_FAILURE_CODES.has(apiError.code) || isKeyRelatedMessage(detail)) {
    return new ApiKeyFailureError(message);
  }
  return new Error(message);
}

/**
 * The endpoint does not always answer with a numeric code: a bad key comes back
 * as `{"Error":{"Code":"invalid_api_key","Message":"invalid api key"}}`. A named
 * code the table cannot know still has to rotate the sibling keys, so the
 * message decides when the code does not. `quotaClassOf` covers the vendor's own
 * Chinese wording for a spent quota or a rate limit.
 */
function isKeyRelatedMessage(message: string): boolean {
  return (
    quotaClassOf(message) !== null ||
    /invalid[ _-]?api[ _-]?key|api[ _-]?key|unauthori[sz]ed|forbidden|permission|auth(?:entication|orization)?|token|密钥|未授权|无权限/i.test(
      message,
    )
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export const doubaoProvider: SearchEngine = {
  name: 'doubao',
  roles: ['search'],
  requirement: 'set a Volcengine Doubao Search API key',
  isAvailable: (settings, env) =>
    splitApiKeys(settings.apiKey).length > 0 || splitApiKeys(env.DOUBAO_API_KEY).length > 0,
  defaultModel: 'doubao-search-custom',
  execute: executeDoubaoSearch,
};
