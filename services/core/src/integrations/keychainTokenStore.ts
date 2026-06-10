/**
 * KeychainTokenStore — TokenStore backed by the macOS login Keychain via the
 * `security` CLI (architecture/auth-and-integrations.md §1: secrets live ONLY
 * in the Keychain — never .env, SQLite, or logs).
 *
 * Service naming: com.jarvis.connector.<source>, account "oauth"; the token
 * set is stored as a single JSON payload so access+refresh+expiry update
 * atomically — load-bearing for Whoop's rotating refresh tokens, where a
 * partially-persisted refresh bricks the integration.
 *
 * The command runner is injectable so tests never touch a real keychain.
 * Trade-off (accepted for a single-user laptop): `security add-generic-password
 * -w <secret>` exposes the payload in the process args for the call's duration.
 */

import { execFile } from "node:child_process";
import type { OAuthTokens, SourceId, TokenStore } from "@jarvis/integrations";

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type CommandRunner = (
  cmd: string,
  args: string[],
) => Promise<CommandResult>;

/** Default runner: execFile, capturing the exit code instead of throwing. */
export const execFileRunner: CommandRunner = (cmd, args) =>
  new Promise((resolve) => {
    execFile(cmd, args, { encoding: "utf8" }, (err, stdout, stderr) => {
      const exitCode =
        err && typeof (err as NodeJS.ErrnoException & { code?: unknown }).code === "number"
          ? ((err as unknown as { code: number }).code)
          : err
            ? 1
            : 0;
      resolve({ stdout, stderr, exitCode });
    });
  });

const SERVICE_PREFIX = "com.jarvis.connector.";
const ACCOUNT = "oauth";

export class KeychainTokenStore implements TokenStore {
  constructor(private readonly run: CommandRunner = execFileRunner) {}

  async get(source: SourceId): Promise<OAuthTokens | null> {
    const res = await this.run("security", [
      "find-generic-password",
      "-s",
      `${SERVICE_PREFIX}${source}`,
      "-a",
      ACCOUNT,
      "-w",
    ]);

    // `security` exits 44 (errSecItemNotFound) when the entry doesn't exist.
    if (res.exitCode !== 0) return null;

    const raw = res.stdout.trim();
    if (!raw) return null;
    try {
      return JSON.parse(raw) as OAuthTokens;
    } catch {
      throw new Error(
        `Keychain entry for ${source} is not valid JSON — delete it with: ` +
          `security delete-generic-password -s ${SERVICE_PREFIX}${source}`,
      );
    }
  }

  async set(source: SourceId, tokens: OAuthTokens): Promise<void> {
    // -U updates in place if the item exists; single write = atomic payload.
    const res = await this.run("security", [
      "add-generic-password",
      "-U",
      "-s",
      `${SERVICE_PREFIX}${source}`,
      "-a",
      ACCOUNT,
      "-w",
      JSON.stringify(tokens),
    ]);

    if (res.exitCode !== 0) {
      throw new Error(
        `Failed to persist ${source} tokens to Keychain (exit ${res.exitCode}): ${res.stderr.trim()}`,
      );
    }
  }

  /** Remove a source's tokens (used by `connect disconnect <source>`). */
  async delete(source: SourceId): Promise<boolean> {
    const res = await this.run("security", [
      "delete-generic-password",
      "-s",
      `${SERVICE_PREFIX}${source}`,
      "-a",
      ACCOUNT,
    ]);
    return res.exitCode === 0;
  }
}
