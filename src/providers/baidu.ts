// Baidu Qianfan AI Search web_search API: POST https://qianfan.baidubce.com/v2/ai_search/web_search
// https://cloud.baidu.com/doc/qianfan-api/s/Wmbq4z7e5
import { ApiKeyFailureError, quotaClassOf, splitApiKeys } from '../util/apiKeys.ts';
import { redactSecrets } from '../util/redact.ts';
import { requestText } from '../util/timedRequest.ts';
import type { EngineRequest, EngineOutput, SearchEngine } from './index.ts';
import { resolveEndpoint } from './endpoint.ts';

const DEFAULT_MAX_RESULTS = 10;
const MAX_WEB_TOP_K = 50;
const BAIDU_DEFAULT_BASE = 'https://qianfan.baidubce.com';
const SEARCH_PATH = '/v2/ai_search/web_search';

interface BaiduReference {
  content?: string;
  date?: string;
  title?: string;
  type?: string;
  url?: string;
}

interface BaiduResponse {
  references?: BaiduReference[] | null;
  request_id?: string;
  code?: unknown;
  message?: unknown;
}

export async function executeBaiduSearch(options: EngineRequest): Promise<EngineOutput> {
  if (options.mode === 'fetch') {
    throw new Error('The baidu engine does not support page fetch (-u). It searches only.');
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
      'The baidu provider needs an API key. Set BAIDU_API_KEY, or run: modsearch config set baidu.apiKey <key>.',
    );
  }

  const maxResults = Math.min(options.maxResults ?? DEFAULT_MAX_RESULTS, MAX_WEB_TOP_K);
  const startedAt = Date.now();
  let endpoint: string;
  try {
    endpoint = resolveEndpoint(options.settings.baseURL, BAIDU_DEFAULT_BASE, SEARCH_PATH);
  } catch (error) {
    throw new Error(redactSecrets(error instanceof Error ? error.message : String(error), secrets));
  }

  const { response, text } = await requestText(
    'baidu',
    endpoint,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messages: [{ role: 'user', content: options.query }],
        search_source: 'baidu_search_v2',
        resource_type_filter: [{ type: 'web', top_k: maxResults }],
        edition: 'standard',
      }),
    },
    AbortSignal.timeout(options.timeoutMs),
    options.timeoutMs,
    [...apiKeySecrets, options.settings.baseURL],
  );

  if (!response.ok) {
    const detail = redactSecrets(text.trim(), secrets);
    const cls = quotaClassOf(detail);
    const statusMessage = redactSecrets(
      `baidu returned ${response.status} ${response.statusText}${classLabel(cls)}.${detail ? ` ${detail}` : ''}`,
      secrets,
    );

    // HTTP server failures are transient and never indicate that the key is bad.
    if (response.status >= 500) {
      throw new Error(statusMessage);
    }
    if (response.status === 401 || response.status === 403 || response.status === 429) {
      throw new ApiKeyFailureError(statusMessage);
    }

    const bodyError = parseErrorBody(text);
    if (bodyError?.code) {
      throw codeFailure(bodyError.code, bodyError.message, secrets);
    }
    if (cls !== null) {
      throw new ApiKeyFailureError(statusMessage);
    }
    throw new Error(statusMessage);
  }

  let data: BaiduResponse;
  try {
    data = JSON.parse(text) as BaiduResponse;
  } catch (error) {
    const detail = redactSecrets(error instanceof Error ? error.message : String(error), secrets);
    throw new Error(`baidu returned invalid JSON.${detail ? ` ${detail}` : ''}`);
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('baidu returned an invalid JSON response.');
  }
  if (data.code) {
    throw codeFailure(data.code, data.message, secrets);
  }

  const references = Array.isArray(data.references) ? data.references : [];
  const items = references
    .filter((reference) => reference.type === 'web' && typeof reference.url === 'string' && reference.url.length > 0)
    .map((reference) => ({
      title: reference.title ?? '',
      url: reference.url!,
      snippet: reference.content ?? '',
      source: safeHostname(reference.url!),
      // Preserve Baidu's YYYY-MM-DD HH:mm:ss date string verbatim.
      ...(reference.date?.trim() ? { published_at: reference.date } : {}),
    }));

  const result = {
    summary: items
      .map((item) => item.snippet)
      .filter(Boolean)
      .join(' '),
    items,
    uncertainty: items.length === 0 ? ['No results found for this query.'] : [],
  };

  return {
    result,
    meta: {
      conversationId: null,
      durationSeconds: (Date.now() - startedAt) / 1000,
      usage: { resultCount: items.length },
    },
  };
}

function parseErrorBody(text: string): { code?: unknown; message?: unknown } | undefined {
  try {
    const body = JSON.parse(text) as { code?: unknown; message?: unknown } | null;
    return body && typeof body === 'object' && !Array.isArray(body) ? body : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Spell the class in the neutral English the shared cooldown classifier reads.
 * Qianfan answers in its own wording, often Chinese, and a spent free tier the
 * classifier cannot read would leave the engine cooling for nothing.
 */
function classLabel(cls: 'quota' | 'rate' | null): string {
  if (cls === 'quota') return ' (quota)';
  if (cls === 'rate') return ' (rate limit)';
  return '';
}

function codeFailure(code: unknown, message: unknown, secrets: ReadonlyArray<string | undefined>): Error {
  const messageText = typeof message === 'string' ? message : message == null ? '' : String(message);
  const cls = quotaClassOf(messageText);
  const description = `baidu returned error code ${String(code)}${classLabel(cls)}${messageText ? `: ${messageText}` : ''}.`;
  const safeDescription = redactSecrets(description, secrets);
  if (
    cls !== null ||
    /quota|limit|rate|auth|permission|token|forbidden|密钥|未授权|无权限/i.test(messageText)
  ) {
    return new ApiKeyFailureError(safeDescription);
  }
  return new Error(safeDescription);
}

function safeHostname(url: string): string | undefined {
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

export const baiduProvider: SearchEngine = {
  name: 'baidu',
  roles: ['search'],
  requirement: 'set a Baidu Qianfan API key (BAIDU_API_KEY)',
  isAvailable: (settings, env) =>
    splitApiKeys(settings.apiKey).length > 0 || splitApiKeys(env.BAIDU_API_KEY).length > 0,
  defaultModel: 'baidu-search-standard',
  execute: executeBaiduSearch,
};
