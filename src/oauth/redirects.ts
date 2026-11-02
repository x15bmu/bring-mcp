/**
 * Redirect URI allow-list.
 *
 * Entries are either:
 * - an exact URI,
 * - a prefix ending in `*` (e.g. `https://chatgpt.com/connector/oauth/*`), or
 * - the special token `loopback`, which allows `http://localhost`, `http://127.0.0.1` and `http://[::1]`
 *   on any port and path (used by local clients such as Claude Code).
 */
export const DEFAULT_REDIRECT_ALLOWLIST: readonly string[] = [
  'https://claude.ai/api/mcp/auth_callback',
  'https://claude.com/api/mcp/auth_callback',
  'https://chatgpt.com/connector_platform_oauth_redirect',
  'https://chatgpt.com/connector/oauth/*',
  'https://*.googleusercontent.com/*',
  'https://vertexaisearch.cloud.google.com/*',
  'https://gemini.google.com/*',
  'loopback',
];

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

export function isRedirectAllowed(uri: string, allowlist: readonly string[]): boolean {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return false;
  }
  if (parsed.hash || parsed.username || parsed.password) return false;

  return allowlist.some((entry) => {
    if (entry === 'loopback') {
      return parsed.protocol === 'http:' && LOOPBACK_HOSTS.has(parsed.hostname);
    }
    if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && LOOPBACK_HOSTS.has(parsed.hostname))) {
      return false;
    }
    if (entry.includes('*')) {
      const escaped = entry.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
      return new RegExp(`^${escaped}$`).test(uri);
    }
    return uri === entry;
  });
}

export function parseRedirectAllowlist(value: string | undefined): readonly string[] {
  if (!value) return DEFAULT_REDIRECT_ALLOWLIST;
  const entries = value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return entries.length > 0 ? entries : DEFAULT_REDIRECT_ALLOWLIST;
}
