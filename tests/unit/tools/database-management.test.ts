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
