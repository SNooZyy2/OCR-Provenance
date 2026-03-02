/**
 * Unit tests for RegistryService (database management).
 * 35 tests using real SQLite databases - no mocks, no stubs.
 * Every test queries the registry DB directly as Source of Truth.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import Database from 'better-sqlite3';
import { RegistryService } from '../../../src/services/storage/registry/index.js';
import { DatabaseErrorCode } from '../../../src/services/storage/database/types.js';
import { databaseManagementTools } from '../../../src/tools/database-management.js';
import { state } from '../../../src/server/state.js';

let tempDir: string;
let databasesDir: string;

/** Helper: create a real SQLite .db file and return its path */
function createRealDb(name: string): string {
  const filePath = join(databasesDir, `${name}.db`);
  const db = new Database(filePath);
  db.exec('CREATE TABLE IF NOT EXISTS test_marker (id INTEGER PRIMARY KEY)');
  db.close();
  return filePath;
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'registry-test-'));
  databasesDir = join(tempDir, 'databases');
  mkdirSync(databasesDir, { recursive: true });
  RegistryService.resetForTesting(tempDir);
});

afterEach(() => {
  RegistryService.close();
  rmSync(tempDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Schema Tests (1-3)
// ---------------------------------------------------------------------------
describe('Schema Tests', () => {
  it('1. creates registry database on getInstance', () => {
    const registryPath = join(tempDir, '_registry.db');
    expect(existsSync(registryPath)).toBe(true);
  });

  it('2. creates all required tables', () => {
    const conn = RegistryService.getInstance().getConnection();
    const rows = conn
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all() as { name: string }[];
    const tableNames = rows.map(r => r.name);
    expect(tableNames).toEqual([
      'access_log',
      'database_metadata_kv',
      'database_tags',
      'databases',
      'databases_fts',
      'databases_fts_config',
      'databases_fts_content',
      'databases_fts_data',
      'databases_fts_docsize',
      'databases_fts_idx',
      'workspace_members',
      'workspaces',
    ]);
    // Verify the 7 logical tables (excluding FTS internals)
    const logicalTables = ['access_log', 'database_metadata_kv', 'database_tags', 'databases', 'databases_fts', 'workspace_members', 'workspaces'];
    for (const t of logicalTables) {
      expect(tableNames).toContain(t);
    }
  });

  it('3. creates all required triggers', () => {
    const conn = RegistryService.getInstance().getConnection();
    const rows = conn
      .prepare("SELECT name FROM sqlite_master WHERE type='trigger' ORDER BY name")
      .all() as { name: string }[];
    const triggerNames = rows.map(r => r.name);
    expect(triggerNames).toContain('databases_ad');
    expect(triggerNames).toContain('databases_ai');
    expect(triggerNames).toContain('databases_au');
    expect(triggerNames).toContain('tags_ad');
    expect(triggerNames).toContain('tags_ai');
    expect(triggerNames.length).toBeGreaterThanOrEqual(5);
  });
});

// ---------------------------------------------------------------------------
// CRUD Tests (4-12)
// ---------------------------------------------------------------------------
describe('CRUD Tests', () => {
  it('4. registerDatabase inserts into databases table', () => {
    const filePath = createRealDb('test-db');
    RegistryService.getInstance().registerDatabase('test-db', filePath, 'A test database');

    const conn = RegistryService.getInstance().getConnection();
    const row = conn.prepare('SELECT * FROM databases WHERE name = ?').get('test-db') as Record<string, unknown>;
    expect(row).toBeTruthy();
    expect(row.name).toBe('test-db');
    expect(row.file_path).toBe(filePath);
    expect(row.description).toBe('A test database');
    expect(row.status).toBe('active');
  });

  it('5. registerDatabase inserts tags', () => {
    const filePath = createRealDb('tagged-db');
    RegistryService.getInstance().registerDatabase('tagged-db', filePath, 'tagged', ['finance', 'legal']);

    const conn = RegistryService.getInstance().getConnection();
    const rows = conn
      .prepare('SELECT tag FROM database_tags WHERE database_name = ? ORDER BY tag')
      .all('tagged-db') as { tag: string }[];
    expect(rows.map(r => r.tag)).toEqual(['finance', 'legal']);
  });

  it('6. registerDatabase inserts metadata', () => {
    const filePath = createRealDb('meta-db');
    RegistryService.getInstance().registerDatabase('meta-db', filePath, 'with meta', [], { owner: 'alice', region: 'us-east' });

    const conn = RegistryService.getInstance().getConnection();
    const rows = conn
      .prepare('SELECT key, value FROM database_metadata_kv WHERE database_name = ? ORDER BY key')
      .all('meta-db') as { key: string; value: string }[];
    expect(rows).toEqual([
      { key: 'owner', value: 'alice' },
      { key: 'region', value: 'us-east' },
    ]);
  });

  it('7. registerDatabase populates FTS', () => {
    const filePath = createRealDb('fts-test');
    RegistryService.getInstance().registerDatabase('fts-test', filePath, 'searchable description');

    const conn = RegistryService.getInstance().getConnection();
    const row = conn.prepare("SELECT * FROM databases_fts WHERE databases_fts MATCH '\"fts-test\"'").get();
    expect(row).toBeTruthy();
  });

  it('8. registerDatabase throws on duplicate name', () => {
    const filePath = createRealDb('dup-db');
    RegistryService.getInstance().registerDatabase('dup-db', filePath, 'first');

    try {
      RegistryService.getInstance().registerDatabase('dup-db', filePath, 'second');
      expect.fail('Should have thrown');
    } catch (err: unknown) {
      const e = err as { code: string };
      expect(e.code).toBe(DatabaseErrorCode.REGISTRY_ERROR);
    }
  });

  it('9. unregisterDatabase removes all data', () => {
    const filePath = createRealDb('remove-db');
    RegistryService.getInstance().registerDatabase('remove-db', filePath, 'will be removed', ['tag1'], { k: 'v' });
    RegistryService.getInstance().unregisterDatabase('remove-db');

    const conn = RegistryService.getInstance().getConnection();
    const dbRow = conn.prepare('SELECT COUNT(*) as cnt FROM databases WHERE name = ?').get('remove-db') as { cnt: number };
    expect(dbRow.cnt).toBe(0);

    const tagRow = conn.prepare('SELECT COUNT(*) as cnt FROM database_tags WHERE database_name = ?').get('remove-db') as { cnt: number };
    expect(tagRow.cnt).toBe(0);

    const metaRow = conn.prepare('SELECT COUNT(*) as cnt FROM database_metadata_kv WHERE database_name = ?').get('remove-db') as { cnt: number };
    expect(metaRow.cnt).toBe(0);
  });

  it('10. unregisterDatabase throws on missing name', () => {
    try {
      RegistryService.getInstance().unregisterDatabase('nonexistent');
      expect.fail('Should have thrown');
    } catch (err: unknown) {
      const e = err as { code: string };
      expect(e.code).toBe(DatabaseErrorCode.DATABASE_NOT_FOUND);
    }
  });

  it('11. getDatabase returns entry with tags and metadata', () => {
    const filePath = createRealDb('full-db');
    RegistryService.getInstance().registerDatabase('full-db', filePath, 'full entry', ['t1', 't2'], { key1: 'val1' });

    const result = RegistryService.getInstance().getDatabase('full-db');
    expect(result).toBeTruthy();
    expect(result!.name).toBe('full-db');
    expect(result!.description).toBe('full entry');
    expect(result!.tags.sort()).toEqual(['t1', 't2']);
    expect(result!.metadata).toEqual({ key1: 'val1' });

    // Cross-check with direct SQL
    const conn = RegistryService.getInstance().getConnection();
    const directRow = conn.prepare('SELECT name, description FROM databases WHERE name = ?').get('full-db') as Record<string, unknown>;
    expect(directRow.name).toBe('full-db');
    expect(directRow.description).toBe('full entry');
  });

  it('12. getDatabase returns null for missing name', () => {
    const result = RegistryService.getInstance().getDatabase('nonexistent');
    expect(result).toBeNull();

    // Verify via direct SQL
    const conn = RegistryService.getInstance().getConnection();
    const row = conn.prepare('SELECT COUNT(*) as cnt FROM databases WHERE name = ?').get('nonexistent') as { cnt: number };
    expect(row.cnt).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Access Tracking Tests (13-15)
// ---------------------------------------------------------------------------
describe('Access Tracking Tests', () => {
  it('13. recordAccess increments counter', () => {
    const filePath = createRealDb('access-db');
    RegistryService.getInstance().registerDatabase('access-db', filePath);
    RegistryService.getInstance().recordAccess('access-db', 'read');
    RegistryService.getInstance().recordAccess('access-db', 'write');

    const conn = RegistryService.getInstance().getConnection();
    const row = conn.prepare('SELECT access_count FROM databases WHERE name = ?').get('access-db') as { access_count: number };
    expect(row.access_count).toBe(2);
  });

  it('14. recordAccess inserts into access_log', () => {
    const filePath = createRealDb('log-db');
    RegistryService.getInstance().registerDatabase('log-db', filePath);
    RegistryService.getInstance().recordAccess('log-db', 'search');

    const conn = RegistryService.getInstance().getConnection();
    const row = conn.prepare('SELECT COUNT(*) as cnt FROM access_log WHERE database_name = ?').get('log-db') as { cnt: number };
    expect(row.cnt).toBe(1);
  });

  it('15. recordAccess updates last_accessed_at', () => {
    const filePath = createRealDb('ts-db');
    RegistryService.getInstance().registerDatabase('ts-db', filePath);

    // Before access, last_accessed_at should be null
    const conn = RegistryService.getInstance().getConnection();
    const before = conn.prepare('SELECT last_accessed_at FROM databases WHERE name = ?').get('ts-db') as { last_accessed_at: string | null };
    expect(before.last_accessed_at).toBeNull();

    RegistryService.getInstance().recordAccess('ts-db', 'open');

    const after = conn.prepare('SELECT last_accessed_at FROM databases WHERE name = ?').get('ts-db') as { last_accessed_at: string | null };
    expect(after.last_accessed_at).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Search Tests (16-20)
// ---------------------------------------------------------------------------
describe('Search Tests', () => {
  it('16. search with query matches by name', () => {
    const filePath = createRealDb('alpha-db');
    RegistryService.getInstance().registerDatabase('alpha-db', filePath, 'some database');

    const results = RegistryService.getInstance().search('alpha');
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results.some(r => r.name === 'alpha-db')).toBe(true);

    // Verify match came from FTS
    const conn = RegistryService.getInstance().getConnection();
    const ftsRow = conn.prepare("SELECT * FROM databases_fts WHERE databases_fts MATCH '\"alpha\"'").get();
    expect(ftsRow).toBeTruthy();
  });

  it('17. search with query matches by description', () => {
    const filePath = createRealDb('desc-db');
    RegistryService.getInstance().registerDatabase('desc-db', filePath, 'financial reports for Q3');

    const results = RegistryService.getInstance().search('financial');
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results.some(r => r.name === 'desc-db')).toBe(true);

    // Verify via direct SQL
    const conn = RegistryService.getInstance().getConnection();
    const row = conn.prepare('SELECT description FROM databases WHERE name = ?').get('desc-db') as { description: string };
    expect(row.description).toContain('financial');
  });

  it('18. search with empty query returns all active', () => {
    const fp1 = createRealDb('db-one');
    const fp2 = createRealDb('db-two');
    const fp3 = createRealDb('db-three');
    RegistryService.getInstance().registerDatabase('db-one', fp1);
    RegistryService.getInstance().registerDatabase('db-two', fp2);
    RegistryService.getInstance().registerDatabase('db-three', fp3);

    const results = RegistryService.getInstance().search('');
    expect(results.length).toBe(3);

    // Verify all are active via SQL
    const conn = RegistryService.getInstance().getConnection();
    const row = conn.prepare("SELECT COUNT(*) as cnt FROM databases WHERE status = 'active'").get() as { cnt: number };
    expect(row.cnt).toBe(3);
  });

  it('19. search with status=archived returns only archived', () => {
    const fp1 = createRealDb('active-db');
    const fp2 = createRealDb('archived-db');
    RegistryService.getInstance().registerDatabase('active-db', fp1);
    RegistryService.getInstance().registerDatabase('archived-db', fp2);
    RegistryService.getInstance().archive('archived-db', 'old data');

    const results = RegistryService.getInstance().search('', { status: 'archived' });
    expect(results.length).toBe(1);
    expect(results[0].name).toBe('archived-db');

    // Verify via SQL
    const conn = RegistryService.getInstance().getConnection();
    const row = conn.prepare("SELECT COUNT(*) as cnt FROM databases WHERE status = 'archived'").get() as { cnt: number };
    expect(row.cnt).toBe(1);
  });

  it('20. search with tags filter', () => {
    const fp1 = createRealDb('tagged-a');
    const fp2 = createRealDb('tagged-b');
    RegistryService.getInstance().registerDatabase('tagged-a', fp1, '', ['finance']);
    RegistryService.getInstance().registerDatabase('tagged-b', fp2, '', ['legal']);

    const results = RegistryService.getInstance().search('', { tags: ['finance'] });
    expect(results.length).toBe(1);
    expect(results[0].name).toBe('tagged-a');

    // Verify tags via SQL
    const conn = RegistryService.getInstance().getConnection();
    const tagRows = conn
      .prepare("SELECT database_name FROM database_tags WHERE tag = 'finance'")
      .all() as { database_name: string }[];
    expect(tagRows.length).toBe(1);
    expect(tagRows[0].database_name).toBe('tagged-a');
  });
});

// ---------------------------------------------------------------------------
// Recency Test (21)
// ---------------------------------------------------------------------------
describe('Recency Tests', () => {
  it('21. getRecent returns ordered by last_accessed_at DESC', () => {
    const fp1 = createRealDb('old-db');
    const fp2 = createRealDb('new-db');
    RegistryService.getInstance().registerDatabase('old-db', fp1);
    RegistryService.getInstance().registerDatabase('new-db', fp2);

    // Use direct SQL to set distinct timestamps (recordAccess uses datetime('now')
    // which has second-level granularity and both calls may land in the same second)
    const conn = RegistryService.getInstance().getConnection();
    conn.prepare("UPDATE databases SET last_accessed_at = '2026-01-01 10:00:00', access_count = 1 WHERE name = 'old-db'").run();
    conn.prepare("UPDATE databases SET last_accessed_at = '2026-01-01 11:00:00', access_count = 1 WHERE name = 'new-db'").run();

    const recent = RegistryService.getInstance().getRecent(2);
    expect(recent.length).toBe(2);
    expect(recent[0].name).toBe('new-db');
    expect(recent[1].name).toBe('old-db');

    // Verify via direct SQL
    const rows = conn
      .prepare('SELECT name FROM databases WHERE last_accessed_at IS NOT NULL ORDER BY last_accessed_at DESC')
      .all() as { name: string }[];
    expect(rows[0].name).toBe('new-db');
  });
});

// ---------------------------------------------------------------------------
// Tag Tests (22-24)
// ---------------------------------------------------------------------------
describe('Tag Tests', () => {
  it('22. addTags / getTags', () => {
    const filePath = createRealDb('tag-db');
    RegistryService.getInstance().registerDatabase('tag-db', filePath);
    RegistryService.getInstance().addTags('tag-db', ['a', 'b']);

    const tags = RegistryService.getInstance().getTags('tag-db');
    expect(tags.sort()).toEqual(['a', 'b']);

    // Verify via SQL
    const conn = RegistryService.getInstance().getConnection();
    const rows = conn
      .prepare('SELECT tag FROM database_tags WHERE database_name = ? ORDER BY tag')
      .all('tag-db') as { tag: string }[];
    expect(rows.map(r => r.tag)).toEqual(['a', 'b']);
  });

  it('23. removeTags', () => {
    const filePath = createRealDb('rmtag-db');
    RegistryService.getInstance().registerDatabase('rmtag-db', filePath);
    RegistryService.getInstance().addTags('rmtag-db', ['a', 'b', 'c']);
    RegistryService.getInstance().removeTags('rmtag-db', ['b']);

    const tags = RegistryService.getInstance().getTags('rmtag-db');
    expect(tags.sort()).toEqual(['a', 'c']);

    // Verify via SQL
    const conn = RegistryService.getInstance().getConnection();
    const rows = conn
      .prepare('SELECT tag FROM database_tags WHERE database_name = ? ORDER BY tag')
      .all('rmtag-db') as { tag: string }[];
    expect(rows.map(r => r.tag)).toEqual(['a', 'c']);
  });

  it('24. setTags replaces all tags', () => {
    const filePath = createRealDb('settag-db');
    RegistryService.getInstance().registerDatabase('settag-db', filePath);
    RegistryService.getInstance().addTags('settag-db', ['a', 'b']);
    RegistryService.getInstance().setTags('settag-db', ['x', 'y']);

    const tags = RegistryService.getInstance().getTags('settag-db');
    expect(tags.sort()).toEqual(['x', 'y']);

    // Verify via SQL - old tags gone, new tags present
    const conn = RegistryService.getInstance().getConnection();
    const rows = conn
      .prepare('SELECT tag FROM database_tags WHERE database_name = ? ORDER BY tag')
      .all('settag-db') as { tag: string }[];
    expect(rows.map(r => r.tag)).toEqual(['x', 'y']);
  });
});

// ---------------------------------------------------------------------------
// Metadata Tests (25)
// ---------------------------------------------------------------------------
describe('Metadata Tests', () => {
  it('25. setMetadata / getMetadata', () => {
    const filePath = createRealDb('meta-db2');
    RegistryService.getInstance().registerDatabase('meta-db2', filePath);
    RegistryService.getInstance().setMetadata('meta-db2', { k1: 'v1', k2: 'v2' });

    const meta = RegistryService.getInstance().getMetadata('meta-db2');
    expect(meta).toEqual({ k1: 'v1', k2: 'v2' });

    // Verify via SQL
    const conn = RegistryService.getInstance().getConnection();
    const rows = conn
      .prepare('SELECT key, value FROM database_metadata_kv WHERE database_name = ? ORDER BY key')
      .all('meta-db2') as { key: string; value: string }[];
    expect(rows).toEqual([
      { key: 'k1', value: 'v1' },
      { key: 'k2', value: 'v2' },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Archive Tests (26-28)
// ---------------------------------------------------------------------------
describe('Archive Tests', () => {
  it('26. archive sets status and archived_at', () => {
    const filePath = createRealDb('arch-db');
    RegistryService.getInstance().registerDatabase('arch-db', filePath);
    RegistryService.getInstance().archive('arch-db', 'no longer needed');

    const conn = RegistryService.getInstance().getConnection();
    const row = conn.prepare('SELECT status, archived_at, archive_reason FROM databases WHERE name = ?').get('arch-db') as {
      status: string;
      archived_at: string | null;
      archive_reason: string | null;
    };
    expect(row.status).toBe('archived');
    expect(row.archived_at).not.toBeNull();
    expect(row.archive_reason).toBe('no longer needed');
  });

  it('27. archive throws on already archived', () => {
    const filePath = createRealDb('double-arch');
    RegistryService.getInstance().registerDatabase('double-arch', filePath);
    RegistryService.getInstance().archive('double-arch');

    try {
      RegistryService.getInstance().archive('double-arch');
      expect.fail('Should have thrown');
    } catch (err: unknown) {
      const e = err as { code: string };
      expect(e.code).toBe(DatabaseErrorCode.DATABASE_ARCHIVED);
    }
  });

  it('28. unarchive restores to active', () => {
    const filePath = createRealDb('unarch-db');
    RegistryService.getInstance().registerDatabase('unarch-db', filePath);
    RegistryService.getInstance().archive('unarch-db', 'temp archive');
    RegistryService.getInstance().unarchive('unarch-db');

    const conn = RegistryService.getInstance().getConnection();
    const row = conn.prepare('SELECT status, archived_at FROM databases WHERE name = ?').get('unarch-db') as {
      status: string;
      archived_at: string | null;
    };
    expect(row.status).toBe('active');
    expect(row.archived_at).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Rename Tests (29-31)
// ---------------------------------------------------------------------------
describe('Rename Tests', () => {
  it('29. rename updates database name', () => {
    const filePath = createRealDb('old-name');
    RegistryService.getInstance().registerDatabase('old-name', filePath, 'a db');
    RegistryService.getInstance().rename('old-name', 'new-name');

    expect(RegistryService.getInstance().getDatabase('old-name')).toBeNull();
    const entry = RegistryService.getInstance().getDatabase('new-name');
    expect(entry).toBeTruthy();
    expect(entry!.description).toBe('a db');

    // Verify via SQL
    const conn = RegistryService.getInstance().getConnection();
    const oldRow = conn.prepare('SELECT COUNT(*) as cnt FROM databases WHERE name = ?').get('old-name') as { cnt: number };
    expect(oldRow.cnt).toBe(0);
    const newRow = conn.prepare('SELECT COUNT(*) as cnt FROM databases WHERE name = ?').get('new-name') as { cnt: number };
    expect(newRow.cnt).toBe(1);
  });

  it('30. rename cascades to tags and metadata', () => {
    const filePath = createRealDb('cascade-old');
    RegistryService.getInstance().registerDatabase('cascade-old', filePath, 'cascade test', ['mytag'], { mk: 'mv' });
    RegistryService.getInstance().rename('cascade-old', 'cascade-new');

    // Verify tags cascaded
    const conn = RegistryService.getInstance().getConnection();
    const oldTags = conn.prepare('SELECT COUNT(*) as cnt FROM database_tags WHERE database_name = ?').get('cascade-old') as { cnt: number };
    expect(oldTags.cnt).toBe(0);
    const newTags = conn.prepare('SELECT tag FROM database_tags WHERE database_name = ?').all('cascade-new') as { tag: string }[];
    expect(newTags.map(r => r.tag)).toEqual(['mytag']);

    // Verify metadata cascaded
    const oldMeta = conn.prepare('SELECT COUNT(*) as cnt FROM database_metadata_kv WHERE database_name = ?').get('cascade-old') as { cnt: number };
    expect(oldMeta.cnt).toBe(0);
    const newMeta = conn.prepare('SELECT key, value FROM database_metadata_kv WHERE database_name = ?').all('cascade-new') as { key: string; value: string }[];
    expect(newMeta).toEqual([{ key: 'mk', value: 'mv' }]);
  });

  it('31. rename throws on duplicate target name', () => {
    const fp1 = createRealDb('src-db');
    const fp2 = createRealDb('dst-db');
    RegistryService.getInstance().registerDatabase('src-db', fp1);
    RegistryService.getInstance().registerDatabase('dst-db', fp2);

    try {
      RegistryService.getInstance().rename('src-db', 'dst-db');
      expect.fail('Should have thrown');
    } catch (err: unknown) {
      const e = err as { code: string };
      expect(e.code).toBe(DatabaseErrorCode.REGISTRY_ERROR);
    }
  });
});

// ---------------------------------------------------------------------------
// Stats Tests (32)
// ---------------------------------------------------------------------------
describe('Stats Tests', () => {
  it('32. syncStats updates counts', () => {
    const filePath = createRealDb('stats-db');
    RegistryService.getInstance().registerDatabase('stats-db', filePath);
    RegistryService.getInstance().syncStats('stats-db', {
      document_count: 42,
      chunk_count: 1200,
      embedding_count: 2400,
      size_bytes: 5242880,
    });

    const conn = RegistryService.getInstance().getConnection();
    const row = conn.prepare('SELECT document_count, chunk_count, embedding_count, size_bytes FROM databases WHERE name = ?').get('stats-db') as {
      document_count: number;
      chunk_count: number;
      embedding_count: number;
      size_bytes: number;
    };
    expect(row.document_count).toBe(42);
    expect(row.chunk_count).toBe(1200);
    expect(row.embedding_count).toBe(2400);
    expect(row.size_bytes).toBe(5242880);
  });
});

// ---------------------------------------------------------------------------
// Reconcile Tests (33-35)
// ---------------------------------------------------------------------------
describe('Reconcile Tests', () => {
  it('33. reconcile adds databases from filesystem', () => {
    // Create 2 .db files in databasesDir manually
    const db1 = new Database(join(databasesDir, 'discovered-one.db'));
    db1.exec('CREATE TABLE t (id INTEGER)');
    db1.close();
    const db2 = new Database(join(databasesDir, 'discovered-two.db'));
    db2.exec('CREATE TABLE t (id INTEGER)');
    db2.close();

    const result = RegistryService.getInstance().reconcile(databasesDir);
    expect(result.added).toBe(2);

    // Verify via SQL
    const conn = RegistryService.getInstance().getConnection();
    const rows = conn.prepare('SELECT name FROM databases ORDER BY name').all() as { name: string }[];
    expect(rows.map(r => r.name)).toEqual(['discovered-one', 'discovered-two']);
  });

  it('34. reconcile removes orphaned entries', () => {
    // Register a DB but DON'T create the actual .db file
    const fakePath = join(databasesDir, 'ghost.db');
    const conn = RegistryService.getInstance().getConnection();
    conn.prepare('INSERT INTO databases (name, file_path, size_bytes) VALUES (?, ?, ?)').run('ghost', fakePath, 0);

    // Verify it exists before reconcile
    const beforeRow = conn.prepare('SELECT COUNT(*) as cnt FROM databases WHERE name = ?').get('ghost') as { cnt: number };
    expect(beforeRow.cnt).toBe(1);

    const result = RegistryService.getInstance().reconcile(databasesDir);
    expect(result.removed).toBe(1);

    // Verify it was removed
    const afterRow = conn.prepare('SELECT COUNT(*) as cnt FROM databases WHERE name = ?').get('ghost') as { cnt: number };
    expect(afterRow.cnt).toBe(0);
  });

  it('35. reconcile updates size_bytes', () => {
    // Create a .db file with some content
    const dbPath = join(databasesDir, 'sized-db.db');
    const tempDb = new Database(dbPath);
    tempDb.exec('CREATE TABLE big (data TEXT)');
    tempDb.exec("INSERT INTO big VALUES ('some content to give it size')");
    tempDb.close();

    // Register it with size_bytes = 0
    const conn = RegistryService.getInstance().getConnection();
    conn.prepare('INSERT INTO databases (name, file_path, size_bytes) VALUES (?, ?, ?)').run('sized-db', dbPath, 0);

    const result = RegistryService.getInstance().reconcile(databasesDir);
    expect(result.updated).toBeGreaterThanOrEqual(1);

    // Verify size_bytes was updated to > 0
    const row = conn.prepare('SELECT size_bytes FROM databases WHERE name = ?').get('sized-db') as { size_bytes: number };
    expect(row.size_bytes).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// HANDLER TESTS (36-65) - Tests for databaseManagementTools handlers
// ═══════════════════════════════════════════════════════════════════════════════

/** Helper: create a real SQLite .db file with full schema tables for summary tests */
function createFullSchemaDb(name: string): string {
  const filePath = join(databasesDir, `${name}.db`);
  const db = new Database(filePath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS documents (id TEXT PRIMARY KEY, file_name TEXT, file_type TEXT, page_count INTEGER DEFAULT 0, status TEXT DEFAULT 'complete', created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS ocr_results (id TEXT PRIMARY KEY, document_id TEXT, parse_quality_score REAL);
    CREATE TABLE IF NOT EXISTS chunks (id TEXT PRIMARY KEY, document_id TEXT, text TEXT, chunk_index INTEGER);
    CREATE TABLE IF NOT EXISTS embeddings (id TEXT PRIMARY KEY, chunk_id TEXT);
    CREATE TABLE IF NOT EXISTS images (id TEXT PRIMARY KEY, document_id TEXT, vlm_status TEXT DEFAULT 'pending');
    CREATE TABLE IF NOT EXISTS database_metadata (id INTEGER PRIMARY KEY, database_name TEXT, created_at TEXT DEFAULT (datetime('now')), last_modified_at TEXT DEFAULT (datetime('now')), total_documents INTEGER DEFAULT 0, total_ocr_results INTEGER DEFAULT 0, total_chunks INTEGER DEFAULT 0, total_embeddings INTEGER DEFAULT 0);
    INSERT INTO database_metadata (id, database_name) VALUES (1, '${name}');
  `);
  db.close();
  return filePath;
}

/** Helper: create a .db file with database_metadata table for rename tests */
function createDbWithMetadata(name: string): string {
  const filePath = join(databasesDir, `${name}.db`);
  const db = new Database(filePath);
  db.exec('CREATE TABLE IF NOT EXISTS test_marker (id INTEGER PRIMARY KEY)');
  db.exec('CREATE TABLE IF NOT EXISTS database_metadata (id INTEGER PRIMARY KEY, database_name TEXT)');
  db.prepare('INSERT OR REPLACE INTO database_metadata (id, database_name) VALUES (1, ?)').run(name);
  db.close();
  return filePath;
}

/** Helper: parse handler response */
function parseResponse(result: { content: Array<{ type: string; text: string }>; isError?: boolean }): Record<string, unknown> {
  return JSON.parse(result.content[0].text);
}

// ---------------------------------------------------------------------------
// ocr_db_search Tests (36-43)
// ---------------------------------------------------------------------------
describe('ocr_db_search Tests', () => {
  it('36. returns matches by name (FTS)', async () => {
    const fp1 = createRealDb('alpha-search');
    const fp2 = createRealDb('beta-search');
    RegistryService.getInstance().registerDatabase('alpha-search', fp1, 'Alpha database');
    RegistryService.getInstance().registerDatabase('beta-search', fp2, 'Beta database');

    const result = await databaseManagementTools.ocr_db_search.handler({ query: 'alpha' });
    const parsed = parseResponse(result);
    const data = parsed.data as { databases: Array<{ name: string }>; total_matches: number };

    expect(data.databases.length).toBe(1);
    expect(data.databases[0].name).toBe('alpha-search');

    // Verify via SQL: FTS match exists
    const conn = RegistryService.getInstance().getConnection();
    const ftsRow = conn.prepare("SELECT * FROM databases_fts WHERE databases_fts MATCH '\"alpha\"'").get();
    expect(ftsRow).toBeTruthy();
  });

  it('37. returns matches by description (FTS)', async () => {
    const fp = createRealDb('desc-test');
    RegistryService.getInstance().registerDatabase('desc-test', fp, 'financial quarterly reports');

    const result = await databaseManagementTools.ocr_db_search.handler({ query: 'financial' });
    const parsed = parseResponse(result);
    const data = parsed.data as { databases: Array<{ name: string }> };

    expect(data.databases.some((d: { name: string }) => d.name === 'desc-test')).toBe(true);

    // Verify via SQL: description stored
    const conn = RegistryService.getInstance().getConnection();
    const row = conn.prepare('SELECT description FROM databases WHERE name = ?').get('desc-test') as { description: string };
    expect(row.description).toBe('financial quarterly reports');
  });

  it('38. empty query returns all active databases', async () => {
    const fp1 = createRealDb('all-a');
    const fp2 = createRealDb('all-b');
    const fp3 = createRealDb('all-c');
    RegistryService.getInstance().registerDatabase('all-a', fp1);
    RegistryService.getInstance().registerDatabase('all-b', fp2);
    RegistryService.getInstance().registerDatabase('all-c', fp3);

    const result = await databaseManagementTools.ocr_db_search.handler({ query: '' });
    const parsed = parseResponse(result);
    const data = parsed.data as { total_matches: number };

    expect(data.total_matches).toBe(3);

    // Verify via SQL
    const conn = RegistryService.getInstance().getConnection();
    const row = conn.prepare("SELECT COUNT(*) as cnt FROM databases WHERE status = 'active'").get() as { cnt: number };
    expect(row.cnt).toBe(3);
  });

  it('39. filters by tags', async () => {
    const fp1 = createRealDb('lit-db');
    const fp2 = createRealDb('tax-db');
    RegistryService.getInstance().registerDatabase('lit-db', fp1, 'litigation db', ['litigation']);
    RegistryService.getInstance().registerDatabase('tax-db', fp2, 'tax db', ['tax']);

    const result = await databaseManagementTools.ocr_db_search.handler({ query: '', tags: ['litigation'] });
    const parsed = parseResponse(result);
    const data = parsed.data as { databases: Array<{ name: string }>; total_matches: number };

    expect(data.total_matches).toBe(1);
    expect(data.databases[0].name).toBe('lit-db');

    // Verify via SQL
    const conn = RegistryService.getInstance().getConnection();
    const tagRows = conn.prepare("SELECT database_name FROM database_tags WHERE tag = 'litigation'").all() as { database_name: string }[];
    expect(tagRows.length).toBe(1);
    expect(tagRows[0].database_name).toBe('lit-db');
  });

  it('40. filters by status archived', async () => {
    const fp1 = createRealDb('active-s');
    const fp2 = createRealDb('archived-s');
    RegistryService.getInstance().registerDatabase('active-s', fp1);
    RegistryService.getInstance().registerDatabase('archived-s', fp2);
    RegistryService.getInstance().archive('archived-s', 'old');

    const result = await databaseManagementTools.ocr_db_search.handler({ query: '', status: 'archived' });
    const parsed = parseResponse(result);
    const data = parsed.data as { databases: Array<{ name: string }>; total_matches: number };

    expect(data.total_matches).toBe(1);
    expect(data.databases[0].name).toBe('archived-s');

    // Verify via SQL
    const conn = RegistryService.getInstance().getConnection();
    const row = conn.prepare("SELECT status FROM databases WHERE name = 'archived-s'").get() as { status: string };
    expect(row.status).toBe('archived');
  });

  it('41. filters by min_documents', async () => {
    const fp1 = createRealDb('few-docs');
    const fp2 = createRealDb('many-docs');
    RegistryService.getInstance().registerDatabase('few-docs', fp1);
    RegistryService.getInstance().registerDatabase('many-docs', fp2);
    RegistryService.getInstance().syncStats('many-docs', { document_count: 10, chunk_count: 100, embedding_count: 100, size_bytes: 1024 });

    const result = await databaseManagementTools.ocr_db_search.handler({ query: '', min_documents: 5 });
    const parsed = parseResponse(result);
    const data = parsed.data as { databases: Array<{ name: string }>; total_matches: number };

    expect(data.total_matches).toBe(1);
    expect(data.databases[0].name).toBe('many-docs');

    // Verify via SQL
    const conn = RegistryService.getInstance().getConnection();
    const row = conn.prepare('SELECT document_count FROM databases WHERE name = ?').get('many-docs') as { document_count: number };
    expect(row.document_count).toBe(10);
  });

  it('42. respects limit parameter', async () => {
    for (let i = 0; i < 5; i++) {
      const fp = createRealDb(`lim-db-${i}`);
      RegistryService.getInstance().registerDatabase(`lim-db-${i}`, fp);
    }

    const result = await databaseManagementTools.ocr_db_search.handler({ query: '', limit: 2 });
    const parsed = parseResponse(result);
    const data = parsed.data as { returned: number; total_matches: number };

    expect(data.returned).toBe(2);
    expect(data.total_matches).toBe(5);
  });

  it('43. no matches returns empty array', async () => {
    const result = await databaseManagementTools.ocr_db_search.handler({ query: 'xyznonexistent' });
    const parsed = parseResponse(result);
    const data = parsed.data as { databases: Array<unknown>; total_matches: number };

    expect(data.databases).toEqual([]);
    expect(data.total_matches).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// ocr_db_recent Tests (44-46)
// ---------------------------------------------------------------------------
describe('ocr_db_recent Tests', () => {
  it('44. returns in recency order', async () => {
    const fpA = createRealDb('recent-a');
    const fpB = createRealDb('recent-b');
    const fpC = createRealDb('recent-c');
    RegistryService.getInstance().registerDatabase('recent-a', fpA);
    RegistryService.getInstance().registerDatabase('recent-b', fpB);
    RegistryService.getInstance().registerDatabase('recent-c', fpC);

    // Set distinct timestamps via direct SQL
    const conn = RegistryService.getInstance().getConnection();
    conn.prepare("UPDATE databases SET last_accessed_at = '2026-01-01 08:00:00', access_count = 1 WHERE name = 'recent-a'").run();
    conn.prepare("UPDATE databases SET last_accessed_at = '2026-01-01 10:00:00', access_count = 1 WHERE name = 'recent-b'").run();
    conn.prepare("UPDATE databases SET last_accessed_at = '2026-01-01 09:00:00', access_count = 1 WHERE name = 'recent-c'").run();

    const result = await databaseManagementTools.ocr_db_recent.handler({ limit: 3 });
    const parsed = parseResponse(result);
    const data = parsed.data as { databases: Array<{ name: string }> };

    expect(data.databases[0].name).toBe('recent-b');
    expect(data.databases[1].name).toBe('recent-c');
    expect(data.databases[2].name).toBe('recent-a');

    // Verify via SQL
    const rows = conn.prepare('SELECT name FROM databases WHERE last_accessed_at IS NOT NULL ORDER BY last_accessed_at DESC').all() as { name: string }[];
    expect(rows[0].name).toBe('recent-b');
  });

  it('45. empty when nothing accessed', async () => {
    const fp = createRealDb('no-access');
    RegistryService.getInstance().registerDatabase('no-access', fp);

    const result = await databaseManagementTools.ocr_db_recent.handler({});
    const parsed = parseResponse(result);
    const data = parsed.data as { databases: Array<unknown>; total: number };

    expect(data.databases).toEqual([]);
    expect(data.total).toBe(0);
  });

  it('46. access_count reflects multiple accesses', async () => {
    const fp = createRealDb('multi-access');
    RegistryService.getInstance().registerDatabase('multi-access', fp);
    RegistryService.getInstance().recordAccess('multi-access', 'read');
    RegistryService.getInstance().recordAccess('multi-access', 'read');
    RegistryService.getInstance().recordAccess('multi-access', 'search');

    const result = await databaseManagementTools.ocr_db_recent.handler({ limit: 1 });
    const parsed = parseResponse(result);
    const data = parsed.data as { databases: Array<{ access_count: number }> };

    expect(data.databases.length).toBe(1);
    expect(data.databases[0].access_count).toBeGreaterThanOrEqual(3);
  });
});

// ---------------------------------------------------------------------------
// ocr_db_tag Tests (47-52)
// ---------------------------------------------------------------------------
describe('ocr_db_tag Tests', () => {
  it('47. add tags', async () => {
    const fp = createRealDb('tag-add-db');
    RegistryService.getInstance().registerDatabase('tag-add-db', fp);

    const result = await databaseManagementTools.ocr_db_tag.handler({
      database_name: 'tag-add-db',
      action: 'add',
      tags: ['a', 'b'],
    });
    const parsed = parseResponse(result);
    const data = parsed.data as { tags: string[] };

    expect(data.tags.sort()).toEqual(['a', 'b']);

    // Verify via SQL
    const conn = RegistryService.getInstance().getConnection();
    const rows = conn.prepare('SELECT tag FROM database_tags WHERE database_name = ? ORDER BY tag').all('tag-add-db') as { tag: string }[];
    expect(rows.map(r => r.tag)).toEqual(['a', 'b']);
  });

  it('48. remove tags', async () => {
    const fp = createRealDb('tag-rm-db');
    RegistryService.getInstance().registerDatabase('tag-rm-db', fp, '', ['a', 'b', 'c']);

    const result = await databaseManagementTools.ocr_db_tag.handler({
      database_name: 'tag-rm-db',
      action: 'remove',
      tags: ['b'],
    });
    const parsed = parseResponse(result);
    const data = parsed.data as { tags: string[] };

    expect([...data.tags].sort()).toEqual(['a', 'c']);

    // Verify via SQL
    const conn = RegistryService.getInstance().getConnection();
    const rows = conn.prepare('SELECT tag FROM database_tags WHERE database_name = ? ORDER BY tag').all('tag-rm-db') as { tag: string }[];
    expect(rows.map(r => r.tag)).toEqual(['a', 'c']);
  });

  it('49. set replaces all tags', async () => {
    const fp = createRealDb('tag-set-db');
    RegistryService.getInstance().registerDatabase('tag-set-db', fp, '', ['old']);

    const result = await databaseManagementTools.ocr_db_tag.handler({
      database_name: 'tag-set-db',
      action: 'set',
      tags: ['new1', 'new2'],
    });
    const parsed = parseResponse(result);
    const data = parsed.data as { tags: string[] };

    expect([...data.tags].sort()).toEqual(['new1', 'new2']);

    // Verify old tag gone via SQL
    const conn = RegistryService.getInstance().getConnection();
    const rows = conn.prepare('SELECT tag FROM database_tags WHERE database_name = ? ORDER BY tag').all('tag-set-db') as { tag: string }[];
    expect(rows.map(r => r.tag)).toEqual(['new1', 'new2']);
    expect(rows.map(r => r.tag)).not.toContain('old');
  });

  it('50. list returns current tags and metadata', async () => {
    const fp = createRealDb('tag-list-db');
    RegistryService.getInstance().registerDatabase('tag-list-db', fp, '', ['t1', 't2'], { owner: 'alice' });

    const result = await databaseManagementTools.ocr_db_tag.handler({
      database_name: 'tag-list-db',
      action: 'list',
    });
    const parsed = parseResponse(result);
    const data = parsed.data as { tags: string[]; metadata: Record<string, string> };

    expect([...data.tags].sort()).toEqual(['t1', 't2']);
    expect(data.metadata).toEqual({ owner: 'alice' });
  });

  it('51. set with metadata', async () => {
    const fp = createRealDb('tag-meta-db');
    RegistryService.getInstance().registerDatabase('tag-meta-db', fp);

    const result = await databaseManagementTools.ocr_db_tag.handler({
      database_name: 'tag-meta-db',
      action: 'set',
      tags: ['t1'],
      metadata: { client: 'acme' },
    });
    const parsed = parseResponse(result);
    const data = parsed.data as { tags: string[]; metadata: Record<string, string> };

    expect(data.tags).toContain('t1');
    expect(data.metadata.client).toBe('acme');

    // Verify via SQL
    const conn = RegistryService.getInstance().getConnection();
    const rows = conn.prepare('SELECT key, value FROM database_metadata_kv WHERE database_name = ?').all('tag-meta-db') as { key: string; value: string }[];
    expect(rows.some(r => r.key === 'client' && r.value === 'acme')).toBe(true);
  });

  it('52. nonexistent database throws', async () => {
    const result = await databaseManagementTools.ocr_db_tag.handler({
      database_name: 'nonexistent-tag-db',
      action: 'list',
    });

    expect(result.isError).toBe(true);
    const text = result.content[0].text;
    expect(text).toContain('not found');
  });
});

// ---------------------------------------------------------------------------
// ocr_db_archive Tests (53-55)
// ---------------------------------------------------------------------------
describe('ocr_db_archive Tests', () => {
  it('53. sets status to archived with reason', async () => {
    const fp = createRealDb('arch-handler-db');
    RegistryService.getInstance().registerDatabase('arch-handler-db', fp);

    const result = await databaseManagementTools.ocr_db_archive.handler({
      database_name: 'arch-handler-db',
      reason: 'old data',
    });
    const parsed = parseResponse(result);
    const data = parsed.data as { archived: boolean };

    expect(data.archived).toBe(true);

    // Verify via SQL
    const conn = RegistryService.getInstance().getConnection();
    const row = conn.prepare('SELECT status, archive_reason FROM databases WHERE name = ?').get('arch-handler-db') as { status: string; archive_reason: string };
    expect(row.status).toBe('archived');
    expect(row.archive_reason).toBe('old data');
  });

  it('54. already archived throws', async () => {
    const fp = createRealDb('double-arch-h');
    RegistryService.getInstance().registerDatabase('double-arch-h', fp);
    RegistryService.getInstance().archive('double-arch-h', 'first archive');

    const result = await databaseManagementTools.ocr_db_archive.handler({
      database_name: 'double-arch-h',
    });

    expect(result.isError).toBe(true);
    const text = result.content[0].text;
    expect(text).toContain('already archived');
  });

  it('55. nonexistent throws', async () => {
    const result = await databaseManagementTools.ocr_db_archive.handler({
      database_name: 'ghost-arch',
    });

    expect(result.isError).toBe(true);
    const text = result.content[0].text;
    expect(text).toContain('not found');
  });
});

// ---------------------------------------------------------------------------
// ocr_db_unarchive Tests (56-57)
// ---------------------------------------------------------------------------
describe('ocr_db_unarchive Tests', () => {
  it('56. restores to active', async () => {
    const fp = createRealDb('unarch-handler-db');
    RegistryService.getInstance().registerDatabase('unarch-handler-db', fp);
    RegistryService.getInstance().archive('unarch-handler-db', 'temp');

    const result = await databaseManagementTools.ocr_db_unarchive.handler({
      database_name: 'unarch-handler-db',
    });
    const parsed = parseResponse(result);
    const data = parsed.data as { unarchived: boolean };

    expect(data.unarchived).toBe(true);

    // Verify via SQL
    const conn = RegistryService.getInstance().getConnection();
    const row = conn.prepare('SELECT status, archived_at FROM databases WHERE name = ?').get('unarch-handler-db') as { status: string; archived_at: string | null };
    expect(row.status).toBe('active');
    expect(row.archived_at).toBeNull();
  });

  it('57. already active throws', async () => {
    const fp = createRealDb('active-unarch');
    RegistryService.getInstance().registerDatabase('active-unarch', fp);

    const result = await databaseManagementTools.ocr_db_unarchive.handler({
      database_name: 'active-unarch',
    });

    expect(result.isError).toBe(true);
    const text = result.content[0].text;
    expect(text).toContain('already active');
  });
});

// ---------------------------------------------------------------------------
// ocr_db_rename Tests (58-62)
// ---------------------------------------------------------------------------
describe('ocr_db_rename Tests', () => {
  beforeEach(() => {
    // Set state.config.defaultStoragePath so getDatabasePath resolves to our temp databasesDir
    state.config.defaultStoragePath = databasesDir;
  });

  it('58. renames file and registry entry', async () => {
    const filePath = createDbWithMetadata('rename-old');
    RegistryService.getInstance().registerDatabase('rename-old', filePath);

    const result = await databaseManagementTools.ocr_db_rename.handler({
      old_name: 'rename-old',
      new_name: 'rename-new',
    });
    const parsed = parseResponse(result);
    const data = parsed.data as { old_name: string; new_name: string };

    expect(data.old_name).toBe('rename-old');
    expect(data.new_name).toBe('rename-new');

    // Verify old file gone, new file exists
    expect(existsSync(join(databasesDir, 'rename-old.db'))).toBe(false);
    expect(existsSync(join(databasesDir, 'rename-new.db'))).toBe(true);

    // Verify via SQL: old name gone, new name exists
    const conn = RegistryService.getInstance().getConnection();
    const oldRow = conn.prepare('SELECT COUNT(*) as cnt FROM databases WHERE name = ?').get('rename-old') as { cnt: number };
    expect(oldRow.cnt).toBe(0);
    const newRow = conn.prepare('SELECT COUNT(*) as cnt FROM databases WHERE name = ?').get('rename-new') as { cnt: number };
    expect(newRow.cnt).toBe(1);
  });

  it('59. cascades tags', async () => {
    const filePath = createDbWithMetadata('cascade-src');
    RegistryService.getInstance().registerDatabase('cascade-src', filePath, '', ['tag1']);

    await databaseManagementTools.ocr_db_rename.handler({
      old_name: 'cascade-src',
      new_name: 'cascade-dst',
    });

    // Verify tags exist under new name
    const conn = RegistryService.getInstance().getConnection();
    const oldTags = conn.prepare('SELECT COUNT(*) as cnt FROM database_tags WHERE database_name = ?').get('cascade-src') as { cnt: number };
    expect(oldTags.cnt).toBe(0);
    const newTags = conn.prepare('SELECT tag FROM database_tags WHERE database_name = ?').all('cascade-dst') as { tag: string }[];
    expect(newTags.map(r => r.tag)).toContain('tag1');
  });

  it('60. updates internal database_metadata', async () => {
    const filePath = createDbWithMetadata('internal-old');
    RegistryService.getInstance().registerDatabase('internal-old', filePath);

    await databaseManagementTools.ocr_db_rename.handler({
      old_name: 'internal-old',
      new_name: 'internal-new',
    });

    // Open new .db file, query database_metadata
    const newPath = join(databasesDir, 'internal-new.db');
    const tempDb = new Database(newPath, { readonly: true });
    const row = tempDb.prepare('SELECT database_name FROM database_metadata WHERE id = 1').get() as { database_name: string };
    tempDb.close();

    expect(row.database_name).toBe('internal-new');
  });

  it('61. duplicate target throws', async () => {
    const fp1 = createDbWithMetadata('dup-src');
    const fp2 = createDbWithMetadata('dup-dst');
    RegistryService.getInstance().registerDatabase('dup-src', fp1);
    RegistryService.getInstance().registerDatabase('dup-dst', fp2);

    const result = await databaseManagementTools.ocr_db_rename.handler({
      old_name: 'dup-src',
      new_name: 'dup-dst',
    });

    expect(result.isError).toBe(true);
    const text = result.content[0].text;
    expect(text).toContain('already exists');

    // Verify first db file still exists (no filesystem changes)
    expect(existsSync(join(databasesDir, 'dup-src.db'))).toBe(true);
  });

  it('62. nonexistent source throws', async () => {
    const result = await databaseManagementTools.ocr_db_rename.handler({
      old_name: 'ghost-rename',
      new_name: 'new-ghost',
    });

    expect(result.isError).toBe(true);
    const text = result.content[0].text;
    expect(text).toContain('not found');
  });
});

// ---------------------------------------------------------------------------
// ocr_db_summary Tests (63-65)
// ---------------------------------------------------------------------------
describe('ocr_db_summary Tests', () => {
  beforeEach(() => {
    // Set state.config.defaultStoragePath so getDatabasePath resolves to our temp databasesDir
    state.config.defaultStoragePath = databasesDir;
  });

  it('63. returns profile for empty database', async () => {
    const filePath = createFullSchemaDb('summary-empty');
    RegistryService.getInstance().registerDatabase('summary-empty', filePath);

    const result = await databaseManagementTools.ocr_db_summary.handler({ database_name: 'summary-empty' });
    const parsed = parseResponse(result);
    const data = parsed.data as {
      name: string;
      total_pages: number;
      chunk_count: number;
      embedding_count: number;
      image_count: number;
    };

    expect(data.name).toBe('summary-empty');
    expect(data.total_pages).toBe(0);
    expect(data.chunk_count).toBe(0);
    expect(data.embedding_count).toBe(0);
    expect(data.image_count).toBe(0);
  });

  it('64. caches profile_json in registry', async () => {
    const filePath = createFullSchemaDb('summary-cache');
    RegistryService.getInstance().registerDatabase('summary-cache', filePath);

    await databaseManagementTools.ocr_db_summary.handler({ database_name: 'summary-cache' });

    // Verify profile_json is cached in registry
    const conn = RegistryService.getInstance().getConnection();
    const row = conn.prepare('SELECT profile_json FROM databases WHERE name = ?').get('summary-cache') as { profile_json: string | null };
    expect(row.profile_json).not.toBeNull();

    // Parse the cached profile and verify it has expected fields
    const cached = JSON.parse(row.profile_json!);
    expect(cached.name).toBe('summary-cache');
    expect(cached.chunk_count).toBe(0);
  });

  it('65. nonexistent database throws', async () => {
    const result = await databaseManagementTools.ocr_db_summary.handler({ database_name: 'ghost-summary' });

    expect(result.isError).toBe(true);
    const text = result.content[0].text;
    expect(text).toContain('not found');
  });
});

// ---------------------------------------------------------------------------
// ocr_db_workspace Tests (66-77)
// ---------------------------------------------------------------------------
describe('ocr_db_workspace Tests', () => {
  it('66. workspace: create creates entry', async () => {
    const result = await databaseManagementTools.ocr_db_workspace.handler({ action: 'create', name: 'ws-create-test' });
    const parsed = parseResponse(result);

    expect(result.isError).toBeUndefined();
    expect((parsed.data as { created: boolean }).created).toBe(true);

    // Source of Truth: direct SQL
    const conn = RegistryService.getInstance().getConnection();
    const rows = conn.prepare('SELECT * FROM workspaces WHERE name = ?').all('ws-create-test');
    expect(rows.length).toBe(1);
  });

  it('67. workspace: create with description', async () => {
    const result = await databaseManagementTools.ocr_db_workspace.handler({
      action: 'create',
      name: 'ws-desc',
      description: 'My workspace description',
    });
    const parsed = parseResponse(result);

    expect(result.isError).toBeUndefined();
    expect((parsed.data as { description: string }).description).toBe('My workspace description');

    // Source of Truth: direct SQL
    const conn = RegistryService.getInstance().getConnection();
    const row = conn.prepare('SELECT description FROM workspaces WHERE name = ?').get('ws-desc') as { description: string };
    expect(row.description).toBe('My workspace description');
  });

  it('68. workspace: add_database adds member', async () => {
    const fp = createRealDb('db-add-member');
    RegistryService.getInstance().registerDatabase('db-add-member', fp);
    await databaseManagementTools.ocr_db_workspace.handler({ action: 'create', name: 'ws-add' });

    const result = await databaseManagementTools.ocr_db_workspace.handler({
      action: 'add_database',
      name: 'ws-add',
      database_name: 'db-add-member',
    });
    const parsed = parseResponse(result);

    expect(result.isError).toBeUndefined();
    expect((parsed.data as { database_added: string }).database_added).toBe('db-add-member');

    // Source of Truth: direct SQL
    const conn = RegistryService.getInstance().getConnection();
    const rows = conn.prepare('SELECT * FROM workspace_members WHERE workspace_name = ?').all('ws-add') as Array<{ database_name: string }>;
    expect(rows.length).toBe(1);
    expect(rows[0].database_name).toBe('db-add-member');
  });

  it('69. workspace: get returns databases', async () => {
    const fp1 = createRealDb('db-get-a');
    const fp2 = createRealDb('db-get-b');
    RegistryService.getInstance().registerDatabase('db-get-a', fp1);
    RegistryService.getInstance().registerDatabase('db-get-b', fp2);
    await databaseManagementTools.ocr_db_workspace.handler({ action: 'create', name: 'ws-get' });
    await databaseManagementTools.ocr_db_workspace.handler({ action: 'add_database', name: 'ws-get', database_name: 'db-get-a' });
    await databaseManagementTools.ocr_db_workspace.handler({ action: 'add_database', name: 'ws-get', database_name: 'db-get-b' });

    const result = await databaseManagementTools.ocr_db_workspace.handler({ action: 'get', name: 'ws-get' });
    const parsed = parseResponse(result);
    const data = parsed.data as { databases: string[]; database_count: number };

    expect(data.databases).toContain('db-get-a');
    expect(data.databases).toContain('db-get-b');
    expect(data.database_count).toBe(2);

    // Source of Truth: direct SQL
    const conn = RegistryService.getInstance().getConnection();
    const rows = conn.prepare('SELECT database_name FROM workspace_members WHERE workspace_name = ?').all('ws-get') as Array<{ database_name: string }>;
    expect(rows.length).toBe(2);
    const dbNames = rows.map(r => r.database_name).sort();
    expect(dbNames).toEqual(['db-get-a', 'db-get-b']);
  });

  it('70. workspace: list returns all workspaces', async () => {
    await databaseManagementTools.ocr_db_workspace.handler({ action: 'create', name: 'ws-list-a' });
    await databaseManagementTools.ocr_db_workspace.handler({ action: 'create', name: 'ws-list-b' });
    await databaseManagementTools.ocr_db_workspace.handler({ action: 'create', name: 'ws-list-c' });

    const result = await databaseManagementTools.ocr_db_workspace.handler({ action: 'list' });
    const parsed = parseResponse(result);
    const data = parsed.data as { workspaces: Array<{ name: string }>; total: number };

    expect(data.total).toBe(3);
    expect(data.workspaces.length).toBe(3);

    // Source of Truth: direct SQL
    const conn = RegistryService.getInstance().getConnection();
    const row = conn.prepare('SELECT COUNT(*) as cnt FROM workspaces').get() as { cnt: number };
    expect(row.cnt).toBe(3);
  });

  it('71. workspace: remove_database removes member', async () => {
    const fp1 = createRealDb('db-rm-a');
    const fp2 = createRealDb('db-rm-b');
    RegistryService.getInstance().registerDatabase('db-rm-a', fp1);
    RegistryService.getInstance().registerDatabase('db-rm-b', fp2);
    await databaseManagementTools.ocr_db_workspace.handler({ action: 'create', name: 'ws-rm' });
    await databaseManagementTools.ocr_db_workspace.handler({ action: 'add_database', name: 'ws-rm', database_name: 'db-rm-a' });
    await databaseManagementTools.ocr_db_workspace.handler({ action: 'add_database', name: 'ws-rm', database_name: 'db-rm-b' });

    // Verify 2 members exist before removal
    const conn = RegistryService.getInstance().getConnection();
    const before = conn.prepare('SELECT COUNT(*) as cnt FROM workspace_members WHERE workspace_name = ?').get('ws-rm') as { cnt: number };
    expect(before.cnt).toBe(2);

    const result = await databaseManagementTools.ocr_db_workspace.handler({
      action: 'remove_database',
      name: 'ws-rm',
      database_name: 'db-rm-a',
    });

    expect(result.isError).toBeUndefined();
    const parsed = parseResponse(result);
    expect((parsed.data as { database_removed: string }).database_removed).toBe('db-rm-a');

    // Source of Truth: members count decreased by 1
    const after = conn.prepare('SELECT COUNT(*) as cnt FROM workspace_members WHERE workspace_name = ?').get('ws-rm') as { cnt: number };
    expect(after.cnt).toBe(1);
  });

  it('72. workspace: delete cascades to members', async () => {
    const fp = createRealDb('db-cascade-del');
    RegistryService.getInstance().registerDatabase('db-cascade-del', fp);
    await databaseManagementTools.ocr_db_workspace.handler({ action: 'create', name: 'ws-cascade' });
    await databaseManagementTools.ocr_db_workspace.handler({ action: 'add_database', name: 'ws-cascade', database_name: 'db-cascade-del' });

    const result = await databaseManagementTools.ocr_db_workspace.handler({ action: 'delete', name: 'ws-cascade' });

    expect(result.isError).toBeUndefined();
    expect((parseResponse(result).data as { deleted: boolean }).deleted).toBe(true);

    // Source of Truth: both workspace and members gone
    const conn = RegistryService.getInstance().getConnection();
    const wsRow = conn.prepare('SELECT * FROM workspaces WHERE name = ?').get('ws-cascade');
    expect(wsRow).toBeUndefined();
    const memberRows = conn.prepare('SELECT * FROM workspace_members WHERE workspace_name = ?').all('ws-cascade');
    expect(memberRows.length).toBe(0);
  });

  it('73. workspace: duplicate create throws', async () => {
    await databaseManagementTools.ocr_db_workspace.handler({ action: 'create', name: 'ws-dup' });

    const result = await databaseManagementTools.ocr_db_workspace.handler({ action: 'create', name: 'ws-dup' });

    expect(result.isError).toBe(true);
    const text = result.content[0].text;
    expect(text).toContain('already exists');
  });

  it('74. workspace: add nonexistent db throws', async () => {
    await databaseManagementTools.ocr_db_workspace.handler({ action: 'create', name: 'ws-nodb' });

    const result = await databaseManagementTools.ocr_db_workspace.handler({
      action: 'add_database',
      name: 'ws-nodb',
      database_name: 'ghost-db-xyz',
    });

    expect(result.isError).toBe(true);
    const text = result.content[0].text;
    expect(text).toContain('not found');
  });

  it('75. workspace: add to nonexistent workspace throws', async () => {
    const fp = createRealDb('db-orphan');
    RegistryService.getInstance().registerDatabase('db-orphan', fp);

    const result = await databaseManagementTools.ocr_db_workspace.handler({
      action: 'add_database',
      name: 'ws-ghost',
      database_name: 'db-orphan',
    });

    expect(result.isError).toBe(true);
    const text = result.content[0].text;
    expect(text).toContain('not found');
  });

  it('76. workspace: db deletion cascades from workspace', async () => {
    const fp = createRealDb('db-ws-cascade');
    RegistryService.getInstance().registerDatabase('db-ws-cascade', fp);
    await databaseManagementTools.ocr_db_workspace.handler({ action: 'create', name: 'ws-db-cascade' });
    await databaseManagementTools.ocr_db_workspace.handler({ action: 'add_database', name: 'ws-db-cascade', database_name: 'db-ws-cascade' });

    // Verify member exists before unregister
    const conn = RegistryService.getInstance().getConnection();
    const before = conn.prepare('SELECT COUNT(*) as cnt FROM workspace_members WHERE database_name = ?').get('db-ws-cascade') as { cnt: number };
    expect(before.cnt).toBe(1);

    // Delete database from registry (CASCADE should remove workspace_members row)
    RegistryService.getInstance().unregisterDatabase('db-ws-cascade');

    // Source of Truth: workspace_members row for that DB is gone
    const after = conn.prepare('SELECT COUNT(*) as cnt FROM workspace_members WHERE database_name = ?').get('db-ws-cascade') as { cnt: number };
    expect(after.cnt).toBe(0);

    // Workspace itself still exists
    const wsRow = conn.prepare('SELECT * FROM workspaces WHERE name = ?').get('ws-db-cascade');
    expect(wsRow).toBeTruthy();
  });

  it('77. workspace: create without name throws', async () => {
    const result = await databaseManagementTools.ocr_db_workspace.handler({ action: 'create' });

    expect(result.isError).toBe(true);
  });
});
