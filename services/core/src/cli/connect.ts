/**
 * Connector CLI (features 9/10/12/13): authorize and sync live data sources.
 *
 *   npm run connect -- whoop            # OAuth consent → tokens in Keychain
 *   npm run connect -- gcal
 *   npm run connect -- gmail
 *   npm run connect -- status           # token + last-sync state per source
 *   npm run connect -- sync whoop       # run one manual sync now
 *   npm run connect -- disconnect gmail # remove tokens from Keychain
 *
 * Prereqs: provider client credentials in .env (WHOOP_CLIENT_ID/_SECRET,
 * GCAL_CLIENT_ID/_SECRET, GMAIL_CLIENT_ID/_SECRET) — see
 * architecture/auth-and-integrations.md §7 for the per-provider setup, and
 * register http://127.0.0.1:8976/callback as the redirect URI.
 */
import "../loadEnv.js"; // MUST be first: populates process.env from .env

import {
  getOAuthProvider,
  isOAuthSource,
  type OAuthSourceId,
  type SyncRun,
} from "@jarvis/integrations";
import { createLiveIntegrations } from "../integrations/liveIntegrations.js";
import { runConsentFlow, oauthPort } from "../integrations/consentFlow.js";
import { KeychainTokenStore } from "../integrations/keychainTokenStore.js";

const OAUTH_SOURCES: OAuthSourceId[] = ["whoop", "gcal", "gmail"];

function usage(): never {
  console.log(
    [
      "Usage: npm run connect -- <command>",
      "",
      "  whoop | gcal | gmail     authorize a source (loopback OAuth consent)",
      "  status                   show token + last-sync state for all sources",
      "  sync <source>            run one manual sync for a source",
      "  disconnect <source>      remove a source's tokens from the Keychain",
      "",
      `OAuth redirect: http://127.0.0.1:${oauthPort()}/callback (set JARVIS_OAUTH_PORT to change)`,
    ].join("\n"),
  );
  process.exit(1);
}

function requireOAuthSource(arg: string | undefined): OAuthSourceId {
  if (!arg || !isOAuthSource(arg)) {
    console.error(`Expected one of: ${OAUTH_SOURCES.join(", ")} — got "${arg ?? ""}"`);
    process.exit(1);
  }
  return arg;
}

async function login(source: OAuthSourceId): Promise<void> {
  const { http, tokenStore } = createLiveIntegrations();
  await runConsentFlow(source, { http, tokenStore });

  if (source === "whoop") {
    console.log(
      "\nTip: Whoop uses rotating refresh tokens — if you ever see " +
        '"Re-consent required", just run this command again.',
    );
  }
  console.log(`\nNext: npm run connect -- sync ${source}`);
}

async function status(): Promise<void> {
  const { system, tokenStore } = createLiveIntegrations();

  console.log("Source  Tokens             Last sync");
  console.log("─".repeat(64));
  for (const source of OAUTH_SOURCES) {
    const provider = getOAuthProvider(source);
    const tokens = await tokenStore.get(source);

    let tokenState: string;
    if (!tokens) {
      tokenState = "not connected";
    } else if (tokens.expiresAt && tokens.expiresAt < Date.now()) {
      tokenState = tokens.refreshToken ? "expired (refreshable)" : "expired (re-consent)";
    } else {
      const mins = tokens.expiresAt
        ? Math.round((tokens.expiresAt - Date.now()) / 60_000)
        : null;
      tokenState = mins != null ? `ok (expires in ${mins}m)` : "ok";
    }

    const [last] = system.scheduler.listRuns(source, 1);
    const lastSync = last
      ? `${last.status} at ${last.startedAt}${last.status === "ok" ? ` (${last.pointsWritten} points)` : ""}`
      : "never";

    console.log(
      `${provider.source.padEnd(7)} ${tokenState.padEnd(22)} ${lastSync}`,
    );
  }
}

function printRun(run: SyncRun): void {
  console.log(`\nSync ${run.source}: ${run.status}`);
  console.log(`  points written: ${run.pointsWritten}`);
  if (run.cursorAfter) console.log(`  cursor advanced → ${run.cursorAfter}`);
  if (run.error) {
    console.log(`  error: ${run.error.message}`);
    if (/No OAuth tokens|Re-consent/i.test(run.error.message)) {
      console.log(`  → run: npm run connect -- ${run.source}`);
    }
  }
}

async function sync(source: OAuthSourceId): Promise<void> {
  const { system, http, tokenStore } = createLiveIntegrations();
  const connector = system.connectors.get(source);
  console.log(`Syncing ${source}…`);
  const run = await system.scheduler.runSync(connector, http, tokenStore, "manual");
  printRun(run);
  process.exit(run.status === "ok" ? 0 : 1);
}

async function disconnect(source: OAuthSourceId): Promise<void> {
  const tokenStore = new KeychainTokenStore();
  const removed = await tokenStore.delete(source);
  console.log(removed ? `${source} tokens removed from Keychain.` : `${source} had no stored tokens.`);
}

async function main(): Promise<void> {
  const [cmd, arg] = process.argv.slice(2);

  if (!cmd) usage();

  if (isOAuthSource(cmd)) return login(cmd);

  switch (cmd) {
    case "login":
      return login(requireOAuthSource(arg));
    case "status":
      return status();
    case "sync":
      return sync(requireOAuthSource(arg));
    case "disconnect":
      return disconnect(requireOAuthSource(arg));
    default:
      usage();
  }
}

main().catch((err) => {
  console.error(`\n${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
