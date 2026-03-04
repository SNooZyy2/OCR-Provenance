/**
 * Unit tests for Gemini Client
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  GeminiClient,
  GeminiRateLimiter,
  CircuitBreaker,
  loadGeminiConfig,
  GEMINI_MODELS,
  GEMINI_TIER_LIMITS,
  getGeminiTier,
  getGeminiRateLimit,
  getVlmConcurrency,
  DATALAB_MAX_CONCURRENT_DEFAULT,
  estimateTokens,
} from '../../../src/services/gemini/index.js';

// CircuitState is not exported; use string literals matching the enum values
const CircuitState = {
  CLOSED: 'CLOSED' as const,
  OPEN: 'OPEN' as const,
  HALF_OPEN: 'HALF_OPEN' as const,
};

describe('Gemini Config', () => {
  it('should have correct model IDs', () => {
    expect(GEMINI_MODELS.FLASH_LITE_3_1).toBe('gemini-3.1-flash-lite-preview');
    expect(Object.keys(GEMINI_MODELS)).toEqual(['FLASH_LITE_3_1']);
  });

  it('should have correct tier-based rate limits', () => {
    // Default tier is tier1
    const originalTier = process.env.GEMINI_TIER;
    delete process.env.GEMINI_TIER;

    expect(getGeminiTier()).toBe('tier1');
    const limits = getGeminiRateLimit();
    expect(limits.RPM).toBe(270);
    expect(limits.TPM).toBe(1_800_000);
    expect(limits.RPD).toBe(1_350);
    expect(limits.vlmConcurrency).toBe(5);

    if (originalTier) process.env.GEMINI_TIER = originalTier;
  });

  it('should have correct limits for all tiers', () => {
    expect(GEMINI_TIER_LIMITS.free).toEqual({ RPM: 9, TPM: 225_000, RPD: 225, vlmConcurrency: 1 });
    expect(GEMINI_TIER_LIMITS.tier1).toEqual({ RPM: 270, TPM: 1_800_000, RPD: 1_350, vlmConcurrency: 5 });
    expect(GEMINI_TIER_LIMITS.tier2).toEqual({ RPM: 1_800, TPM: 3_600_000, RPD: 9_000, vlmConcurrency: 10 });
    expect(GEMINI_TIER_LIMITS.tier3).toEqual({ RPM: 1_800, TPM: 3_600_000, RPD: 45_000, vlmConcurrency: 10 });
  });

  it('should throw on invalid GEMINI_TIER', () => {
    const originalTier = process.env.GEMINI_TIER;
    process.env.GEMINI_TIER = 'invalid';

    expect(() => getGeminiTier()).toThrow('Invalid GEMINI_TIER="invalid"');

    if (originalTier) {
      process.env.GEMINI_TIER = originalTier;
    } else {
      delete process.env.GEMINI_TIER;
    }
  });

  it('should read GEMINI_TIER env var', () => {
    const originalTier = process.env.GEMINI_TIER;
    process.env.GEMINI_TIER = 'free';

    expect(getGeminiTier()).toBe('free');
    const limits = getGeminiRateLimit();
    expect(limits.RPM).toBe(9);

    if (originalTier) {
      process.env.GEMINI_TIER = originalTier;
    } else {
      delete process.env.GEMINI_TIER;
    }
  });

  it('should have VLM concurrency and Datalab defaults', () => {
    const originalTier = process.env.GEMINI_TIER;
    const originalVlm = process.env.VLM_CONCURRENCY;
    delete process.env.GEMINI_TIER;
    delete process.env.VLM_CONCURRENCY;

    expect(getVlmConcurrency()).toBe(5); // tier1 default
    expect(DATALAB_MAX_CONCURRENT_DEFAULT).toBe(10);

    if (originalTier) process.env.GEMINI_TIER = originalTier;
    if (originalVlm) process.env.VLM_CONCURRENCY = originalVlm;
  });

  it('should allow VLM_CONCURRENCY env override', () => {
    const originalVlm = process.env.VLM_CONCURRENCY;
    process.env.VLM_CONCURRENCY = '20';

    expect(getVlmConcurrency()).toBe(20);

    if (originalVlm) {
      process.env.VLM_CONCURRENCY = originalVlm;
    } else {
      delete process.env.VLM_CONCURRENCY;
    }
  });

  it('should load config from environment', () => {
    // Mock env
    const originalEnv = process.env.GEMINI_API_KEY;
    const originalModel = process.env.GEMINI_MODEL;
    process.env.GEMINI_API_KEY = 'test-key';
    delete process.env.GEMINI_MODEL; // Ensure default model is used

    const config = loadGeminiConfig();
    expect(config.apiKey).toBe('test-key');
    expect(config.model).toBe(GEMINI_MODELS.FLASH_LITE_3_1);
    // Restore
    if (originalEnv) {
      process.env.GEMINI_API_KEY = originalEnv;
    }
    if (originalModel) {
      process.env.GEMINI_MODEL = originalModel;
    }
  });
});

describe('GeminiRateLimiter', () => {
  let limiter: GeminiRateLimiter;

  beforeEach(() => {
    limiter = new GeminiRateLimiter();
  });

  it('should start with full capacity (tier1 defaults)', () => {
    const status = limiter.getStatus();
    // tier1: 270 RPM, 1.8M TPM
    expect(status.requestsRemaining).toBe(270);
    expect(status.tokensRemaining).toBe(1_800_000);
  });

  it('should allow acquiring tokens', async () => {
    await limiter.acquire(1000);

    const status = limiter.getStatus();
    expect(status.requestsRemaining).toBe(269);
    expect(status.tokensRemaining).toBe(1_799_000);
  });

  it('should track token usage accurately', async () => {
    await limiter.acquire(1000);
    limiter.recordUsage(1000, 1500); // Actual was 500 more

    const status = limiter.getStatus();
    expect(status.tokensRemaining).toBe(1_798_500);
  });

  it('should not be limited initially', () => {
    expect(limiter.isLimited()).toBe(false);
  });

  it('should reset correctly', async () => {
    await limiter.acquire(1000);
    limiter.reset();

    const status = limiter.getStatus();
    expect(status.requestsRemaining).toBe(270);
  });
});

describe('CircuitBreaker', () => {
  let breaker: CircuitBreaker;

  beforeEach(() => {
    breaker = new CircuitBreaker({
      failureThreshold: 3,
      recoveryTimeMs: 1000,
      halfOpenSuccessThreshold: 2,
    });
  });

  it('should start in CLOSED state', () => {
    expect(breaker.getState()).toBe(CircuitState.CLOSED);
  });

  it('should stay CLOSED on success', async () => {
    await breaker.execute(async () => 'success');
    expect(breaker.getState()).toBe(CircuitState.CLOSED);
  });

  it('should open after threshold server failures', async () => {
    // M-1: Only server errors (HTTP 500, 502, 503, 429, network) trip the breaker.
    // Client errors (validation, parse) do NOT trip it.
    for (let i = 0; i < 3; i++) {
      try {
        await breaker.execute(async () => {
          const err = new Error('500 Internal Server Error');
          (err as unknown as Record<string, number>).status = 500;
          throw err;
        });
      } catch {
        // Expected
      }
    }

    expect(breaker.getState()).toBe(CircuitState.OPEN);
  });

  it('should NOT open after threshold client failures', async () => {
    // Client errors (validation, parse) should NOT trip the circuit breaker
    for (let i = 0; i < 5; i++) {
      try {
        await breaker.execute(async () => {
          throw new Error('JSON parse error');
        });
      } catch {
        // Expected
      }
    }

    // Circuit should stay CLOSED - client errors don't count
    expect(breaker.getState()).toBe(CircuitState.CLOSED);
  });

  it('should reject requests when OPEN', async () => {
    breaker.forceOpen();

    await expect(breaker.execute(async () => 'test')).rejects.toThrow('Circuit breaker is OPEN');
  });

  it('should provide time to recovery when OPEN', () => {
    breaker.forceOpen();
    const status = breaker.getStatus();

    expect(status.state).toBe(CircuitState.OPEN);
    expect(status.timeToRecovery).toBeGreaterThan(0);
  });

  it('should reset correctly', () => {
    breaker.forceOpen();
    breaker.reset();

    expect(breaker.getState()).toBe(CircuitState.CLOSED);
    expect(breaker.getStatus().failureCount).toBe(0);
  });
});

describe('Token Estimation', () => {
  it('should estimate text tokens at ~4 chars per token', () => {
    const tokens = estimateTokens(400, 0, false);
    expect(tokens).toBe(100); // 400 / 4 = 100
  });

  it('should add 280 tokens per high-res image', () => {
    const tokens = estimateTokens(0, 2, true);
    expect(tokens).toBe(560); // 2 * 280
  });

  it('should add 70 tokens per low-res image', () => {
    const tokens = estimateTokens(0, 2, false);
    expect(tokens).toBe(140); // 2 * 70
  });

  it('should combine text and image tokens', () => {
    const tokens = estimateTokens(400, 1, true);
    expect(tokens).toBe(380); // 100 + 280
  });
});

describe('GeminiClient', () => {
  it('should throw if no API key', () => {
    const originalKey = process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY;

    expect(() => new GeminiClient({ apiKey: '' })).toThrow(
      'GEMINI_API_KEY environment variable is not set'
    );

    if (originalKey) {
      process.env.GEMINI_API_KEY = originalKey;
    }
  });

  it('should create client with valid API key', () => {
    const originalModel = process.env.GEMINI_MODEL;
    delete process.env.GEMINI_MODEL; // Ensure default model
    const client = new GeminiClient({ apiKey: 'test-key' });
    expect(client).toBeDefined();

    const status = client.getStatus();
    expect(status.model).toBe(GEMINI_MODELS.FLASH_LITE_3_1);
    if (originalModel) process.env.GEMINI_MODEL = originalModel;
  });

  it('should create FileRef from buffer', () => {
    const buffer = Buffer.from('test image data');
    const fileRef = GeminiClient.fileRefFromBuffer(buffer, 'image/png');

    expect(fileRef.mimeType).toBe('image/png');
    expect(fileRef.sizeBytes).toBe(buffer.length);
    expect(fileRef.data).toBe(buffer.toString('base64'));
  });

  it('should reject unsupported MIME types', () => {
    const buffer = Buffer.from('test');
    expect(() => GeminiClient.fileRefFromBuffer(buffer, 'text/plain' as any)).toThrow(
      'Unsupported MIME type'
    );
  });
});
