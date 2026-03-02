/**
 * Registry E2E Reconciliation Tests
 *
 * Tests the RegistryService reconciliation against the REAL
 * ~/.ocr-provenance/databases/ directory. All operations are
 * read-only verification after reconcile -- no real databases
 * are modified.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { RegistryService } from '../../src/services/storage/registry/index.js';
import { DEFAULT_STORAGE_PATH } from '../../src/services/storage/database/helpers.js';

const REGISTRY_PATH = join(homedir(), '.ocr-provenance', '_registry.db');

describe('Registry E2E Reconciliation', () => {
  let registry: RegistryService;

  beforeAll(() => {
    registry = RegistryService.getInstance();
    registry.reconcile(DEFAULT_STORAGE_PATH);
  });

  afterAll(() => {
    RegistryService.close();
  });

  it('1. registry file exists after init', () => {
    expect(existsSync(REGISTRY_PATH)).toBe(true);
  });

  it('2. database count matches filesystem', () => {
    const dbFiles = readdirSync(DEFAULT_STORAGE_PATH)
      .filter(f => f.endsWith('.db') && f !== '_registry.db');
    const conn = registry.getConnection();
    const row = conn.prepare('SELECT COUNT(*) as c FROM databases').get() as { c: number };
    expect(row.c).toBe(dbFiles.length);
  });

  it('3. every .db file has a registry entry', () => {
    const dbFiles = readdirSync(DEFAULT_STORAGE_PATH)
      .filter(f => f.endsWith('.db') && f !== '_registry.db');
    const conn = registry.getConnection();
    for (const file of dbFiles) {
      const name = file.replace(/\.db$/, '');
      const row = conn.prepare('SELECT 1 FROM databases WHERE name = ?').get(name);
      expect(row, `Missing registry entry for ${name}`).toBeTruthy();
    }
  });

  it('4. no orphaned registry entries', () => {
    const conn = registry.getConnection();
    const entries = conn.prepare('SELECT name FROM databases').all() as { name: string }[];
    for (const entry of entries) {
      const filePath = join(DEFAULT_STORAGE_PATH, `${entry.name}.db`);
      expect(existsSync(filePath), `Orphan entry: ${entry.name} has no .db file`).toBe(true);
    }
  });

  it('5. size_bytes matches statSync for sample entries', () => {
    const conn = registry.getConnection();
    const entries = conn.prepare(
      'SELECT name, file_path, size_bytes FROM databases LIMIT 3'
    ).all() as { name: string; file_path: string; size_bytes: number }[];
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      const filePath = join(DEFAULT_STORAGE_PATH, `${entry.name}.db`);
      if (existsSync(filePath)) {
        const actualSize = statSync(filePath).size;
        expect(entry.size_bytes).toBe(actualSize);
      }
    }
  });

  it('6. FTS contains all entries', () => {
    const conn = registry.getConnection();
    const dbCount = (conn.prepare('SELECT COUNT(*) as c FROM databases').get() as { c: number }).c;
    const ftsCount = (conn.prepare('SELECT COUNT(*) as c FROM databases_fts').get() as { c: number }).c;
    expect(ftsCount).toBe(dbCount);
  });
});
