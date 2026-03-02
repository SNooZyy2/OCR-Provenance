/**
 * Registry Edge Case Tests
 *
 * 10 edge case scenarios using real SQLite databases - no mocks.
 * Each test logs BEFORE and AFTER state with console.error().
 * Uses RegistryService.resetForTesting(tempDir) for full isolation.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, mkdirSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import Database from 'better-sqlite3';
import { RegistryService } from '../../src/services/storage/registry/index.js';
import { databaseManagementTools } from '../../src/tools/database-management.js';
import { state, selectDatabase } from '../../src/server/state.js';

let tempDir: string;
let databasesDir: string;

/**
 * Create a real SQLite database file with test markers and database_metadata.
 * Returns the full file path.
 */
function createRealDb(name: string): string {
  const filePath = join(databasesDir, `${name}.db`);
  const db = new Database(filePath);
  db.exec('CREATE TABLE IF NOT EXISTS test_marker (id INTEGER PRIMARY KEY)');
  db.exec('CREATE TABLE IF NOT EXISTS database_metadata (id INTEGER PRIMARY KEY, database_name TEXT)');
  db.exec(`INSERT OR REPLACE INTO database_metadata (id, database_name) VALUES (1, '${name}')`);
  db.close();
  return filePath;
}

/**
 * Parse a ToolResponse into a JS object for assertion.
 */
function parseResponse(result: { content: Array<{ type: string; text: string }>; isError?: boolean }): Record<string, unknown> {
  const textBlock = result.content.find(c => c.type === 'text');
  if (!textBlock) throw new Error('No text block in response');
  return JSON.parse(textBlock.text);
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'edge-case-'));
  databasesDir = join(tempDir, 'databases');
  mkdirSync(databasesDir, { recursive: true });
  RegistryService.resetForTesting(tempDir);
});

