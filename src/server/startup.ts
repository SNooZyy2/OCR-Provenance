/**
 * Shared Startup Validation
 *
 * Validates startup dependencies and applies environment-driven config.
 * Used by both src/index.ts (stdio) and src/bin-http.ts (unified Docker entry).
 *
 * CRITICAL: NEVER use console.log() - stdout may be reserved for JSON-RPC protocol.
 *
 * @module server/startup
 */

import { updateConfig } from './state.js';
import { RegistryService } from '../services/storage/registry/index.js';
import { DEFAULT_STORAGE_PATH } from '../services/storage/database/helpers.js';

/**
 * Validate startup dependencies and apply environment-driven config overrides.
 * Warnings only: missing API keys prevent specific features, not the whole server.
 */
export function validateStartupDependencies(): void {
  const warnings: string[] = [];

  if (!process.env.DATALAB_API_KEY) {
    warnings.push(
      'DATALAB_API_KEY is not set. OCR processing will fail. Get one at https://www.datalab.to'
    );
  }
  if (!process.env.GEMINI_API_KEY) {
    warnings.push(
      'GEMINI_API_KEY is not set. VLM processing and evaluation will fail. Get one at https://aistudio.google.com/'
    );
  }

  if (warnings.length > 0) {
    console.error('=== STARTUP WARNINGS ===');
    for (const w of warnings) {
      console.error(`  - ${w}`);
    }
    console.error('========================');
  }

  // Store env var status for health check consumption
  // This avoids health check needing to re-validate every call
  (globalThis as Record<string, unknown>).__OCR_ENV_STATUS = {
    datalab_api_key: !!process.env.DATALAB_API_KEY,
    gemini_api_key: !!process.env.GEMINI_API_KEY,
    checked_at: new Date().toISOString(),
  };

  const embeddingDevice = process.env.EMBEDDING_DEVICE;
  if (embeddingDevice) {
    updateConfig({ embeddingDevice });
    console.error(`[Config] EMBEDDING_DEVICE=${embeddingDevice}`);
  }

  // Initialize database registry and reconcile with filesystem
  try {
    const registry = RegistryService.getInstance();
    registry.reconcile(DEFAULT_STORAGE_PATH);
    const count = registry.getDatabaseCount();
    console.error(`[startup] Registry initialized: ${count} database(s) tracked`);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`[startup] FATAL: Registry initialization failed: ${msg}`);
    throw error;
  }
}

process.on('exit', () => {
  try { RegistryService.close(); } catch { /* ignore */ }
});
