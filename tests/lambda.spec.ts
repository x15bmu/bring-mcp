import { createHash, randomBytes } from 'node:crypto';
import type { BringService } from '../src/bringClient.js';
import { createHandler, validateSecrets, type LambdaUrlEvent, type Secrets } from '../src/lambda.js';
import { signJwt, verifyJwt } from '../src/oauth/jwt.js';
import { isRedirectAllowed, DEFAULT_REDIRECT_ALLOWLIST } from '../src/oauth/redirects.js';

const HOST = 'abc123.lambda-url.us-east-1.on.aws';
const BASE = `https://${HOST}`;
const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';

const secrets: Secrets = {
  BRING_EMAIL: 'shared@example.com',
  BRING_PASSWORD: 'bring-password',
  AUTH_PASSPHRASE: 'correct horse battery staple',
  JWT_SECRET: 'x'.repeat(48),
};

const bringService = {
  loadLists: jest.fn(async () => ({ lists: [{ listUuid: 'l1', name: 'Home' }] })),
} as unknown as BringService;

function makeHandler() {
  const createBringService = jest.fn(() => bringService);
  const handler = createHandler({
    loadSecrets: async () => secrets,
    createBringService,
    env: {},
  });
  return { handler, createBringService };
}

function event(
  method: string,
  path: string,
  options: { query?: string; body?: string; headers?: Record<string, string> } = {},
): LambdaUrlEvent {
  return {
    rawPath: path,
    rawQueryString: options.query ?? '',
    headers: options.headers ?? {},
    body: options.body,
    isBase64Encoded: false,
    requestContext: { domainName: HOST, http: { method } },
  };
}

const form = (values: Record<string, string>) => new URLSearchParams(values).toString();
const formHeaders = { 'content-type': 'application/x-www-form-urlencoded' };