afterEach(() => {
  // Clean up server state in case any test set it
  state.currentDatabase = null;
  state.currentDatabaseName = null;
  RegistryService.close();
  rmSync(tempDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Edge Case Tests (1-10)
// ---------------------------------------------------------------------------

describe('Registry Edge Cases', () => {

  // -------------------------------------------------------------------------
  // Edge Case 1: Empty Registry (Cold Start)
  // -------------------------------------------------------------------------
  it('1. cold start: reconcile creates _registry.db even with zero .db files', () => {
    // Use a fresh dir with NO registry yet
    const freshDir = mkdtempSync(join(tmpdir(), 'cold-start-'));
    const freshDbDir = join(freshDir, 'databases');
    mkdirSync(freshDbDir, { recursive: true });

    const freshRegistry = RegistryService.resetForTesting(freshDir);
    const registryPath = join(freshDir, '_registry.db');

    console.error('[EDGE-1] BEFORE: fresh dir, no _registry.db expected to be created by resetForTesting');
    console.error('[EDGE-1] BEFORE: registryPath exists =', existsSync(registryPath));

    // Reconcile with an empty databases dir
    const result = freshRegistry.reconcile(freshDbDir);

    console.error('[EDGE-1] AFTER reconcile (empty dir): added=%d, removed=%d, updated=%d', result.added, result.removed, result.updated);

    // Registry file should exist
    expect(existsSync(registryPath)).toBe(true);
    // Zero databases registered
    const count = freshRegistry.getDatabaseCount();
    expect(count).toBe(0);
    console.error('[EDGE-1] AFTER: database count =', count);

    // Now add 2 .db files and reconcile again
    createRealDb('alpha');
    createRealDb('bravo');
    // Move them to freshDbDir
    const alphaPath = join(databasesDir, 'alpha.db');
    const bravoPath = join(databasesDir, 'bravo.db');
    const freshAlphaPath = join(freshDbDir, 'alpha.db');
    const freshBravoPath = join(freshDbDir, 'bravo.db');
    // Create directly in freshDbDir
    const db1 = new Database(freshAlphaPath);
    db1.exec('CREATE TABLE IF NOT EXISTS test_marker (id INTEGER PRIMARY KEY)');
    db1.close();
    const db2 = new Database(freshBravoPath);
    db2.exec('CREATE TABLE IF NOT EXISTS test_marker (id INTEGER PRIMARY KEY)');
    db2.close();

    const result2 = freshRegistry.reconcile(freshDbDir);
    console.error('[EDGE-1] AFTER reconcile (2 files): added=%d, removed=%d, updated=%d', result2.added, result2.removed, result2.updated);

    const count2 = freshRegistry.getDatabaseCount();
    expect(count2).toBe(2);
    expect(result2.added).toBe(2);
    console.error('[EDGE-1] AFTER: database count =', count2);

    // Cleanup
    RegistryService.close();
    rmSync(freshDir, { recursive: true, force: true });
    // Restore the test registry
    RegistryService.resetForTesting(tempDir);
  });

  // -------------------------------------------------------------------------
  // Edge Case 2: Orphaned Registry Entry
  // -------------------------------------------------------------------------
  it('2. orphaned registry entry is removed after file deletion + reconcile', () => {
    const registry = RegistryService.getInstance();

    // Register a DB via the registry
    const filePath = createRealDb('orphan');
    registry.registerDatabase('orphan', filePath, 'Will be orphaned');

    console.error('[EDGE-2] BEFORE: registered "orphan", file exists =', existsSync(filePath));
    const beforeCount = registry.getDatabaseCount();
    console.error('[EDGE-2] BEFORE: database count =', beforeCount);
    expect(beforeCount).toBe(1);

    // Delete the .db file directly (simulating external deletion)
    unlinkSync(filePath);
    console.error('[EDGE-2] AFTER unlinkSync: file exists =', existsSync(filePath));
    expect(existsSync(filePath)).toBe(false);

    // Reconcile should detect the orphan and remove it
    const result = registry.reconcile(databasesDir);
    console.error('[EDGE-2] AFTER reconcile: added=%d, removed=%d, updated=%d', result.added, result.removed, result.updated);

    const conn = registry.getConnection();
    const row = conn.prepare("SELECT COUNT(*) as c FROM databases WHERE name = 'orphan'").get() as { c: number };
    console.error('[EDGE-2] AFTER: orphan count in registry =', row.c);
    expect(row.c).toBe(0);
    expect(result.removed).toBe(1);
  });

  // -------------------------------------------------------------------------
  // Edge Case 3: External DB File Added
  // -------------------------------------------------------------------------
  it('3. externally-created .db file is auto-discovered by reconcile', () => {
    const registry = RegistryService.getInstance();

    console.error('[EDGE-3] BEFORE: database count =', registry.getDatabaseCount());
    expect(registry.getDatabaseCount()).toBe(0);

    // Create a .db file directly (not via registry)
    const externalPath = join(databasesDir, 'external.db');
    const extDb = new Database(externalPath);
    extDb.exec('CREATE TABLE IF NOT EXISTS test_marker (id INTEGER PRIMARY KEY)');
    extDb.close();
    console.error('[EDGE-3] BEFORE reconcile: external.db exists =', existsSync(externalPath));

    // Reconcile should discover it
    const result = registry.reconcile(databasesDir);
    console.error('[EDGE-3] AFTER reconcile: added=%d, removed=%d, updated=%d', result.added, result.removed, result.updated);

    const conn = registry.getConnection();
    const row = conn.prepare("SELECT COUNT(*) as c FROM databases WHERE name = 'external'").get() as { c: number };
    console.error('[EDGE-3] AFTER: "external" in registry count =', row.c);
    expect(row.c).toBe(1);
    expect(result.added).toBe(1);
  });

  // -------------------------------------------------------------------------
  // Edge Case 4: Archive Then Search
  // -------------------------------------------------------------------------
  it('4. archived databases are excluded from default search, included with status=all', () => {
    const registry = RegistryService.getInstance();

    // Register 3 databases
    for (const name of ['db-alpha', 'db-beta', 'db-gamma']) {
      const filePath = createRealDb(name);
      registry.registerDatabase(name, filePath, `Database ${name}`);
    }

    console.error('[EDGE-4] BEFORE archive: total databases =', registry.getDatabaseCount());
    expect(registry.getDatabaseCount()).toBe(3);

    // Archive one
    registry.archive('db-beta', 'Testing archive');
    console.error('[EDGE-4] AFTER archive db-beta: entry status =',
      registry.getDatabase('db-beta')?.status);

    // Search with default status (active) - should return 2
    const activeResults = registry.search('', { status: 'active' });
    console.error('[EDGE-4] search status=active: count =', activeResults.length);
    expect(activeResults.length).toBe(2);

    // Search with status=all - should return 3
    const allResults = registry.search('', { status: 'all' });
    console.error('[EDGE-4] search status=all: count =', allResults.length);
    expect(allResults.length).toBe(3);

    // Search with status=archived - should return 1
    const archivedResults = registry.search('', { status: 'archived' });
    console.error('[EDGE-4] search status=archived: count =', archivedResults.length);
    expect(archivedResults.length).toBe(1);
    expect(archivedResults[0].name).toBe('db-beta');
  });

  // -------------------------------------------------------------------------
  // Edge Case 5: Rename a Database (filesystem + registry)
  // -------------------------------------------------------------------------
  it('5. rename updates filesystem, registry, and internal metadata', async () => {
    const registry = RegistryService.getInstance();

    // Create and register a database
    const oldPath = createRealDb('old-name');
    registry.registerDatabase('old-name', oldPath);

    console.error('[EDGE-5] BEFORE: old-name registered, file exists =', existsSync(oldPath));
    console.error('[EDGE-5] BEFORE: registry entry =', JSON.stringify(registry.getDatabase('old-name')?.name));

    // Need to set the default storage path to our temp dir for getDatabasePath to work
    // The rename handler uses getDefaultStoragePath() which reads state.config.defaultStoragePath
    const originalStoragePath = state.config.defaultStoragePath;
    state.config.defaultStoragePath = databasesDir;

    try {
      // Call the rename handler via the tool interface
      const result = await databaseManagementTools.ocr_db_rename.handler({
        old_name: 'old-name',
        new_name: 'new-name',
      });

      const parsed = parseResponse(result);
      const data = parsed.data as Record<string, unknown>;
      console.error('[EDGE-5] AFTER rename result:', JSON.stringify(data));

      // Verify filesystem
      const newPath = join(databasesDir, 'new-name.db');
      console.error('[EDGE-5] AFTER: old path exists =', existsSync(oldPath));
      console.error('[EDGE-5] AFTER: new path exists =', existsSync(newPath));
      expect(existsSync(oldPath)).toBe(false);
      expect(existsSync(newPath)).toBe(true);

      // Verify registry
      const oldEntry = registry.getDatabase('old-name');
      const newEntry = registry.getDatabase('new-name');
      console.error('[EDGE-5] AFTER: old-name in registry =', oldEntry);
      console.error('[EDGE-5] AFTER: new-name in registry =', newEntry?.name);
      expect(oldEntry).toBeNull();
      expect(newEntry).not.toBeNull();
      expect(newEntry!.name).toBe('new-name');

      // Verify response
      expect(data.old_name).toBe('old-name');
      expect(data.new_name).toBe('new-name');
    } finally {
      // Restore storage path
      state.config.defaultStoragePath = originalStoragePath;
    }
  });

  // -------------------------------------------------------------------------
  // Edge Case 6: Search No Matches
  // -------------------------------------------------------------------------
  it('6. search with non-matching query returns empty results', async () => {
    const registry = RegistryService.getInstance();

    // Register a database so registry isn't empty
    const filePath = createRealDb('some-db');
    registry.registerDatabase('some-db', filePath, 'A real database');

    console.error('[EDGE-6] BEFORE: database count =', registry.getDatabaseCount());

    const result = await databaseManagementTools.ocr_db_search.handler({
      query: 'xyznonexistent1234567890',
    });

    const parsed = parseResponse(result);
    const data = parsed.data as Record<string, unknown>;
    console.error('[EDGE-6] AFTER search: total_matches =', data.total_matches, ', databases =', JSON.stringify(data.databases));

    expect(data.total_matches).toBe(0);
    expect(Array.isArray(data.databases)).toBe(true);
    expect((data.databases as unknown[]).length).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Edge Case 7: Tag on Non-Existent Database
  // -------------------------------------------------------------------------
  it('7. tagging a non-existent database returns error', async () => {
    const registry = RegistryService.getInstance();

    console.error('[EDGE-7] BEFORE: database count =', registry.getDatabaseCount());
    console.error('[EDGE-7] BEFORE: attempting to tag "doesnt-exist"');

    const result = await databaseManagementTools.ocr_db_tag.handler({
      database_name: 'doesnt-exist',
      action: 'add',
      tags: ['x'],
    });

    console.error('[EDGE-7] AFTER: isError =', result.isError);
    expect(result.isError).toBe(true);

    // Verify no tags were inserted
    const conn = registry.getConnection();
    const row = conn.prepare("SELECT COUNT(*) as c FROM database_tags WHERE database_name = 'doesnt-exist'").get() as { c: number };
    console.error('[EDGE-7] AFTER: tag count for doesnt-exist =', row.c);
    expect(row.c).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Edge Case 8: Workspace with Database Deletion (CASCADE)
  // -------------------------------------------------------------------------
  it('8. unregistering a database removes it from workspace members (CASCADE)', () => {
    const registry = RegistryService.getInstance();

    // Register 3 databases
    for (const name of ['ws-db-1', 'ws-db-2', 'ws-db-3']) {
      const filePath = createRealDb(name);
      registry.registerDatabase(name, filePath);
    }

    // Create workspace and add all 3
    registry.createWorkspace('test-workspace', 'Edge case workspace');
    registry.addToWorkspace('test-workspace', 'ws-db-1');
    registry.addToWorkspace('test-workspace', 'ws-db-2');
    registry.addToWorkspace('test-workspace', 'ws-db-3');

    const conn = registry.getConnection();
    const beforeCount = (conn.prepare("SELECT COUNT(*) as c FROM workspace_members WHERE workspace_name = 'test-workspace'").get() as { c: number }).c;
    console.error('[EDGE-8] BEFORE: workspace member count =', beforeCount);
    expect(beforeCount).toBe(3);

    // Unregister one database (simulating deletion via CASCADE)
    registry.unregisterDatabase('ws-db-2');
    console.error('[EDGE-8] AFTER unregisterDatabase("ws-db-2")');

    const afterCount = (conn.prepare("SELECT COUNT(*) as c FROM workspace_members WHERE workspace_name = 'test-workspace'").get() as { c: number }).c;
    console.error('[EDGE-8] AFTER: workspace member count =', afterCount);
    expect(afterCount).toBe(2);

    // Verify the specific DB is gone from members
    const deletedMember = conn.prepare("SELECT 1 FROM workspace_members WHERE workspace_name = 'test-workspace' AND database_name = 'ws-db-2'").get();
    console.error('[EDGE-8] AFTER: ws-db-2 still a member =', deletedMember != null);
    expect(deletedMember).toBeUndefined();

    // Verify workspace still exists
    const ws = conn.prepare("SELECT 1 FROM workspaces WHERE name = 'test-workspace'").get();
    console.error('[EDGE-8] AFTER: workspace still exists =', ws != null);
    expect(ws).toBeTruthy();
  });

  // -------------------------------------------------------------------------
  // Edge Case 9: Access Tracking (recordAccess)
  // -------------------------------------------------------------------------
  it('9. recordAccess tracks counts and ordering correctly', () => {
    const registry = RegistryService.getInstance();

    // Register 2 databases
    for (const name of ['track-a', 'track-b']) {
      const filePath = createRealDb(name);
      registry.registerDatabase(name, filePath);
    }

    console.error('[EDGE-9] BEFORE: track-a access_count =', registry.getDatabase('track-a')?.access_count);
    console.error('[EDGE-9] BEFORE: track-b access_count =', registry.getDatabase('track-b')?.access_count);

    // Record accesses: A, B, A (3 total, A=2, B=1)
    registry.recordAccess('track-a', 'select');
    registry.recordAccess('track-b', 'select');
    registry.recordAccess('track-a', 'select');

    const conn = registry.getConnection();

    // Check access_count on each database
    const trackA = registry.getDatabase('track-a');
    const trackB = registry.getDatabase('track-b');
    console.error('[EDGE-9] AFTER: track-a access_count =', trackA?.access_count);
    console.error('[EDGE-9] AFTER: track-b access_count =', trackB?.access_count);
    expect(trackA?.access_count).toBe(2);
    expect(trackB?.access_count).toBe(1);

    // Check access_log total
    const logCount = (conn.prepare('SELECT COUNT(*) as c FROM access_log').get() as { c: number }).c;
    console.error('[EDGE-9] AFTER: access_log total =', logCount);
    expect(logCount).toBe(3);

    // getRecent should return track-a first (most recent access)
    const recent = registry.getRecent(10);
    console.error('[EDGE-9] AFTER: getRecent order =', recent.map(r => r.name));
    expect(recent.length).toBe(2);
    expect(recent[0].name).toBe('track-a');
  });

  // -------------------------------------------------------------------------
  // Edge Case 10: Empty Query Returns All Active
  // -------------------------------------------------------------------------
  it('10. empty query search returns only active databases (excludes archived)', () => {
    const registry = RegistryService.getInstance();

    // Create 4 databases: 3 active, 1 will be archived
    for (const name of ['active-1', 'active-2', 'active-3', 'to-archive']) {
      const filePath = createRealDb(name);
      registry.registerDatabase(name, filePath, `DB ${name}`);
    }
    console.error('[EDGE-10] BEFORE: total database count =', registry.getDatabaseCount());
    expect(registry.getDatabaseCount()).toBe(4);

    // Archive one
    registry.archive('to-archive');
    console.error('[EDGE-10] AFTER archive: to-archive status =', registry.getDatabase('to-archive')?.status);

    // Empty query search (default status = active)
    const results = registry.search('');
    console.error('[EDGE-10] AFTER search(""): result count =', results.length);
    console.error('[EDGE-10] AFTER search(""): names =', results.map(r => r.name));
    console.error('[EDGE-10] AFTER search(""): statuses =', results.map(r => r.status));

    expect(results.length).toBe(3);
    for (const r of results) {
      expect(r.status).toBe('active');
    }
    // Verify "to-archive" is NOT in results
    const archivedInResults = results.find(r => r.name === 'to-archive');
    expect(archivedInResults).toBeUndefined();
  });

});
