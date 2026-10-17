/** Parse the API-key setting shared by file and environment configuration. */
export function splitApiKeys(value: string | undefined | null): string[] {
  if (typeof value !== 'string') {
    return [];
  }
  return value
    .split(',')
    .map((key) => key.trim())
    .filter((key) => key.length > 0);
}

/** An authentication, rate-limit, or quota failure tied to the selected key. */
export class ApiKeyFailureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApiKeyFailureError';
  }
}

export function isApiKeyFailure(error: unknown): error is ApiKeyFailureError {
  return error instanceof ApiKeyFailureError;
}

const QUOTA_FAILURE_PATTERNS = [
  /\bquota\b/i,
  /\bpayment required\b/i,
  /\b(?:out of|insufficient|not enough)\s+(?:account\s+)?(?:balance|credits?)\b/i,
  /\b(?:balance|credits?)\s+(?:is\s+)?(?:insufficient|exhausted|depleted|empty|too low|used up)\b/i,
  /\b(?:credit|usage)\s+(?:limit|cap)\s+(?:reached|exceeded)\b/i,
];

/** Whether foreign response text specifically describes an exhausted quota. */
export function isQuotaFailureMessage(message: string): boolean {
  return QUOTA_FAILURE_PATTERNS.some((pattern) => pattern.test(message));
}

/**
 * The class a vendor's failure text describes, spelled in the neutral English
 * terms the shared cooldown classifier reads: `quota` parks the engine until it
 * may recover, `rate` is a per-second blip that never touches the store, and
 * null is neither.
 *
 * The Chinese-market engines answer in their own language. A spent quota the
 * classifier cannot read would never be remembered, so every run would pay a
 * round trip to rediscover the wall; an engine normalises its vendor wording
 * through this before surfacing it.
 */
export function quotaClassOf(message: string): 'quota' | 'rate' | null {
  if (isQuotaFailureMessage(message) || /额度|配额|余额|已用完|已用尽|超出套餐/.test(message)) {
    return 'quota';
  }
  if (/rate.?limit|too many requests|\b429\b|频率|过于频繁|请求过快|限流/i.test(message)) {
    return 'rate';
  }
  return null;
}
