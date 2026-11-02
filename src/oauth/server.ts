import { isRedirectAllowed } from './redirects.js';
import { JwtPayload, safeEqual, sha256Base64Url, signJwt, verifyJwt } from './jwt.js';

export type OAuthConfig = {
  /** Public origin of the deployment, without trailing slash (e.g. `https://abc.lambda-url.us-east-1.on.aws`). */
  baseUrl: string;
  /** HS256 signing key (>= 32 chars). */
  jwtSecret: string;
  /** Passphrase the user types on the consent page. */
  passphrase: string;
  redirectAllowlist: readonly string[];
  /** Delay applied after a wrong passphrase, in ms (brute-force friction). */
  failureDelayMs?: number;
  /** Injectable clock (seconds) for tests. */
  now?: () => number;
};

export const CODE_TTL_SECONDS = 300;
export const ACCESS_TTL_SECONDS = 3600;
export const REFRESH_TTL_SECONDS = 14 * 24 * 3600;

const SECURITY_HEADERS: Record<string, string> = {
  'Cache-Control': 'no-store',
  Pragma: 'no-cache',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
};

const HTML_HEADERS: Record<string, string> = {
  ...SECURITY_HEADERS,
  'Content-Type': 'text/html; charset=utf-8',
  'Content-Security-Policy':
    "default-src 'none'; style-src 'unsafe-inline'; form-action *; frame-ancestors 'self' https://chatgpt.com https://*.chatgpt.com https://claude.ai https://*.claude.ai",
};

export function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...SECURITY_HEADERS, 'Content-Type': 'application/json', ...extra },
  });
}

