/**
 * Test fakes for @jarvis/integrations.
 *
 * FakeHttp       — fixture-scriptable HttpClient; responses keyed by URL pattern.
 * FixedClock     — deterministic Clock returning a fixed timestamp.
 * MemoryTokenStore — in-memory TokenStore (no keychain / no filesystem).
 * FakeLlm        — scriptable LlmClient; returns canned responses or throws.
 */

import type {
  Clock,
  HttpClient,
  HttpRequest,
  HttpResponse,
  LlmClient,
  OAuthTokens,
  SourceId,
  TokenStore,
} from "../types.js";

// ── FakeHttp ──────────────────────────────────────────────────────────────────

type HttpFixture = {
  matcher: string | RegExp | ((url: string, method: string) => boolean);
  responses: HttpResponse | HttpResponse[];
  _callCount?: number;
};

/**
 * Scriptable fake HTTP client.
 *
 * Usage:
 *   const http = new FakeHttp();
 *   http.add('https://api.whoop.com/v1/recovery', { status: 200, headers: {}, body: { records: [...] } });
 *
 *   // Sequence: first call returns 401, second returns 200
 *   http.add(/token/, [
 *     { status: 401, headers: {}, body: {} },
 *     { status: 200, headers: {}, body: { access_token: 'new', expires_in: 3600 } },
 *   ]);
 */
export class FakeHttp implements HttpClient {
  private fixtures: HttpFixture[] = [];
  public calls: { req: HttpRequest; res: HttpResponse }[] = [];

  /** Add a fixture. `matcher` is a URL substring, regex, or predicate function. */
  add(
    matcher: string | RegExp | ((url: string, method: string) => boolean),
    responses: HttpResponse | HttpResponse[]
  ): this {
    this.fixtures.push({ matcher, responses: Array.isArray(responses) ? responses : [responses], _callCount: 0 });
    return this;
  }

  async request(req: HttpRequest): Promise<HttpResponse> {
    for (const fixture of this.fixtures) {
      const matches =
        typeof fixture.matcher === "function"
          ? fixture.matcher(req.url, req.method)
          : fixture.matcher instanceof RegExp
          ? fixture.matcher.test(req.url)
          : req.url.includes(fixture.matcher);

      if (matches) {
        const responses = fixture.responses as HttpResponse[];
        fixture._callCount = fixture._callCount ?? 0;
        const idx = Math.min(fixture._callCount, responses.length - 1);
        const res = responses[idx] ?? { status: 500, headers: {}, body: {} };
        fixture._callCount++;
        this.calls.push({ req, res });
        return res;
      }
    }

    // No fixture matched — return 404
    const res: HttpResponse = {
      status: 404,
      headers: {},
      body: { error: `No fixture for ${req.method} ${req.url}` },
    };
    this.calls.push({ req, res });
    return res;
  }

  /** Reset all recorded calls and fixtures. */
  reset(): void {
    this.fixtures = [];
    this.calls = [];
  }

  /** Number of calls matching a URL pattern. */
  callCount(pattern: string | RegExp): number {
    return this.calls.filter(({ req }) =>
      typeof pattern === "string"
        ? req.url.includes(pattern)
        : pattern.test(req.url)
    ).length;
  }
}

// ── FixedClock ────────────────────────────────────────────────────────────────

export class FixedClock implements Clock {
  constructor(private timestamp: number = Date.now()) {}

  now(): number {
    return this.timestamp;
  }

  advance(ms: number): void {
    this.timestamp += ms;
  }

  setTo(isoOrMs: string | number): void {
    this.timestamp =
      typeof isoOrMs === "string" ? new Date(isoOrMs).getTime() : isoOrMs;
  }
}

// ── MemoryTokenStore ──────────────────────────────────────────────────────────

export class MemoryTokenStore implements TokenStore {
  private store = new Map<SourceId, OAuthTokens>();

  async get(source: SourceId): Promise<OAuthTokens | null> {
    return this.store.get(source) ?? null;
  }

  async set(source: SourceId, tokens: OAuthTokens): Promise<void> {
    this.store.set(source, { ...tokens });
  }

  /** Seed a token directly (for test setup). */
  seed(source: SourceId, tokens: OAuthTokens): void {
    this.store.set(source, tokens);
  }

  /** Return the current stored token (synchronous helper for assertions). */
  peek(source: SourceId): OAuthTokens | null {
    return this.store.get(source) ?? null;
  }
}

// ── FakeLlm ───────────────────────────────────────────────────────────────────

export class FakeLlm implements LlmClient {
  private overrides: Array<{ match: string | RegExp; response: string | Error }> = [];
  private defaultResponse: string = "Good morning. Today is a fine day.";
  public calls: { opts: Parameters<LlmClient["complete"]>[0]; result: string | Error }[] = [];

  /** Configure a response for prompts matching the given pattern. */
  addOverride(match: string | RegExp, response: string | Error): this {
    this.overrides.push({ match, response });
    return this;
  }

  /** Set the default response when no override matches. */
  setDefault(response: string): this {
    this.defaultResponse = response;
    return this;
  }

