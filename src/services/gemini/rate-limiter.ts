/**
 * Rate Limiter for Gemini API
 * Implements RPM (requests per minute), TPM (tokens per minute),
 * and RPD (requests per day) limits.
 */

import { getGeminiRateLimit } from './config.js';

export interface RateLimiterStatus {
  requestsRemaining: number;
  tokensRemaining: number;
  resetInMs: number;
  dailyRequestsRemaining: number;
  dailyResetInMs: number;
}

export class GeminiRateLimiter {
  // Per-minute counters
  private requestCount: number = 0;
  private tokenCount: number = 0;
  private windowStart: number = Date.now();
  private readonly windowMs: number = 60000; // 1 minute window

  private readonly maxRPM: number;
  private readonly maxTPM: number;

  // Per-day counters
  private dailyRequestCount: number = 0;
  private dayStart: number = Date.now();
  private readonly maxRPD: number;
  private readonly DAY_MS: number = 86_400_000; // 24 hours

  constructor() {
    const limits = getGeminiRateLimit();
    this.maxRPM = limits.RPM;
    this.maxTPM = limits.TPM;
    this.maxRPD = limits.RPD;
  }

  /**
   * Mutex queue to serialize acquire() calls.
   * Prevents race conditions where multiple concurrent callers
   * all pass the rate limit check before any increment the count.
   */
  private _acquireQueue: Promise<void> = Promise.resolve();

  /**
   * Check if we need to reset the minute window and/or the daily window
   */
  private checkWindow(): void {
    const now = Date.now();
    if (now - this.windowStart >= this.windowMs) {
      this.requestCount = 0;
      this.tokenCount = 0;
      this.windowStart = now;
    }
    if (now - this.dayStart >= this.DAY_MS) {
      this.dailyRequestCount = 0;
      this.dayStart = now;
    }
  }

  /**
   * Acquire permission to make a request.
   * Serialized via promise queue to prevent race conditions:
   * each caller waits for the previous acquire() to complete
   * before checking and incrementing the counters.
   */
  async acquire(estimatedTokens: number = 1000): Promise<void> {
    // Chain this acquire onto the queue so callers are serialized.
    // Each caller awaits the previous one before executing _doAcquire.
    const prev = this._acquireQueue;
    let resolve!: () => void;
    this._acquireQueue = new Promise<void>((r) => {
      resolve = r;
    });

    try {
      await prev;
      await this._doAcquire(estimatedTokens);
    } finally {
      resolve();
    }
  }

  /**
   * Internal acquire logic - must only be called from the serialized queue.
   */
  private async _doAcquire(estimatedTokens: number): Promise<void> {
    this.checkWindow();

    // RPD check — hard error, no retry
    if (this.dailyRequestCount >= this.maxRPD) {
      throw new Error(
        `Gemini daily request limit reached (${this.dailyRequestCount}/${this.maxRPD} RPD). ` +
          'Wait until tomorrow or upgrade your GEMINI_TIER.'
      );
    }

    // RPM / TPM check — wait for window reset
    if (this.requestCount >= this.maxRPM || this.tokenCount + estimatedTokens > this.maxTPM) {
      const waitTime = this.windowMs - (Date.now() - this.windowStart);
      if (waitTime > 0) {
        console.error(`[RateLimiter] Rate limit reached, waiting ${waitTime}ms`);
        await this.sleep(waitTime);
        // Reset after waiting
        this.requestCount = 0;
        this.tokenCount = 0;
        this.windowStart = Date.now();
      }
    }

    // Reserve the request and tokens
    this.requestCount++;
    this.tokenCount += estimatedTokens;
    this.dailyRequestCount++;
  }

  /**
   * Record actual token usage after a request completes
   * Adjusts the count if estimate was wrong
   */
  recordUsage(estimatedTokens: number, actualTokens: number): void {
    const diff = actualTokens - estimatedTokens;
    this.tokenCount = Math.max(0, this.tokenCount + diff);
  }

  /**
   * Get current rate limiter status
   */
  getStatus(): RateLimiterStatus {
    this.checkWindow();
    return {
      requestsRemaining: Math.max(0, this.maxRPM - this.requestCount),
      tokensRemaining: Math.max(0, this.maxTPM - this.tokenCount),
      resetInMs: Math.max(0, this.windowMs - (Date.now() - this.windowStart)),
      dailyRequestsRemaining: Math.max(0, this.maxRPD - this.dailyRequestCount),
      dailyResetInMs: Math.max(0, this.DAY_MS - (Date.now() - this.dayStart)),
    };
  }

  /**
   * Check if RPM (requests per minute) limit is reached.
   * Does not check TPM or RPD — use getStatus() for full picture.
   */
  isLimited(): boolean {
    this.checkWindow();
    return this.requestCount >= this.maxRPM;
  }

  /**
   * Reset the rate limiter (for testing)
   */
  reset(): void {
    this.requestCount = 0;
    this.tokenCount = 0;
    this.windowStart = Date.now();
    this.dailyRequestCount = 0;
    this.dayStart = Date.now();
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

/**
 * Estimate tokens for a request
 * Rough estimate: ~4 characters per token for text, 280 tokens per image (HIGH res)
 */
export function estimateTokens(
  textLength: number,
  imageCount: number = 0,
  highResolution: boolean = true
): number {
  const textTokens = Math.ceil(textLength / 4);
  const imageTokens = imageCount * (highResolution ? 280 : 70);
  return textTokens + imageTokens;
}