function pkce() {
  const verifier = randomBytes(48).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

async function registerClient(handler: ReturnType<typeof makeHandler>['handler'], redirect = REDIRECT) {
  const res = await handler(
    event('POST', '/register', {
      body: JSON.stringify({ redirect_uris: [redirect], client_name: 'Claude' }),
      headers: { 'content-type': 'application/json' },
    }),
  );
  return { res, body: JSON.parse(res.body) as { client_id: string } };
}

async function authorize(
  handler: ReturnType<typeof makeHandler>['handler'],
  clientId: string,
  challenge: string,
  passphrase = secrets.AUTH_PASSPHRASE,
) {
  return handler(
    event('POST', '/authorize', {
      headers: formHeaders,
      body: form({
        client_id: clientId,
        redirect_uri: REDIRECT,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        state: 'st4te',
        resource: `${BASE}/mcp`,
        passphrase,
      }),
    }),
  );
}

async function fullFlow(handler: ReturnType<typeof makeHandler>['handler']) {
  const { body } = await registerClient(handler);
  const { verifier, challenge } = pkce();
  const auth = await authorize(handler, body.client_id, challenge);
  const location = new URL(auth.headers['Location'] ?? auth.headers['location']);
  const code = location.searchParams.get('code')!;
  const tokenRes = await handler(
    event('POST', '/token', {
      headers: formHeaders,
      body: form({
        grant_type: 'authorization_code',
        code,
        client_id: body.client_id,
        redirect_uri: REDIRECT,
        code_verifier: verifier,
      }),
    }),
  );
  return { clientId: body.client_id, verifier, challenge, auth, location, tokenRes, code };
}

const rpc = (method: string, params: unknown, id = 1) => JSON.stringify({ jsonrpc: '2.0', id, method, params });
const mcpHeaders = (token: string) => ({
  authorization: `Bearer ${token}`,
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
  'mcp-protocol-version': '2025-06-18',
});

describe('discovery', () => {
  it('serves protected resource and authorization server metadata', async () => {
    const { handler } = makeHandler();
    const prm = JSON.parse((await handler(event('GET', '/.well-known/oauth-protected-resource/mcp'))).body);
    expect(prm.resource).toBe(`${BASE}/mcp`);
    expect(prm.authorization_servers).toEqual([BASE]);

    const as = JSON.parse((await handler(event('GET', '/.well-known/oauth-authorization-server'))).body);
    expect(as.issuer).toBe(BASE);
    expect(as.code_challenge_methods_supported).toEqual(['S256']);
    expect(as.authorization_response_iss_parameter_supported).toBe(true);
    expect(as.registration_endpoint).toBe(`${BASE}/register`);
  });

  it('challenges unauthenticated /mcp calls with resource metadata', async () => {
    const { handler } = makeHandler();
    const res = await handler(event('POST', '/mcp', { body: rpc('initialize', {}) }));
    expect(res.statusCode).toBe(401);
    expect(res.headers['www-authenticate']).toContain(
      `resource_metadata="${BASE}/.well-known/oauth-protected-resource/mcp"`,
    );
  });

  it('returns 404 for unknown routes', async () => {
    const { handler } = makeHandler();
    expect((await handler(event('GET', '/nope'))).statusCode).toBe(404);
  });
});

describe('registration', () => {
  it('registers an allow-listed redirect URI', async () => {
    const { handler } = makeHandler();
    const { res } = await registerClient(handler);
    expect(res.statusCode).toBe(201);
  });

  it('accepts loopback redirects on any port', async () => {
    const { handler } = makeHandler();
    const { res } = await registerClient(handler, 'http://127.0.0.1:54321/callback');
    expect(res.statusCode).toBe(201);
  });

  it('rejects redirect URIs that are not allow-listed', async () => {
    const { handler } = makeHandler();
    const { res } = await registerClient(handler, 'https://evil.example.com/cb');
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('invalid_redirect_uri');
  });
});

describe('redirect allow-list', () => {
  it.each([
    ['https://claude.ai/api/mcp/auth_callback', true],
    ['https://chatgpt.com/connector_platform_oauth_redirect', true],
    ['https://chatgpt.com/connector/oauth/abc123', true],
    ['http://localhost:8080/cb', true],
    ['http://claude.ai/api/mcp/auth_callback', false],
    ['https://claude.ai.evil.com/api/mcp/auth_callback', false],
    ['https://chatgpt.com@evil.com/connector/oauth/x', false],
    ['https://claude.ai/api/mcp/auth_callback#frag', false],
    ['javascript:alert(1)', false],
  ])('%s -> %s', (uri, expected) => {
    expect(isRedirectAllowed(uri, DEFAULT_REDIRECT_ALLOWLIST)).toBe(expected);
  });
});

describe('authorization code flow', () => {
  it('renders the passphrase page for a valid GET', async () => {
    const { handler } = makeHandler();
    const { body } = await registerClient(handler);
    const res = await handler(
      event('GET', '/authorize', {
        query: new URLSearchParams({
          response_type: 'code',
          client_id: body.client_id,
          redirect_uri: REDIRECT,
          code_challenge: pkce().challenge,
          code_challenge_method: 'S256',
          resource: `${BASE}/mcp`,
        }).toString(),
      }),
    );
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toContain('Claude');
    expect(res.body).toContain('claude.ai');
  });

  it('rejects an authorize request without S256 PKCE', async () => {
    const { handler } = makeHandler();
    const { body } = await registerClient(handler);
    const res = await handler(
      event('GET', '/authorize', {
        query: new URLSearchParams({ client_id: body.client_id, redirect_uri: REDIRECT }).toString(),
      }),
    );
    expect(res.statusCode).toBe(400);
  });

  it('rejects a redirect_uri that was not registered, without redirecting', async () => {
    const { handler } = makeHandler();
    const { body } = await registerClient(handler);
    const res = await handler(
      event('GET', '/authorize', {
        query: new URLSearchParams({
          client_id: body.client_id,
          redirect_uri: 'https://claude.com/api/mcp/auth_callback',
          code_challenge: pkce().challenge,
          code_challenge_method: 'S256',
        }).toString(),
      }),
    );
    expect(res.statusCode).toBe(400);
    expect(res.headers['location']).toBeUndefined();
  });

  it('rejects an unknown or tampered client_id', async () => {
    const { handler } = makeHandler();
    const forged = signJwt({ typ: 'client', redirect_uris: [REDIRECT] }, 'y'.repeat(48));
    const res = await authorize(handler, forged, pkce().challenge);
    expect(res.statusCode).toBe(400);
  });

  it('rejects a wrong passphrase', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
    try {
      const { handler } = makeHandler();
      const { body } = await registerClient(handler);
      const pending = authorize(handler, body.client_id, pkce().challenge, 'wrong');
      await jest.advanceTimersByTimeAsync(1500);
      const res = await pending;
      expect(res.statusCode).toBe(401);
      expect(res.headers['location']).toBeUndefined();
      expect(res.body).toContain('Incorrect passphrase');
    } finally {
      jest.useRealTimers();
    }
  });

  it('issues a code with state and iss, and exchanges it for tokens', async () => {
    const { handler } = makeHandler();
    const { auth, location, tokenRes } = await fullFlow(handler);
    expect(auth.statusCode).toBe(302);
    expect(location.origin + location.pathname).toBe(REDIRECT);
    expect(location.searchParams.get('state')).toBe('st4te');
    expect(location.searchParams.get('iss')).toBe(BASE);

    expect(tokenRes.statusCode).toBe(200);
    const tokens = JSON.parse(tokenRes.body);
    expect(tokens.token_type).toBe('Bearer');
    expect(tokens.expires_in).toBe(3600);
    const access = verifyJwt(tokens.access_token, {
      secret: secrets.JWT_SECRET,
      typ: 'access',
      issuer: BASE,
      audience: `${BASE}/mcp`,
    });
    expect(access).toBeDefined();
  });

  it('rejects a wrong PKCE verifier', async () => {
    const { handler } = makeHandler();
    const { body } = await registerClient(handler);
    const { challenge } = pkce();
    const auth = await authorize(handler, body.client_id, challenge);
    const code = new URL(auth.headers['Location'] ?? auth.headers['location']).searchParams.get('code')!;
    const res = await handler(
      event('POST', '/token', {
        headers: formHeaders,
        body: form({
          grant_type: 'authorization_code',
          code,
          client_id: body.client_id,
          redirect_uri: REDIRECT,
          code_verifier: pkce().verifier,
        }),
      }),
    );
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('invalid_grant');
  });

  it('rejects a code redeemed for a different redirect_uri', async () => {
    const { handler } = makeHandler();
    const { body } = await registerClient(handler);
    const { verifier, challenge } = pkce();
    const auth = await authorize(handler, body.client_id, challenge);
    const code = new URL(auth.headers['Location'] ?? auth.headers['location']).searchParams.get('code')!;
    const res = await handler(
      event('POST', '/token', {
        headers: formHeaders,
        body: form({
          grant_type: 'authorization_code',
          code,
          client_id: body.client_id,
          redirect_uri: 'http://localhost:1/cb',
          code_verifier: verifier,
        }),
      }),
    );
    expect(res.statusCode).toBe(400);
  });

  it('rejects an expired authorization code', async () => {
    const { handler } = makeHandler();
    const { body } = await registerClient(handler);
    const { verifier, challenge } = pkce();
    const expired = signJwt(
      { typ: 'code', cid: body.client_id, ru: REDIRECT, cc: challenge, exp: Math.floor(Date.now() / 1000) - 10 },
      secrets.JWT_SECRET,
    );
    const res = await handler(
      event('POST', '/token', {
        headers: formHeaders,
        body: form({
          grant_type: 'authorization_code',
          code: expired,
          client_id: body.client_id,
          redirect_uri: REDIRECT,
          code_verifier: verifier,
        }),
      }),
    );
    expect(res.statusCode).toBe(400);
  });

  it('refreshes tokens, and refuses an access token as a refresh token', async () => {
    const { handler } = makeHandler();
    const { tokenRes } = await fullFlow(handler);
    const tokens = JSON.parse(tokenRes.body);

    const refreshed = await handler(
      event('POST', '/token', {
        headers: formHeaders,
        body: form({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token }),
      }),
    );
    expect(refreshed.statusCode).toBe(200);
    expect(JSON.parse(refreshed.body).access_token).toBeTruthy();

    const misuse = await handler(
      event('POST', '/token', {
        headers: formHeaders,
        body: form({ grant_type: 'refresh_token', refresh_token: tokens.access_token }),
      }),
    );
    expect(misuse.statusCode).toBe(400);
  });
});

