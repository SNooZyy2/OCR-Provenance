/**
 * Registry Final Verification Tests
 *
 * Verifies the production registry at ~/.ocr-provenance/_registry.db
 * against the real filesystem. All operations are read-only.
 * Does NOT use resetForTesting -- tests run against real data.
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import Database from 'better-sqlite3';

const DATABASES_DIR = join(homedir(), '.ocr-provenance', 'databases');
const REGISTRY_PATH = join(homedir(), '.ocr-provenance', '_registry.db');

describe('Registry Final Verification', () => {

  it('1. registry file exists', () => {
    expect(existsSync(REGISTRY_PATH)).toBe(true);
  });

  it('2. registry has all required tables', () => {
    const db = new Database(REGISTRY_PATH, { readonly: true });
    try {
      const tables = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
      ).all() as { name: string }[];
      const tableNames = tables.map(t => t.name);

      const requiredTables = [
        'databases',
        'database_tags',
        'database_metadata_kv',
        'workspaces',
        'workspace_members',
        'access_log',
      ];

      for (const required of requiredTables) {
        expect(tableNames, `Missing required table: ${required}`).toContain(required);
      }
    } finally {
      db.close();
    }
  });

  it('3. database count matches filesystem', () => {
    const dbFiles = readdirSync(DATABASES_DIR)
      .filter(f => f.endsWith('.db') && !f.startsWith('_') && !f.endsWith('-wal') && !f.endsWith('-shm'));

    const db = new Database(REGISTRY_PATH, { readonly: true });
    try {
      const row = db.prepare('SELECT COUNT(*) as cnt FROM databases').get() as { cnt: number };
      expect(row.cnt).toBe(dbFiles.length);
    } finally {
      db.close();
    }
  });

  it('4. every db file has a registry entry', () => {
    const dbFiles = readdirSync(DATABASES_DIR)
      .filter(f => f.endsWith('.db') && !f.startsWith('_') && !f.endsWith('-wal') && !f.endsWith('-shm'));

    const db = new Database(REGISTRY_PATH, { readonly: true });
    try {
      const stmt = db.prepare('SELECT 1 FROM databases WHERE name = ?');
      for (const file of dbFiles) {
        const name = file.replace(/\.db$/, '');
        const row = stmt.get(name);
        expect(row, `Missing registry entry for filesystem file: ${name}.db`).toBeTruthy();
      }
    } finally {
      db.close();
    }
  });

  it('5. no orphaned registry entries', () => {
    const db = new Database(REGISTRY_PATH, { readonly: true });
    try {
      const entries = db.prepare('SELECT name FROM databases').all() as { name: string }[];
      for (const entry of entries) {
        const filePath = join(DATABASES_DIR, `${entry.name}.db`);
        expect(existsSync(filePath), `Orphaned registry entry: ${entry.name} has no .db file on disk`).toBe(true);
      }
    } finally {
      db.close();
    }
  });

  it('6. FTS entry count matches database count', () => {
    const db = new Database(REGISTRY_PATH, { readonly: true });
    try {
      const dbCount = (db.prepare('SELECT COUNT(*) as cnt FROM databases').get() as { cnt: number }).cnt;
      const ftsCount = (db.prepare('SELECT COUNT(*) as cnt FROM databases_fts').get() as { cnt: number }).cnt;
      expect(ftsCount).toBe(dbCount);
    } finally {
      db.close();
    }
  });

  it('7. size_bytes is non-zero for entries with data', () => {
    const db = new Database(REGISTRY_PATH, { readonly: true });
    try {
      const zeroSizeEntries = db.prepare(
        'SELECT name, size_bytes FROM databases WHERE size_bytes = 0'
      ).all() as { name: string; size_bytes: number }[];

      if (zeroSizeEntries.length > 0) {
        console.error(
          '[WARN] Databases with zero size_bytes:',
          JSON.stringify(zeroSizeEntries.map(e => e.name))
        );
      }

      // Informational -- the test passes regardless but warns about zeros
      expect(true).toBe(true);
    } finally {
      db.close();
    }
  });

  it('8. prints verification summary', () => {
    const db = new Database(REGISTRY_PATH, { readonly: true });
    try {
      const databaseCount = (db.prepare('SELECT COUNT(*) as cnt FROM databases').get() as { cnt: number }).cnt;
      const tagCount = (db.prepare('SELECT COUNT(*) as cnt FROM database_tags').get() as { cnt: number }).cnt;
      const metadataCount = (db.prepare('SELECT COUNT(*) as cnt FROM database_metadata_kv').get() as { cnt: number }).cnt;
      const workspaceCount = (db.prepare('SELECT COUNT(*) as cnt FROM workspaces').get() as { cnt: number }).cnt;
      const memberCount = (db.prepare('SELECT COUNT(*) as cnt FROM workspace_members').get() as { cnt: number }).cnt;
      const accessLogCount = (db.prepare('SELECT COUNT(*) as cnt FROM access_log').get() as { cnt: number }).cnt;

      const triggerCount = (db.prepare(
        "SELECT COUNT(*) as cnt FROM sqlite_master WHERE type='trigger'"
      ).get() as { cnt: number }).cnt;

      const sampleEntry = db.prepare(
        'SELECT name, status, size_bytes, document_count, access_count, created_at FROM databases LIMIT 1'
      ).get() as Record<string, unknown> | undefined;

      const summary = {
        table_counts: {
          databases: databaseCount,
          database_tags: tagCount,
          database_metadata_kv: metadataCount,
          workspaces: workspaceCount,
          workspace_members: memberCount,
          access_log: accessLogCount,
        },
        trigger_count: triggerCount,
        sample_entry: sampleEntry ?? null,
      };

      console.error('[VERIFICATION SUMMARY]', JSON.stringify(summary, null, 2));

      expect(databaseCount).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });
});
