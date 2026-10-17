// Volcengine Doubao Search Global edition: POST /search_api/global_search.
// See https://docs.volcengine.com/docs/Networkedsearch/doubao-search-global-edition
import { ApiKeyFailureError, isQuotaFailureMessage, splitApiKeys } from '../util/apiKeys.ts';
import { redactSecrets } from '../util/redact.ts';
import { requestText } from '../util/timedRequest.ts';
import type { EngineRequest, EngineOutput, SearchEngine } from './index.ts';
import { resolveEndpoint } from './endpoint.ts';

const DEFAULT_MAX_RESULTS = 10;
const MAX_RESULTS = 20;
const DOUBAO_DEFAULT_BASE = 'https://open.feedcoopapi.com';
const DOUBAO_PATH = '/search_api/global_search';
const KEY_FAILURE_CODES = new Set(['10403', '10408', '10410', '10412', '700429', '700901']);

interface DoubaoSnippet {
  Type?: string;
  Text?: string;
}

interface DoubaoDocument {
  Url?: string;
  Title?: string;
  Snippet?: DoubaoSnippet[];
  DocumentInfo?: { PublishTime?: string };
  HostInfo?: { Hostname?: string };
}

interface DoubaoResponse {
  ResponseMetadata?: {
    Error?: { Code?: string | number; CodeN?: string | number; Message?: string };
  };
  Result?: {
    ErrorCode?: string | number;
    ErrorMsg?: string;
    Documents?: DoubaoDocument[];
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

  const docCount = Math.min(options.maxResults ?? DEFAULT_MAX_RESULTS, MAX_RESULTS);
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
        DocCount: docCount,
        MaxSnippetLength: 500,
      }),
    },
    AbortSignal.timeout(options.timeoutMs),
    options.timeoutMs,
    secrets,
  );

  if (!response.ok) {
    const detail = redactSecrets(text.trim(), secrets);
    const message = redactSecrets(
      `doubao returned ${response.status} ${response.statusText}.${detail ? ` ${detail}` : ''}`,
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
    if (isQuotaFailureMessage(detail)) {
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

  const documents = data?.Result?.Documents ?? [];
  const items = documents.map((document) => {
    const snippet = (document.Snippet ?? [])
      .filter((part) => part.Type === 'text' && typeof part.Text === 'string')
      .map((part) => part.Text as string)
      .join('\n');
    const item: {
      title: string;
      url: string;
      snippet: string;
      source: string | undefined;
      published_at?: string;
    } = {
      title: document.Title ?? '',
      url: document.Url ?? '',
      snippet,
      source: document.HostInfo?.Hostname,
    };
    const publishedAt = document.DocumentInfo?.PublishTime;
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
  const message = redactSecrets(
    `doubao returned API error${apiError.code ? ` ${apiError.code}` : ''}.${detail ? ` ${detail}` : ''}`,
    secrets,
  );
  if (KEY_FAILURE_CODES.has(apiError.code) || isKeyRelatedMessage(detail)) {
    return new ApiKeyFailureError(message);
  }
  return new Error(message);
}

/**
 * The live endpoint does not always answer with a numeric code: a bad key comes
 * back as `{"Error":{"Code":"invalid_api_key","Message":"invalid api key"}}`.
 * A named code the table cannot know still has to rotate the sibling keys, so
 * the message decides when the code does not.
 */
function isKeyRelatedMessage(message: string): boolean {
  return (
    isQuotaFailureMessage(message) ||
    /invalid[ _-]?api[ _-]?key|api[ _-]?key|unauthori[sz]ed|forbidden|permission|auth(?:entication|orization)?|rate[ _-]?limit|quota|token/i.test(
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
  requirement: 'set a Volcengine Doubao Search Global API key',
  isAvailable: (settings, env) =>
    splitApiKeys(settings.apiKey).length > 0 || splitApiKeys(env.DOUBAO_API_KEY).length > 0,
  defaultModel: 'doubao-search-global',
  execute: executeDoubaoSearch,
};