describe('token validation on /mcp', () => {
  const now = () => Math.floor(Date.now() / 1000);
  const claims = { cid: 'c', iss: BASE, aud: `${BASE}/mcp`, iat: now() };

  async function callWith(token: string) {
    const { handler } = makeHandler();
    return handler(event('POST', '/mcp', { headers: mcpHeaders(token), body: rpc('tools/list', {}) }));
  }

  it('rejects expired tokens', async () => {
    const token = signJwt({ ...claims, typ: 'access', exp: now() - 5 }, secrets.JWT_SECRET);
    expect((await callWith(token)).statusCode).toBe(401);
  });

  it('rejects tokens for another audience', async () => {
    const token = signJwt(
      { ...claims, aud: 'https://other.example.com/mcp', typ: 'access', exp: now() + 60 },
      secrets.JWT_SECRET,
    );
    expect((await callWith(token)).statusCode).toBe(401);
  });

  it('rejects tokens signed with another key', async () => {
    const token = signJwt({ ...claims, typ: 'access', exp: now() + 60 }, 'z'.repeat(48));
    expect((await callWith(token)).statusCode).toBe(401);
  });

  it('rejects refresh tokens used as access tokens', async () => {
    const token = signJwt({ ...claims, typ: 'refresh', exp: now() + 60 }, secrets.JWT_SECRET);
    expect((await callWith(token)).statusCode).toBe(401);
  });

  it('rejects alg=none tokens', async () => {
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const body = Buffer.from(JSON.stringify({ ...claims, typ: 'access', exp: now() + 60 })).toString('base64url');
    expect((await callWith(`${header}.${body}.`)).statusCode).toBe(401);
  });
});