  async complete(opts: Parameters<LlmClient["complete"]>[0]): Promise<string> {
    for (const o of this.overrides) {
      const matches =
        o.match instanceof RegExp
          ? o.match.test(opts.prompt)
          : opts.prompt.includes(o.match);

      if (matches) {
        this.calls.push({ opts, result: o.response });
        if (o.response instanceof Error) throw o.response;
        return o.response;
      }
    }

    this.calls.push({ opts, result: this.defaultResponse });
    return this.defaultResponse;
  }
}

// ── Fixture helpers ───────────────────────────────────────────────────────────

/** Create a minimal valid OAuth token set, valid for 1 hour from now. */
export function makeTokens(overrides: Partial<OAuthTokens> = {}): OAuthTokens {
  return {
    accessToken: "test_access_token",
    refreshToken: "test_refresh_token",
    expiresAt: Date.now() + 3600_000,
    scope: "read",
    ...overrides,
  };
}

/** Whoop recovery API fixture (one SCORED recovery record). */
export function whoopRecoveryFixture(overrides: Record<string, unknown> = {}): object {
  return {
    records: [
      {
        cycle_id: 12345,
        created_at: "2026-06-09T07:00:00Z",
        score_state: "SCORED",
        score: {
          recovery_score: 72,
          hrv_rmssd_milli: 45.5,
          resting_heart_rate: 52,
          spo2_percentage: 97.8,
          skin_temp_celsius: 36.4,
        },
        ...overrides,
      },
    ],
    next_token: null,
  };
}

/** Whoop sleep API fixture. */
export function whoopSleepFixture(overrides: Record<string, unknown> = {}): object {
  return {
    records: [
      {
        id: 67890,
        start: "2026-06-08T22:30:00Z",
        end: "2026-06-09T06:15:00Z",
        score_state: "SCORED",
        nap: false,
        score: {
          stage_summary: {
            total_in_bed_time_milli: 27900000,    // 465 min in bed
            total_awake_time_milli:  3000000,     // 50 min awake
            total_light_sleep_time_milli: 9000000, // 150 min light
            total_slow_wave_sleep_time_milli: 6600000, // 110 min deep
            total_rem_sleep_time_milli: 9300000,  // 155 min rem
          },
          sleep_performance_percentage: 88,
          respiratory_rate: 14.2,
        },
        ...overrides,
      },
    ],
  };
}

/** Apple Health Auto Export fixture (minimal). */
export function appleHealthFixture(): object {
  return {
    data: {
      metrics: [
        {
          name: "heart_rate_variability_sdnn",
          units: "ms",
          data: [
            { date: "2026-06-08T07:00:00Z", qty: 38.5 },
          ],
        },
        {
          name: "resting_heart_rate",
          units: "count/min",
          data: [
            { date: "2026-06-08T07:00:00Z", qty: 55 },
          ],
        },
        {
          name: "step_count",
          units: "count",
          data: [
            { date: "2026-06-08T00:00:00Z", qty: 8432 },
          ],
        },
        {
          name: "active_energy_burned",
          units: "kcal",
          data: [
            { date: "2026-06-08T18:00:00Z", qty: 480 },
          ],
        },
      ],
      workouts: [],
    },
  };
}

/** Google Calendar events.list fixture with syncToken. */
export function gcalEventsFixture(syncToken = "sync_tok_1"): object {
  return {
    items: [
      {
        id: "evt001",
        etag: '"etag001"',
        status: "confirmed",
        summary: "Standup",
        start: { dateTime: "2026-06-09T10:00:00Z", timeZone: "UTC" },
        end: { dateTime: "2026-06-09T10:30:00Z", timeZone: "UTC" },
        created: "2026-06-01T09:00:00Z",
        updated: "2026-06-01T09:00:00Z",
        attendees: [
          { email: "user@example.com", responseStatus: "accepted", self: true },
        ],
      },
      {
        id: "evt002",
        etag: '"etag002"',
        status: "confirmed",
        summary: "Roadmap review",
        start: { dateTime: "2026-06-09T14:00:00Z", timeZone: "UTC" },
        end: { dateTime: "2026-06-09T15:00:00Z", timeZone: "UTC" },
        created: "2026-06-01T09:00:00Z",
        updated: "2026-06-01T09:00:00Z",
        attendees: [
          { email: "user@example.com", responseStatus: "accepted", self: true },
          { email: "boss@example.com", responseStatus: "accepted", self: false },
          { email: "peer@example.com", responseStatus: "tentative", self: false },
        ],
      },
    ],
    nextSyncToken: syncToken,
  };
}

/** GitHub commits fixture. */
export function githubCommitsFixture(repo: string): object {
  return [
    {
      sha: "abc123",
      html_url: `https://github.com/${repo}/commit/abc123`,
      commit: {
        message: "feat: add metric store upsert",
        author: { date: "2026-06-09T09:00:00Z", name: "dev" },
      },
    },
    {
      sha: "def456",
      html_url: `https://github.com/${repo}/commit/def456`,
      commit: {
        message: "fix: oauth refresh concurrency",
        author: { date: "2026-06-09T11:00:00Z", name: "dev" },
      },
    },
  ];
}

/** GitHub PRs fixture. */
export function githubPRsFixture(): object {
  return [
    {
      id: 101,
      title: "Add data integration package",
      html_url: "https://github.com/example/repo/pull/101",
      created_at: "2026-06-08T08:00:00Z",
      merged_at: "2026-06-09T14:00:00Z",
      additions: 1200,
      deletions: 50,
    },
  ];
}
