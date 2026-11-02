import { createMcpHandler } from '@modelcontextprotocol/server';
import type { BringService } from './bringClient.js';
import type { OAuth } from './oauth/server.js';
import { createBringServer } from './server.js';

export type AppDependencies = {
  oauth: OAuth;
  /** Resolved lazily so Bring! credentials are only needed once an authenticated MCP call arrives. */
  getBringService: () => Promise<BringService>;
  version: string;
};

/**
 * Transport-agnostic web app: Web `Request` in, Web `Response` out.
 * Routes: OAuth + discovery endpoints, and `POST /mcp` (stateless Streamable HTTP, JSON responses).
 */
export function createApp(deps: AppDependencies): (request: Request) => Promise<Response> {
  const mcp = createMcpHandler(async () => createBringServer(await deps.getBringService(), deps.version), {
    legacy: 'stateless',
    responseMode: 'json',
    onerror: (error) => console.error('MCP error:', error.message),
  });

  return async (request) => {
    const oauthResponse = await deps.oauth.handle(request);
    if (oauthResponse) return oauthResponse;

    const path = new URL(request.url).pathname.replace(/\/+$/, '');
    if (path === '/mcp') {
      const denied = deps.oauth.requireAccessToken(request);
      if (denied) return denied;
      if (request.method !== 'POST') {
        // Stateless server: no SSE stream (GET) and no sessions to terminate (DELETE).
        return new Response('Method not allowed', { status: 405, headers: { Allow: 'POST' } });
      }
      return mcp.fetch(request);
    }

    return new Response('Not found', { status: 404 });
  };
}