describe('MCP over Lambda', () => {
  it('initializes and lists tools with a valid token, reusing one Bring client', async () => {
    const { handler, createBringService } = makeHandler();
    const { tokenRes } = await fullFlow(handler);
    const token = JSON.parse(tokenRes.body).access_token as string;

    const init = await handler(
      event('POST', '/mcp', {
        headers: mcpHeaders(token),
        body: rpc('initialize', {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'test', version: '1.0.0' },
        }),
      }),
    );
    expect(init.statusCode).toBe(200);
    expect(init.body).toContain('bring-mcp');

    const list = await handler(event('POST', '/mcp', { headers: mcpHeaders(token), body: rpc('tools/list', {}, 2) }));
    expect(list.statusCode).toBe(200);
    expect(list.body).toContain('loadLists');
    expect(createBringService).toHaveBeenCalledTimes(1);
    expect(createBringService).toHaveBeenCalledWith(secrets.BRING_EMAIL, secrets.BRING_PASSWORD);
  });

  it('answers GET and DELETE on /mcp with 405 when authenticated', async () => {
    const { handler } = makeHandler();
    const { tokenRes } = await fullFlow(handler);
    const token = JSON.parse(tokenRes.body).access_token as string;
    for (const method of ['GET', 'DELETE']) {
      const res = await handler(event(method, '/mcp', { headers: mcpHeaders(token) }));
      expect(res.statusCode).toBe(405);
    }
  });
});

describe('configuration', () => {
  it('validates secrets', () => {
    expect(() => validateSecrets({ ...secrets, JWT_SECRET: 'short' })).toThrow('JWT_SECRET');
    expect(() => validateSecrets({ ...secrets, AUTH_PASSPHRASE: 'short' })).toThrow('AUTH_PASSPHRASE');
    expect(() => validateSecrets({ ...secrets, BRING_EMAIL: '' })).toThrow('BRING_EMAIL');
    expect(validateSecrets(secrets)).toEqual(secrets);
  });

  it('returns a generic 500 and retries initialisation after a secrets failure', async () => {
    const loadSecrets = jest
      .fn<Promise<Secrets>, []>()
      .mockRejectedValueOnce(new Error('boom: hunter2'))
      .mockResolvedValue(secrets);
    const handler = createHandler({ loadSecrets, createBringService: () => bringService, env: {} });
    const spy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const first = await handler(event('GET', '/.well-known/oauth-authorization-server'));
    expect(first.statusCode).toBe(500);
    expect(first.body).not.toContain('hunter2');
    const second = await handler(event('GET', '/.well-known/oauth-authorization-server'));
    expect(second.statusCode).toBe(200);
    spy.mockRestore();
  });

  it('uses PUBLIC_BASE_URL as the issuer when set', async () => {
    const handler = createHandler({
      loadSecrets: async () => secrets,
      env: { PUBLIC_BASE_URL: 'https://mcp.example.com/' },
    });
    const meta = JSON.parse((await handler(event('GET', '/.well-known/oauth-authorization-server'))).body);
    expect(meta.issuer).toBe('https://mcp.example.com');
  });
});
