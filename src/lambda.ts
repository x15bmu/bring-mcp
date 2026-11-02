import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { createApp } from './app.js';
import { BringClient, type BringService } from './bringClient.js';
import { createOAuth } from './oauth/server.js';
import { parseRedirectAllowlist } from './oauth/redirects.js';

/** Replaced at bundle time by scripts/build-lambda.js (esbuild `define`). */
const BUILD_VERSION: string | undefined = process.env.BRING_MCP_VERSION;

/** Minimal shape of an API Gateway HTTP API v2 / Lambda Function URL event. */
export type LambdaUrlEvent = {
  rawPath: string;
  rawQueryString?: string;
  headers: Record<string, string | undefined>;
  body?: string;
  isBase64Encoded?: boolean;
  requestContext: { domainName: string; http: { method: string } };
};

export type LambdaUrlResult = {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
  cookies?: string[];
};

export type Secrets = {
  BRING_EMAIL: string;
  BRING_PASSWORD: string;
  AUTH_PASSPHRASE: string;
  JWT_SECRET: string;
};

export type LambdaDependencies = {
  loadSecrets: () => Promise<Secrets>;
  createBringService?: (email: string, password: string) => BringService;
  env?: NodeJS.ProcessEnv;
};

export function validateSecrets(value: Partial<Secrets>): Secrets {
  for (const key of ['BRING_EMAIL', 'BRING_PASSWORD', 'AUTH_PASSPHRASE', 'JWT_SECRET'] as const) {
    if (!value[key]) throw new Error(`Secret is missing required key ${key}`);
  }
  if (value.JWT_SECRET!.length < 32) throw new Error('JWT_SECRET must be at least 32 characters');
  if (value.AUTH_PASSPHRASE!.length < 12) throw new Error('AUTH_PASSPHRASE must be at least 12 characters');
  return value as Secrets;
}

export async function loadSecretsFromSecretsManager(secretId: string | undefined): Promise<Secrets> {
  if (!secretId) throw new Error('SECRET_ID environment variable is not set');
  const client = new SecretsManagerClient({});
  const result = await client.send(new GetSecretValueCommand({ SecretId: secretId }));
  if (!result.SecretString) throw new Error('Secret has no SecretString');
  return validateSecrets(JSON.parse(result.SecretString) as Partial<Secrets>);
}

export function eventToRequest(event: LambdaUrlEvent, baseUrl: string): Request {
  const method = event.requestContext.http.method.toUpperCase();
  const query = event.rawQueryString ? `?${event.rawQueryString}` : '';
  const headers = new Headers();
  for (const [name, value] of Object.entries(event.headers ?? {})) {
    if (value !== undefined) headers.set(name, value);
  }
  let body: string | undefined;
  if (event.body && method !== 'GET' && method !== 'HEAD') {
    body = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
  }
  return new Request(`${baseUrl}${event.rawPath}${query}`, { method, headers, body });
}

export function createHandler(deps: LambdaDependencies) {
  const env = deps.env ?? process.env;
  let appPromise: Promise<(request: Request) => Promise<Response>> | undefined;
  let bringService: BringService | undefined;

  function getApp(event: LambdaUrlEvent): Promise<(request: Request) => Promise<Response>> {
    // Cached across warm invocations. A failed init is not cached, so the next invocation retries.
    appPromise ??= (async () => {
      const secrets = await deps.loadSecrets();
      const baseUrl = (env.PUBLIC_BASE_URL || `https://${event.requestContext.domainName}`).replace(/\/+$/, '');
      const oauth = createOAuth({
        baseUrl,
        jwtSecret: secrets.JWT_SECRET,
        passphrase: secrets.AUTH_PASSPHRASE,
        redirectAllowlist: parseRedirectAllowlist(env.REDIRECT_URI_ALLOWLIST),
      });
      const factory = deps.createBringService ?? ((email, password) => new BringClient(email, password));
      return createApp({
        oauth,
        version: BUILD_VERSION ?? '0.0.0-lambda',
        // One BringClient per container so the Bring! login token survives warm invocations.
        getBringService: async () => (bringService ??= factory(secrets.BRING_EMAIL, secrets.BRING_PASSWORD)),
      });
    })().catch((error) => {
      appPromise = undefined;
      throw error;
    });
    return appPromise;
  }

  return async (event: LambdaUrlEvent): Promise<LambdaUrlResult> => {
    try {
      const app = await getApp(event);
      const baseUrl = (env.PUBLIC_BASE_URL || `https://${event.requestContext.domainName}`).replace(/\/+$/, '');
      const response = await app(eventToRequest(event, baseUrl));
      const headers: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        // Normalize location header to title-case Location so Lambda Function URLs recognize redirects
        if (key.toLowerCase() === 'location') {
          headers['Location'] = value;
        } else {
          headers[key] = value;
        }
      });
      return { statusCode: response.status, headers, body: await response.text() };
    } catch (error) {
      // Never leak internals (or secrets) to the caller.
      console.error('Unhandled error:', error instanceof Error ? error.message : 'unknown');
      return {
        statusCode: 500,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'internal_error' }),
      };
    }
  };
}

export const handler = createHandler({
  loadSecrets: () => loadSecretsFromSecretsManager(process.env.SECRET_ID),
});
