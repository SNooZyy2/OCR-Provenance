/**
 * RegistryService - Core database registry management
 *
 * Singleton service that manages a SQLite registry of all known OCR databases.
 * Provides CRUD, search (FTS5), tagging, metadata, archival, and reconciliation.
 */

import Database from 'better-sqlite3';
import { mkdirSync, existsSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { DatabaseError, DatabaseErrorCode } from '../database/types.js';
import type { RegistryEntry, RegistryEntryWithTags, SearchFilters, SearchResult, SyncStats } from './types.js';
import {
  REGISTRY_PRAGMAS,
  CREATE_DATABASES_TABLE,
  CREATE_DATABASE_TAGS_TABLE,
  CREATE_DATABASE_METADATA_KV_TABLE,
  CREATE_WORKSPACES_TABLE,
  CREATE_WORKSPACE_MEMBERS_TABLE,
  CREATE_ACCESS_LOG_TABLE,
  CREATE_ACCESS_LOG_INDEX,
  CREATE_DATABASES_FTS,
  TRIGGER_DATABASES_AI,
  TRIGGER_DATABASES_AU,
  TRIGGER_DATABASES_AD,
  TRIGGER_TAGS_AI,
  TRIGGER_TAGS_AD,
} from './schema.js';

let instance: RegistryService | null = null;

function defaultRegistryDir(): string {
  const dbPath = process.env.OCR_PROVENANCE_DATABASES_PATH;
  if (dbPath) {
    console.error(`[registry] Using OCR_PROVENANCE_DATABASES_PATH for registry dir: ${dbPath}`);
    return dbPath;
  }
  const defaultDir = join(homedir(), '.ocr-provenance');
  console.error(`[registry] Using default registry dir: ${defaultDir}`);
  return defaultDir;
}

export class RegistryService {
  private db: Database.Database;

  private constructor(registryDir: string) {
    const registryPath = join(registryDir, '_registry.db');
    console.error(`[registry] Initializing registry at: ${registryPath}`);
    try {
      mkdirSync(registryDir, { recursive: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[registry] FATAL: Cannot create registry directory ${registryDir}: ${msg}`);
      throw err;
    }
    try {
      this.db = new Database(registryPath);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[registry] FATAL: Cannot open registry database at ${registryPath}: ${msg}`);
      throw err;
    }
    this.initialize();
  }

  private initialize(): void {
    for (const pragma of REGISTRY_PRAGMAS) {
      this.db.pragma(pragma);
    }
    this.db.exec(CREATE_DATABASES_TABLE);
    this.db.exec(CREATE_DATABASE_TAGS_TABLE);
    this.db.exec(CREATE_DATABASE_METADATA_KV_TABLE);
    this.db.exec(CREATE_WORKSPACES_TABLE);
    this.db.exec(CREATE_WORKSPACE_MEMBERS_TABLE);
    this.db.exec(CREATE_ACCESS_LOG_TABLE);
    this.db.exec(CREATE_ACCESS_LOG_INDEX);
    this.db.exec(CREATE_DATABASES_FTS);
    this.db.exec(TRIGGER_DATABASES_AI);
    this.db.exec(TRIGGER_DATABASES_AU);
    this.db.exec(TRIGGER_DATABASES_AD);
    this.db.exec(TRIGGER_TAGS_AI);
    this.db.exec(TRIGGER_TAGS_AD);
  }

  static getInstance(registryDir?: string): RegistryService {
    if (!instance) {
      instance = new RegistryService(registryDir ?? defaultRegistryDir());
    }
    return instance;
  }

  static close(): void {
    if (instance) {
      try { instance.db.close(); } catch { /* already closed */ }
      instance = null;
    }
  }

  static resetForTesting(registryDir: string): RegistryService {
    RegistryService.close();
    instance = new RegistryService(registryDir);
    return instance;
  }

  getConnection(): Database.Database {
    return this.db;
  }

  getDatabaseCount(): number {
    const row = this.db.prepare('SELECT COUNT(*) as c FROM databases').get() as { c: number };
    return row.c;
  }

  private _attachTagsAndMetadata(entry: RegistryEntry): RegistryEntryWithTags {
    const tags = this.db
      .prepare('SELECT tag FROM database_tags WHERE database_name = ?')
      .all(entry.name) as { tag: string }[];
    const metaRows = this.db
      .prepare('SELECT key, value FROM database_metadata_kv WHERE database_name = ?')
      .all(entry.name) as { key: string; value: string }[];
    const metadata: Record<string, string> = {};
    for (const row of metaRows) metadata[row.key] = row.value;
    return { ...entry, tags: tags.map(r => r.tag), metadata };
  }

  private _assertExists(name: string): void {
    const row = this.db.prepare('SELECT 1 FROM databases WHERE name = ?').get(name);
    if (!row) {
      throw new DatabaseError(
        `Database '${name}' not found in registry`,
        DatabaseErrorCode.DATABASE_NOT_FOUND
      );
    }
  }

  private _safeFileSize(filePath: string): number {
    try { return statSync(filePath).size; } catch { return 0; }
  }

  registerDatabase(
    name: string,
    filePath: string,
    description?: string,
    tags?: string[],
    metadata?: Record<string, string>
  ): RegistryEntryWithTags {
    const sizeBytes = this._safeFileSize(filePath);
    const txn = this.db.transaction(() => {
      try {
        this.db.prepare(
          'INSERT INTO databases (name, file_path, description, size_bytes) VALUES (?, ?, ?, ?)'
        ).run(name, filePath, description ?? null, sizeBytes);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('UNIQUE constraint')) {
          throw new DatabaseError(
            `Database '${name}' already exists in registry`,
            DatabaseErrorCode.REGISTRY_ERROR, err
          );
        }
        throw err;
      }
      if (tags && tags.length > 0) {
        const ins = this.db.prepare(
          'INSERT OR IGNORE INTO database_tags (database_name, tag) VALUES (?, ?)'
        );
        for (const tag of tags) ins.run(name, tag);
      }
      if (metadata) {
        const ins = this.db.prepare(
          'INSERT OR REPLACE INTO database_metadata_kv (database_name, key, value) VALUES (?, ?, ?)'
        );
        for (const [key, value] of Object.entries(metadata)) ins.run(name, key, value);
      }
    });
    txn();
    return this.getDatabase(name)!;
  }

  unregisterDatabase(name: string): void {
    const result = this.db.prepare('DELETE FROM databases WHERE name = ?').run(name);
    if (result.changes === 0) {
      throw new DatabaseError(
        `Database '${name}' not found in registry`,
        DatabaseErrorCode.DATABASE_NOT_FOUND
      );
    }
  }

  getDatabase(name: string): RegistryEntryWithTags | null {
    const row = this.db
      .prepare('SELECT * FROM databases WHERE name = ?')
      .get(name) as RegistryEntry | undefined;
    if (!row) return null;
    return this._attachTagsAndMetadata(row);
  }

  updateDatabase(
    name: string,
    updates: Partial<Pick<RegistryEntry, 'description' | 'file_path' | 'profile_json' | 'status'>>
  ): void {
    const setClauses: string[] = [];
    const params: unknown[] = [];
    if (updates.description !== undefined) { setClauses.push('description = ?'); params.push(updates.description); }
    if (updates.file_path !== undefined) { setClauses.push('file_path = ?'); params.push(updates.file_path); }
    if (updates.profile_json !== undefined) { setClauses.push('profile_json = ?'); params.push(updates.profile_json); }
    if (updates.status !== undefined) { setClauses.push('status = ?'); params.push(updates.status); }
    if (setClauses.length === 0) return;
    params.push(name);
    const result = this.db
      .prepare(`UPDATE databases SET ${setClauses.join(', ')} WHERE name = ?`)
      .run(...params);
    if (result.changes === 0) {
      throw new DatabaseError(
        `Database '${name}' not found in registry`,
        DatabaseErrorCode.DATABASE_NOT_FOUND
      );
    }
  }

  recordAccess(name: string, action: string): void {
    try {
      const txn = this.db.transaction(() => {
        const result = this.db.prepare(
          `UPDATE databases SET last_accessed_at = datetime('now'),
           access_count = access_count + 1, last_action = ? WHERE name = ?`
        ).run(action, name);
        if (result.changes === 0) {
          console.error(`[registry] recordAccess: database '${name}' not found in registry, skipping`);
          return;
        }
        this.db.prepare(
          'INSERT INTO access_log (database_name, action) VALUES (?, ?)'
        ).run(name, action);
      });
      txn();
    } catch (err) {
      console.error(`[registry] recordAccess failed for '${name}':`, err instanceof Error ? err.message : String(err));
    }
  }

  search(query: string, filters?: SearchFilters): SearchResult[] {
    const effectiveFilters: SearchFilters = { status: 'active', ...filters };
    const whereClauses: string[] = [];
    const params: unknown[] = [];

    if (effectiveFilters.status && effectiveFilters.status !== 'all') {
      whereClauses.push('d.status = ?'); params.push(effectiveFilters.status);
    }
    if (effectiveFilters.min_documents !== undefined) {
      whereClauses.push('d.document_count >= ?'); params.push(effectiveFilters.min_documents);
    }
    if (effectiveFilters.created_after) {
      whereClauses.push('d.created_at >= ?'); params.push(effectiveFilters.created_after);
    }
    if (effectiveFilters.created_before) {
      whereClauses.push('d.created_at <= ?'); params.push(effectiveFilters.created_before);
    }
    if (effectiveFilters.size_min_mb !== undefined) {
      whereClauses.push('d.size_bytes >= ?'); params.push(effectiveFilters.size_min_mb * 1024 * 1024);
    }
    if (effectiveFilters.size_max_mb !== undefined) {
      whereClauses.push('d.size_bytes <= ?'); params.push(effectiveFilters.size_max_mb * 1024 * 1024);
    }

    let sql: string;
    let isFTS = false;
    if (query && query.trim().length > 0) {
      isFTS = true;
      const escaped = `"${query.replace(/"/g, '""')}"`;
      whereClauses.unshift('databases_fts MATCH ?');
      params.unshift(escaped);
      const whereSQL = `WHERE ${whereClauses.join(' AND ')}`;
      sql = `SELECT d.*, rank FROM databases d JOIN databases_fts f ON d.rowid = f.rowid ${whereSQL} ORDER BY rank`;
    } else {
      const whereSQL = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';
      sql = `SELECT d.* FROM databases d ${whereSQL} ORDER BY d.name`;
    }

    const rows = this.db.prepare(sql).all(...params) as (RegistryEntry & { rank?: number })[];
    let results: SearchResult[] = rows.map(row => {
      const { rank, ...entry } = row;
      const enriched = this._attachTagsAndMetadata(entry as RegistryEntry);
      return {
        ...enriched,
        match_score: isFTS ? Math.abs(rank ?? 0) : 1.0,
        match_reason: isFTS ? 'FTS match' : 'filter match',
      };
    });

    if (effectiveFilters.tags && effectiveFilters.tags.length > 0) {
      const requiredTags = new Set(effectiveFilters.tags);
      results = results.filter(r => r.tags.some(t => requiredTags.has(t)));
    }
    if (effectiveFilters.metadata) {
      const requiredMeta = effectiveFilters.metadata;
      results = results.filter(r =>
        Object.entries(requiredMeta).every(([k, v]) => r.metadata[k] === v)
      );
    }
    return results;
  }

  getRecent(limit: number): RegistryEntryWithTags[] {
    const rows = this.db.prepare(
      `SELECT * FROM databases WHERE last_accessed_at IS NOT NULL
       ORDER BY last_accessed_at DESC LIMIT ?`
    ).all(limit) as RegistryEntry[];
    return rows.map(r => this._attachTagsAndMetadata(r));
  }

  addTags(name: string, tags: string[]): void {
    this._assertExists(name);
    const txn = this.db.transaction(() => {
      const stmt = this.db.prepare(
        'INSERT OR IGNORE INTO database_tags (database_name, tag) VALUES (?, ?)'
      );
      for (const tag of tags) stmt.run(name, tag);
    });
    txn();
  }

  removeTags(name: string, tags: string[]): void {
    this._assertExists(name);
    const txn = this.db.transaction(() => {
      const stmt = this.db.prepare(
        'DELETE FROM database_tags WHERE database_name = ? AND tag = ?'
      );
      for (const tag of tags) stmt.run(name, tag);
    });
    txn();
  }

  setTags(name: string, tags: string[]): void {
    this._assertExists(name);
    const txn = this.db.transaction(() => {
      this.db.prepare('DELETE FROM database_tags WHERE database_name = ?').run(name);
      const stmt = this.db.prepare(
        'INSERT INTO database_tags (database_name, tag) VALUES (?, ?)'
      );
      for (const tag of tags) stmt.run(name, tag);
    });
    txn();
  }

  getTags(name: string): string[] {
    const rows = this.db
      .prepare('SELECT tag FROM database_tags WHERE database_name = ?')
      .all(name) as { tag: string }[];
    return rows.map(r => r.tag);
  }

  setMetadata(name: string, metadata: Record<string, string>): void {
    this._assertExists(name);
    const txn = this.db.transaction(() => {
      const stmt = this.db.prepare(
        'INSERT OR REPLACE INTO database_metadata_kv (database_name, key, value) VALUES (?, ?, ?)'
      );
      for (const [key, value] of Object.entries(metadata)) stmt.run(name, key, value);
    });
    txn();
  }

  getMetadata(name: string): Record<string, string> {
    const rows = this.db
      .prepare('SELECT key, value FROM database_metadata_kv WHERE database_name = ?')
      .all(name) as { key: string; value: string }[];
    const result: Record<string, string> = {};
    for (const row of rows) result[row.key] = row.value;
    return result;
  }

  archive(name: string, reason?: string): void {
    const row = this.db
      .prepare('SELECT status FROM databases WHERE name = ?')
      .get(name) as { status: string } | undefined;
    if (!row) {
      throw new DatabaseError(
        `Database '${name}' not found in registry`,
        DatabaseErrorCode.DATABASE_NOT_FOUND
      );
    }
    if (row.status === 'archived') {
      throw new DatabaseError(
        `Database '${name}' is already archived`,
        DatabaseErrorCode.DATABASE_ARCHIVED
      );
    }
    this.db.prepare(
      `UPDATE databases SET status = 'archived', archived_at = datetime('now'),
       archive_reason = ? WHERE name = ? AND status = 'active'`
    ).run(reason ?? null, name);
  }

  unarchive(name: string): void {
    const row = this.db
      .prepare('SELECT status FROM databases WHERE name = ?')
      .get(name) as { status: string } | undefined;
    if (!row) {
      throw new DatabaseError(
        `Database '${name}' not found in registry`,
        DatabaseErrorCode.DATABASE_NOT_FOUND
      );
    }
    if (row.status === 'active') {
      throw new DatabaseError(
        `Database '${name}' is already active`,
        DatabaseErrorCode.REGISTRY_ERROR
      );
    }
    this.db.prepare(
      `UPDATE databases SET status = 'active', archived_at = NULL,
       archive_reason = NULL WHERE name = ? AND status = 'archived'`
    ).run(name);
  }

  rename(oldName: string, newName: string): void {
    const txn = this.db.transaction(() => {
      this._assertExists(oldName);
      const conflict = this.db.prepare('SELECT 1 FROM databases WHERE name = ?').get(newName);
      if (conflict) {
        throw new DatabaseError(
          `Database '${newName}' already exists in registry`,
          DatabaseErrorCode.REGISTRY_ERROR
        );
      }
      // ON UPDATE CASCADE propagates to tags, metadata_kv, workspace_members
      this.db.prepare('UPDATE databases SET name = ? WHERE name = ?').run(newName, oldName);
    });
    txn();
  }

  syncStats(name: string, stats: SyncStats): void {
    try {
      const result = this.db.prepare(
        `UPDATE databases SET document_count = ?, chunk_count = ?,
         embedding_count = ?, size_bytes = ? WHERE name = ?`
      ).run(stats.document_count, stats.chunk_count, stats.embedding_count, stats.size_bytes, name);
      if (result.changes === 0) {
        console.error(`[registry] syncStats: database '${name}' not found in registry, skipping`);
      }
    } catch (err) {
      console.error(`[registry] syncStats failed for '${name}':`, err instanceof Error ? err.message : String(err));
    }
  }

  reconcile(databasesDir: string): { added: number; removed: number; updated: number } {
    if (!existsSync(databasesDir)) {
      console.error(`[registry] Databases directory does not exist: ${databasesDir}`);
      return { added: 0, removed: 0, updated: 0 };
    }

    let added = 0;
    let removed = 0;
    let updated = 0;

    const txn = this.db.transaction(() => {
      const files = readdirSync(databasesDir).filter(
        f => f.endsWith('.db') && f !== '_registry.db'
      );
      const fileSet = new Set(files.map(f => f.replace(/\.db$/, '')));
      const registered = this.db
        .prepare('SELECT name, file_path FROM databases')
        .all() as { name: string; file_path: string }[];
      const registeredNames = new Set(registered.map(r => r.name));

      // Register discovered .db files not yet in registry
      for (const file of files) {
        const name = file.replace(/\.db$/, '');
        if (registeredNames.has(name)) continue;
        const filePath = join(databasesDir, file);
        let description: string | null = null;
        try {
          const tempDb = new Database(filePath, { readonly: true });
          try {
            const metaRow = tempDb
              .prepare('SELECT database_name FROM database_metadata WHERE id = 1')
              .get() as { database_name: string } | undefined;
            if (metaRow?.database_name) {
              const colonIdx = metaRow.database_name.indexOf(':');
              if (colonIdx > 0) description = metaRow.database_name.substring(colonIdx + 1).trim() || null;
            }
          } catch { /* database_metadata table may not exist */ } finally { tempDb.close(); }
        } catch (err) {
          console.error(`[registry] Skipping corrupt or unreadable file: ${filePath}`, err);
          continue;
        }
        try {
          this.db.prepare(
            'INSERT INTO databases (name, file_path, description, size_bytes) VALUES (?, ?, ?, ?)'
          ).run(name, filePath, description, this._safeFileSize(filePath));
          added++;
        } catch (err) {
          console.error(`[registry] Failed to register discovered database '${name}':`, err);
        }
      }

      // Remove registry entries whose files no longer exist on disk
      for (const entry of registered) {
        if (!fileSet.has(entry.name)) {
          this.db.prepare('DELETE FROM databases WHERE name = ?').run(entry.name);
          removed++;
        }
      }

      // Update size_bytes for entries still on disk
      for (const entry of registered) {
        if (fileSet.has(entry.name)) {
          const filePath = join(databasesDir, `${entry.name}.db`);
          this.db.prepare('UPDATE databases SET size_bytes = ? WHERE name = ?')
            .run(this._safeFileSize(filePath), entry.name);
          updated++;
        }
      }
    });

    txn();
    console.error(`[registry] Reconcile complete: ${added} added, ${removed} removed, ${updated} updated`);
    return { added, removed, updated };
  }

  createWorkspace(name: string, description?: string): void {
    const existing = this.db.prepare('SELECT 1 FROM workspaces WHERE name = ?').get(name);
    if (existing) {
      throw new DatabaseError(
        `Workspace "${name}" already exists`,
        DatabaseErrorCode.WORKSPACE_ALREADY_EXISTS
      );
    }
    this.db.prepare('INSERT INTO workspaces (name, description) VALUES (?, ?)').run(name, description ?? null);
  }

  addToWorkspace(workspaceName: string, databaseName: string): void {
    const ws = this.db.prepare('SELECT 1 FROM workspaces WHERE name = ?').get(workspaceName);
    if (!ws) throw new DatabaseError(`Workspace "${workspaceName}" not found`, DatabaseErrorCode.WORKSPACE_NOT_FOUND);
    const db = this.db.prepare('SELECT 1 FROM databases WHERE name = ?').get(databaseName);
    if (!db) throw new DatabaseError(`Database "${databaseName}" not found in registry`, DatabaseErrorCode.DATABASE_NOT_FOUND);
    this.db.prepare('INSERT OR IGNORE INTO workspace_members (workspace_name, database_name) VALUES (?, ?)').run(workspaceName, databaseName);
  }

  removeFromWorkspace(workspaceName: string, databaseName: string): void {
    const result = this.db.prepare('DELETE FROM workspace_members WHERE workspace_name = ? AND database_name = ?').run(workspaceName, databaseName);
    if (result.changes === 0) {
      throw new DatabaseError(
        `Database "${databaseName}" is not a member of workspace "${workspaceName}"`,
        DatabaseErrorCode.REGISTRY_ERROR
      );
    }
  }

  deleteWorkspace(name: string): void {
    const result = this.db.prepare('DELETE FROM workspaces WHERE name = ?').run(name);
    if (result.changes === 0) {
      throw new DatabaseError(`Workspace "${name}" not found`, DatabaseErrorCode.WORKSPACE_NOT_FOUND);
    }
    // ON DELETE CASCADE handles workspace_members cleanup automatically
  }

  listWorkspaces(): Array<{ name: string; description: string | null; created_at: string }> {
    return this.db
      .prepare('SELECT name, description, created_at FROM workspaces ORDER BY name')
      .all() as Array<{ name: string; description: string | null; created_at: string }>;
  }

  getWorkspace(name: string): { name: string; description: string | null; created_at: string } | null {
    return (this.db
      .prepare('SELECT name, description, created_at FROM workspaces WHERE name = ?')
      .get(name) as { name: string; description: string | null; created_at: string } | undefined) ?? null;
  }

  getWorkspaceMembers(workspaceName: string): string[] | null {
    const ws = this.db
      .prepare('SELECT 1 FROM workspaces WHERE name = ?')
      .get(workspaceName);
    if (!ws) return null;
    const rows = this.db
      .prepare('SELECT database_name FROM workspace_members WHERE workspace_name = ?')
      .all(workspaceName) as { database_name: string }[];
    return rows.map(r => r.database_name);
  }

  getWorkspacesForDatabase(name: string): string[] {
    const rows = this.db
      .prepare('SELECT workspace_name FROM workspace_members WHERE database_name = ?')
      .all(name) as { workspace_name: string }[];
    return rows.map(r => r.workspace_name);
  }
}
