/**
 * Gemini API Service
 * Exports client and configuration for Gemini API integration
 */

// Client
export {
  GeminiClient,
  getSharedClient,
  resetSharedClient,
  type GeminiResponse,
  type FileRef,
  CircuitBreakerOpenError,
} from './client.js';

// Configuration
export {
  type GeminiConfig,
  type GeminiTier,
  type GeminiRateLimits,
  loadGeminiConfig,
  GEMINI_MODELS,
  GEMINI_TIER_LIMITS,
  getGeminiTier,
  getGeminiRateLimit,
  getVlmConcurrency,
  DATALAB_MAX_CONCURRENT_DEFAULT,
  GENERATION_PRESETS,
  ALLOWED_MIME_TYPES,
  MAX_FILE_SIZE,
  type ThinkingLevel,
} from './config.js';

// Rate Limiter
export { GeminiRateLimiter, estimateTokens } from './rate-limiter.js';

// Circuit Breaker
export { CircuitBreaker } from './circuit-breaker.js';
