/**
 * Exponential backoff with jitter + token-bucket rate limiting.
 *
 * Used by connectors to handle:
 *   - 429 Too Many Requests
 *   - 503 / transient 5xx
 *   - Retry-After headers
 */

export interface BackoffOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  jitterFactor?: number;
}

const DEFAULT_OPTS: Required<BackoffOptions> = {
  maxAttempts: 5,
  baseDelayMs: 500,
  maxDelayMs: 30_000,
  jitterFactor: 0.3,
};

/**
 * Execute fn with exponential backoff on retryable errors.
 * fn should throw a BackoffError with retryable=true to trigger retry.
 */
export async function withBackoff<T>(
  fn: () => Promise<T>,
  opts: BackoffOptions = {}
): Promise<T> {
  const o = { ...DEFAULT_OPTS, ...opts };
  let attempt = 0;

  while (true) {
    try {
      return await fn();
    } catch (err) {
      attempt++;
      if (attempt >= o.maxAttempts) throw err;

      const retryAfter = extractRetryAfter(err);
      const delay = retryAfter ?? jitteredDelay(attempt, o);

      if (!isRetryable(err)) throw err;

      await sleep(delay);
    }
  }
}

export class BackoffError extends Error {
  constructor(
    message: string,
    public readonly retryable: boolean,
    public readonly statusCode?: number,
    public readonly retryAfterMs?: number
  ) {
    super(message);
    this.name = "BackoffError";
  }
}

function isRetryable(err: unknown): boolean {
  if (err instanceof BackoffError) return err.retryable;
  return false;
}

function extractRetryAfter(err: unknown): number | null {
  if (err instanceof BackoffError && err.retryAfterMs != null) {
    return err.retryAfterMs;
  }
  return null;
}

function jitteredDelay(
  attempt: number,
  o: Required<BackoffOptions>
): number {
  const base = Math.min(o.baseDelayMs * 2 ** (attempt - 1), o.maxDelayMs);
  const jitter = base * o.jitterFactor * (Math.random() * 2 - 1);
  return Math.max(0, base + jitter);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Simple token-bucket rate limiter.
 * Allows `rate` requests per `windowMs` milliseconds.
 */
export class TokenBucket {
  private tokens: number;
  private lastRefill: number;

  constructor(
    private rate: number,
    private windowMs: number
  ) {
    this.tokens = rate;
    this.lastRefill = Date.now();
  }

  /** Consume one token. Returns true if allowed; false if rate-limited. */
  consume(): boolean {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }

  /** Wait until a token is available, then consume it. */
  async waitAndConsume(): Promise<void> {
    while (!this.consume()) {
      await sleep(this.windowMs / this.rate);
    }
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    const newTokens = (elapsed / this.windowMs) * this.rate;
    this.tokens = Math.min(this.rate, this.tokens + newTokens);
    this.lastRefill = now;
  }
}
