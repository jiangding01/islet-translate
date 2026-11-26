/** Bump when the stored format or result semantics change: old records simply stop matching. */
export const CACHE_KEY_VERSION = 'v1';

export interface CacheKeyParts {
  engine: string;
  /** Normalized baseURL ('' for Google). */
  endpoint: string;
  model: string;
  source: string;
  target: string;
  promptDigest: string;
  /** '' by default; the digest of `ProviderSettings.cacheParams` when there are any (M4-A). */
  paramsDigest: string;
  text: string;
}

/** JSON with object keys sorted, so key order never changes the digest. */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Credentials are deliberately not part of the key: same endpoint and model, same result. */
export async function makeCacheKey(parts: CacheKeyParts): Promise<string> {
  return `${CACHE_KEY_VERSION}:${await sha256Hex(stableStringify(parts))}`;
}
