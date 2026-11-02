import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Minimal HS256 JWT implementation. The algorithm is pinned: tokens with any other
 * `alg` (including `none`) are rejected before the signature is even considered.
 */

export type JwtPayload = Record<string, unknown> & {
  typ: string;
  exp?: number;
  iat?: number;
  iss?: string;
  aud?: string;
};

const encode = (value: Buffer | string): string => Buffer.from(value).toString('base64url');

const hmac = (secret: string, data: string): Buffer => createHmac('sha256', secret).update(data).digest();

export function safeEqual(a: string, b: string): boolean {
  // Hash both sides so the comparison is constant-time even when lengths differ.
  const left = createHash('sha256').update(a).digest();
  const right = createHash('sha256').update(b).digest();
  return timingSafeEqual(left, right);
}

export function signJwt(payload: JwtPayload, secret: string): string {
  const header = encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = encode(JSON.stringify(payload));
  const signature = encode(hmac(secret, `${header}.${body}`));
  return `${header}.${body}.${signature}`;
}

export type VerifyOptions = {
  secret: string;
  /** Required token type (`typ` claim). */
  typ: string;
  issuer?: string;
  audience?: string;
  /** Current time in seconds; injectable for tests. */
  now?: number;
};

/** Returns the payload if the token is valid, otherwise `undefined`. Never throws. */
export function verifyJwt(token: string, options: VerifyOptions): JwtPayload | undefined {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return undefined;
    const [header, body, signature] = parts;

    const parsedHeader = JSON.parse(Buffer.from(header, 'base64url').toString('utf8')) as { alg?: unknown };
    if (parsedHeader.alg !== 'HS256') return undefined;

    const expected = encode(hmac(options.secret, `${header}.${body}`));
    if (!safeEqual(signature, expected)) return undefined;

    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as JwtPayload;
    if (payload.typ !== options.typ) return undefined;
    if (options.issuer !== undefined && payload.iss !== options.issuer) return undefined;
    if (options.audience !== undefined && payload.aud !== options.audience) return undefined;

    const now = options.now ?? Math.floor(Date.now() / 1000);
    if (payload.exp !== undefined && (typeof payload.exp !== 'number' || payload.exp <= now)) return undefined;

    return payload;
  } catch {
    return undefined;
  }
}

export function sha256Base64Url(value: string): string {
  return createHash('sha256').update(value).digest('base64url');
}