function oauthError(error: string, description: string, status = 400): Response {
  return json({ error, error_description: description }, status);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function page(title: string, body: string, status = 200): Response {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(
    title,
  )}</title><style>body{font-family:system-ui,sans-serif;max-width:28rem;margin:4rem auto;padding:0 1rem}input,button{font-size:1rem;padding:.6rem;width:100%;box-sizing:border-box;margin-top:.6rem}.err{color:#b00020}code{word-break:break-all}</style></head><body>${body}</body></html>`;
  return new Response(html, { status, headers: HTML_HEADERS });
}

type AuthorizeParams = {
  clientId: string;
  clientName: string;
  redirectUri: string;
  codeChallenge: string;
  state: string;
  resource: string;
};

const AUTHORIZE_FIELDS = ['client_id', 'redirect_uri', 'code_challenge', 'state', 'resource'] as const;

export function createOAuth(config: OAuthConfig) {
  const base = config.baseUrl.replace(/\/+$/, '');
  const mcpUrl = `${base}/mcp`;
  const now = () => config.now?.() ?? Math.floor(Date.now() / 1000);
  const delay = config.failureDelayMs ?? 1000;

  const resourceMetadataUrl = `${base}/.well-known/oauth-protected-resource/mcp`;

  function unauthorized(description?: string): Response {
    const params = [`resource_metadata="${resourceMetadataUrl}"`];
    if (description) params.push(`error="invalid_token"`, `error_description="${description}"`);
    return new Response(JSON.stringify({ error: 'unauthorized' }), {
      status: 401,
      headers: {
        ...SECURITY_HEADERS,
        'Content-Type': 'application/json',
        'WWW-Authenticate': `Bearer ${params.join(', ')}`,
      },
    });
  }

  /** Returns a 401 response if the request has no valid access token, otherwise `undefined`. */
  function requireAccessToken(request: Request): Response | undefined {
    const header = request.headers.get('authorization') ?? '';
    const match = /^Bearer\s+(.+)$/i.exec(header);
    if (!match) return unauthorized();
    const payload = verifyJwt(match[1].trim(), {
      secret: config.jwtSecret,
      typ: 'access',
      issuer: base,
      audience: mcpUrl,
      now: now(),
    });
    return payload ? undefined : unauthorized('The access token is invalid or expired');
  }

  function protectedResourceMetadata(): Response {
    return json({
      resource: mcpUrl,
      authorization_servers: [base],
      bearer_methods_supported: ['header'],
    });
  }

  function authorizationServerMetadata(): Response {
    return json({
      issuer: base,
      authorization_endpoint: `${base}/authorize`,
      token_endpoint: `${base}/token`,
      registration_endpoint: `${base}/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      authorization_response_iss_parameter_supported: true,
    });
  }

  async function register(request: Request): Promise<Response> {
    let body: { redirect_uris?: unknown; client_name?: unknown };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return oauthError('invalid_client_metadata', 'Body must be JSON');
    }
    const uris = body.redirect_uris;
    if (!Array.isArray(uris) || uris.length === 0 || uris.length > 10 || !uris.every((u) => typeof u === 'string')) {
      return oauthError('invalid_redirect_uri', 'redirect_uris must be a non-empty array of strings');
    }
    const redirectUris = uris as string[];
    for (const uri of redirectUris) {
      if (uri.length > 512 || !isRedirectAllowed(uri, config.redirectAllowlist)) {
        return oauthError('invalid_redirect_uri', `Redirect URI is not allowed: ${uri.slice(0, 200)}`);
      }
    }
    const clientName =
      typeof body.client_name === 'string' && body.client_name.length > 0
        ? body.client_name.slice(0, 100)
        : 'MCP client';

    // Stateless registration: the client_id is a signed token carrying the registered metadata.
    const clientId = signJwt({ typ: 'client', redirect_uris: redirectUris, client_name: clientName }, config.jwtSecret);
    return json(
      {
        client_id: clientId,
        client_name: clientName,
        redirect_uris: redirectUris,
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      },
      201,
    );
  }

  function readClient(clientId: string): JwtPayload | undefined {
    return verifyJwt(clientId, { secret: config.jwtSecret, typ: 'client' });
  }

  /** Validates the authorization request. Returns either the params or an error page. */
  function validateAuthorize(source: URLSearchParams): { params: AuthorizeParams } | { error: Response } {
    const fail = (message: string) => ({
      error: page('Authorization error', `<h1>Authorization error</h1><p class="err">${escapeHtml(message)}</p>`, 400),
    });
    const get = (name: string) => source.get(name) ?? '';

    const client = readClient(get('client_id'));
    if (!client) return fail('Unknown client. Please re-add the connector.');

    const redirectUri = get('redirect_uri');
    const registered = (client.redirect_uris as string[] | undefined) ?? [];
    if (!registered.includes(redirectUri) || !isRedirectAllowed(redirectUri, config.redirectAllowlist)) {
      return fail('Redirect URI does not match the registered client.');
    }
    if (source.has('response_type') && get('response_type') !== 'code')
      return fail('Only response_type=code is supported.');
    if (get('code_challenge_method') !== 'S256' || !/^[A-Za-z0-9_-]{43,128}$/.test(get('code_challenge'))) {
      return fail('PKCE with code_challenge_method=S256 is required.');
    }
    const resource = get('resource');
    if (resource && resource !== mcpUrl && resource !== base) return fail('Unknown resource.');

    return {
      params: {
        clientId: get('client_id'),
        clientName: String(client.client_name ?? 'MCP client'),
        redirectUri,
        codeChallenge: get('code_challenge'),
        state: get('state'),
        resource,
      },
    };
  }

  function consentPage(params: AuthorizeParams, errorMessage?: string, status = 200): Response {
    const host = new URL(params.redirectUri).host;
    const fields: Record<(typeof AUTHORIZE_FIELDS)[number], string> = {
      client_id: params.clientId,
      redirect_uri: params.redirectUri,
      code_challenge: params.codeChallenge,
      state: params.state,
      resource: params.resource,
    };
    const hidden = AUTHORIZE_FIELDS.map(
      (field) => `<input type="hidden" name="${field}" value="${escapeHtml(fields[field])}">`,
    ).join('');
    return page(
      'Authorize Bring! MCP',
      `<h1>Authorize access</h1>
<p><strong>${escapeHtml(params.clientName)}</strong> (redirecting to <code>${escapeHtml(host)}</code>) wants to read and change your Bring! shopping lists.</p>
${errorMessage ? `<p class="err">${escapeHtml(errorMessage)}</p>` : ''}
<form method="post" action="${escapeHtml(base)}/authorize">
${hidden}
<input type="hidden" name="code_challenge_method" value="S256">
<input type="password" name="passphrase" placeholder="Passphrase" autocomplete="current-password" autofocus required>
<button type="submit">Authorize</button>
</form>`,
      status,
    );
  }

  async function authorize(request: Request, url: URL): Promise<Response> {
    if (request.method === 'GET') {
      const result = validateAuthorize(url.searchParams);
      return 'error' in result ? result.error : consentPage(result.params);
    }

    const form = new URLSearchParams(await request.text());
    const result = validateAuthorize(form);
    if ('error' in result) return result.error;

    if (!safeEqual(form.get('passphrase') ?? '', config.passphrase)) {
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
      return consentPage(result.params, 'Incorrect passphrase.', 401);
    }

    const { params } = result;
    const code = signJwt(
      {
        typ: 'code',
        cid: params.clientId,
        ru: params.redirectUri,
        cc: params.codeChallenge,
        iat: now(),
        exp: now() + CODE_TTL_SECONDS,
      },
      config.jwtSecret,
    );
    const redirect = new URL(params.redirectUri);
    redirect.searchParams.set('code', code);
    if (params.state) redirect.searchParams.set('state', params.state);
    redirect.searchParams.set('iss', base);
    return new Response(null, { status: 302, headers: { ...SECURITY_HEADERS, Location: redirect.toString() } });
  }

  function issueTokens(clientId: string): Response {
    const iat = now();
    const common = { cid: clientId, iss: base, aud: mcpUrl, iat };
    const access = signJwt({ ...common, typ: 'access', exp: iat + ACCESS_TTL_SECONDS }, config.jwtSecret);
    const refresh = signJwt({ ...common, typ: 'refresh', exp: iat + REFRESH_TTL_SECONDS }, config.jwtSecret);
    return json({ access_token: access, token_type: 'Bearer', expires_in: ACCESS_TTL_SECONDS, refresh_token: refresh });
  }

  async function token(request: Request): Promise<Response> {
    const form = new URLSearchParams(await request.text());
    const grant = form.get('grant_type');

    if (grant === 'authorization_code') {
      const payload = verifyJwt(form.get('code') ?? '', { secret: config.jwtSecret, typ: 'code', now: now() });
      if (!payload) return oauthError('invalid_grant', 'Invalid or expired authorization code');
      if (payload.cid !== form.get('client_id') || payload.ru !== form.get('redirect_uri')) {
        return oauthError('invalid_grant', 'Code was not issued to this client or redirect URI');
      }
      const verifier = form.get('code_verifier') ?? '';
      if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) || !safeEqual(sha256Base64Url(verifier), String(payload.cc))) {
        return oauthError('invalid_grant', 'PKCE verification failed');
      }
      return issueTokens(String(payload.cid));
    }

    if (grant === 'refresh_token') {
      const payload = verifyJwt(form.get('refresh_token') ?? '', {
        secret: config.jwtSecret,
        typ: 'refresh',
        issuer: base,
        audience: mcpUrl,
        now: now(),
      });
      if (!payload) return oauthError('invalid_grant', 'Invalid or expired refresh token');
      const clientId = form.get('client_id');
      if (clientId && clientId !== payload.cid)
        return oauthError('invalid_grant', 'Refresh token belongs to another client');
      return issueTokens(String(payload.cid));
    }

    return oauthError('unsupported_grant_type', 'Supported grants: authorization_code, refresh_token');
  }

  /** Handles OAuth and discovery routes. Returns `undefined` for routes it does not own. */
  async function handle(request: Request): Promise<Response | undefined> {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const method = request.method;

    if ((method === 'GET' || method === 'HEAD') && path.startsWith('/.well-known/oauth-protected-resource')) {
      return protectedResourceMetadata();
    }
    if ((method === 'GET' || method === 'HEAD') && path.startsWith('/.well-known/oauth-authorization-server')) {
      return authorizationServerMetadata();
    }
    if (path === '/register' && method === 'POST') return register(request);
    if (path === '/authorize' && (method === 'GET' || method === 'POST')) return authorize(request, url);
    if (path === '/token' && method === 'POST') return token(request);
    if (['/register', '/authorize', '/token'].includes(path)) {
      return new Response('Method not allowed', { status: 405, headers: SECURITY_HEADERS });
    }
    return undefined;
  }

  return { handle, requireAccessToken, mcpUrl };
}

export type OAuth = ReturnType<typeof createOAuth>;
