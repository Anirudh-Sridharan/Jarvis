/**
 * Loopback OAuth consent flow runtime (architecture/auth-and-integrations.md §3).
 *
 * Protocol logic (PKCE, URL building, callback parsing, code exchange) lives in
 * @jarvis/integrations/authFlow; this module owns the runtime plumbing only:
 * the one-shot 127.0.0.1 HTTP listener, opening the system browser, and token
 * persistence.
 *
 * The listener port is FIXED (default 8976, override JARVIS_OAUTH_PORT) — not
 * random — because Whoop requires the redirect URI to exactly match the one
 * registered in its developer portal. Register:
 *   http://127.0.0.1:8976/callback
 * (Google desktop clients accept any loopback port, so the fixed port is fine
 * there too.)
 */

import { createServer } from "node:http";
import { execFile } from "node:child_process";
import {
  buildAuthorizeUrl,
  exchangeCodeForTokens,
  generatePkce,
  generateState,
  getOAuthProvider,
  parseCallbackUrl,
  requireClientCredentials,
  type HttpClient,
  type OAuthSourceId,
  type OAuthTokens,
  type TokenStore,
} from "@jarvis/integrations";

export const DEFAULT_OAUTH_PORT = 8976;
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

export interface ConsentFlowDeps {
  http: HttpClient;
  tokenStore: TokenStore;
  /** Open the consent URL in a browser. Defaults to macOS `open`. */
  openBrowser?: (url: string) => void;
  port?: number;
  timeoutMs?: number;
  log?: (line: string) => void;
}

export function oauthPort(): number {
  const env = process.env["JARVIS_OAUTH_PORT"];
  return env ? Number(env) : DEFAULT_OAUTH_PORT;
}

function defaultOpenBrowser(url: string): void {
  if (process.platform === "darwin") {
    execFile("open", [url], () => {
      /* best-effort; the URL is printed regardless */
    });
  }
}

/**
 * Run the full consent flow for one source: listener → browser → callback →
 * code exchange → TokenStore persist. Resolves with the persisted tokens.
 */
export async function runConsentFlow(
  source: OAuthSourceId,
  deps: ConsentFlowDeps,
): Promise<OAuthTokens> {
  const provider = getOAuthProvider(source);
  const creds = requireClientCredentials(provider);
  const log = deps.log ?? console.log;
  const port = deps.port ?? oauthPort();
  const redirectUri = `http://127.0.0.1:${port}/callback`;

  const state = generateState();
  const pkce = provider.pkce ? generatePkce() : undefined;

  const authorizeUrl = buildAuthorizeUrl(provider, creds, {
    redirectUri,
    state,
    codeChallenge: pkce?.challenge,
  });

  // Listener must be up before the browser opens.
  const codePromise = waitForCallback(port, state, deps.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  log(`\nAuthorizing ${provider.displayName}…`);
  log(`If the browser doesn't open, visit:\n\n  ${authorizeUrl}\n`);
  (deps.openBrowser ?? defaultOpenBrowser)(authorizeUrl);

  const code = await codePromise;
  log("Consent received — exchanging code for tokens…");

  const tokens = await exchangeCodeForTokens(
    provider,
    creds,
    { code, redirectUri, codeVerifier: pkce?.verifier },
    deps.http,
  );

  // Persist BEFORE returning: for Whoop the refresh token is single-use, so
  // nothing may use these tokens until they're safely in the Keychain.
  await deps.tokenStore.set(source, tokens);
  log(`${provider.displayName} connected. Tokens stored in the Keychain.`);
  return tokens;
}

/** One-shot loopback listener: resolves with the authorization code. */
function waitForCallback(
  port: number,
  expectedState: string,
  timeoutMs: number,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = req.url ?? "/";
      if (!url.startsWith("/callback")) {
        res.writeHead(404).end();
        return;
      }

      try {
        const { code } = parseCallbackUrl(url, expectedState);
        res
          .writeHead(200, { "Content-Type": "text/html", Connection: "close" })
          .end("<html><body><h2>Jarvis is connected.</h2>You can close this tab.</body></html>");
        finish(() => resolve(code));
      } catch (err) {
        res
          .writeHead(400, { "Content-Type": "text/html", Connection: "close" })
          .end("<html><body><h2>Authorization failed.</h2>Check the terminal.</body></html>");
        // Only a provider error carrying the CORRECT state terminates the flow
        // early. Any other failed parse (port scan, browser prefetch, state
        // mismatch) is a stray hit — keep listening for the real callback;
        // the timeout still bounds the wait.
        const params = new URL(url, "http://127.0.0.1").searchParams;
        const isProviderError =
          params.get("error") !== null && params.get("state") === expectedState;
        if (isProviderError) {
          finish(() => reject(err));
        }
      }
    });

    const timer = setTimeout(() => {
      finish(() => reject(new Error(`Timed out after ${Math.round(timeoutMs / 1000)}s waiting for OAuth consent.`)));
    }, timeoutMs);

    function finish(settle: () => void): void {
      clearTimeout(timer);
      // One-shot server: also drop kept-alive sockets, or the port lingers and
      // a reused client connection could reach this dead listener later.
      server.close();
      server.closeAllConnections();
      settle();
    }

    server.once("error", (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (err.code === "EADDRINUSE") {
        reject(
          new Error(
            `Port ${port} is already in use. Stop the other process or set JARVIS_OAUTH_PORT ` +
              `(remember: the redirect URI registered with the provider must use the same port).`,
          ),
        );
      } else {
        reject(err);
      }
    });

    server.listen(port, "127.0.0.1");
  });
}
