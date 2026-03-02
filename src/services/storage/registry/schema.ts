/**
 * Registry Schema DDL
 *
 * All DDL statements for the registry database as plain string constants.
 * These are used to initialize and maintain the registry SQLite database.
 */

/**
 * PRAGMA expressions for registry database initialization.
 * Applied in order on every connection open via db.pragma().
 * Values are pragma bodies without the PRAGMA keyword prefix.
 */
export const REGISTRY_PRAGMAS: string[] = [
  'journal_mode = WAL',
  'foreign_keys = ON',
  'synchronous = NORMAL',
  'busy_timeout = 5000',
];

/**
 * Main databases table - tracks all known OCR databases
 */
export const CREATE_DATABASES_TABLE = `CREATE TABLE IF NOT EXISTS databases (
  name TEXT PRIMARY KEY,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  file_path TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_accessed_at TEXT,
  access_count INTEGER NOT NULL DEFAULT 0,
  last_action TEXT,
  size_bytes INTEGER NOT NULL DEFAULT 0,
  document_count INTEGER NOT NULL DEFAULT 0,
  chunk_count INTEGER NOT NULL DEFAULT 0,
  embedding_count INTEGER NOT NULL DEFAULT 0,
  archive_reason TEXT,
  archived_at TEXT,
  profile_json TEXT
)`;

/**
 * Tags associated with databases (many-to-many via composite PK)
 */
export const CREATE_DATABASE_TAGS_TABLE = `CREATE TABLE IF NOT EXISTS database_tags (
  database_name TEXT NOT NULL,
  tag TEXT NOT NULL,
  PRIMARY KEY (database_name, tag),
  FOREIGN KEY (database_name) REFERENCES databases(name) ON DELETE CASCADE ON UPDATE CASCADE
)`;

/**
 * Arbitrary key-value metadata for databases
 */
export const CREATE_DATABASE_METADATA_KV_TABLE = `CREATE TABLE IF NOT EXISTS database_metadata_kv (
  database_name TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (database_name, key),
  FOREIGN KEY (database_name) REFERENCES databases(name) ON DELETE CASCADE ON UPDATE CASCADE
)`;

/**
 * Workspaces - named groups of databases
 */
export const CREATE_WORKSPACES_TABLE = `CREATE TABLE IF NOT EXISTS workspaces (
  name TEXT PRIMARY KEY,
  description TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
)`;

/**
 * Workspace membership - links databases to workspaces
 */
export const CREATE_WORKSPACE_MEMBERS_TABLE = `CREATE TABLE IF NOT EXISTS workspace_members (
  workspace_name TEXT NOT NULL,
  database_name TEXT NOT NULL,
  PRIMARY KEY (workspace_name, database_name),
  FOREIGN KEY (workspace_name) REFERENCES workspaces(name) ON DELETE CASCADE,
  FOREIGN KEY (database_name) REFERENCES databases(name) ON DELETE CASCADE ON UPDATE CASCADE
)`;

/**
 * Access log for tracking database usage patterns
 */
export const CREATE_ACCESS_LOG_TABLE = `CREATE TABLE IF NOT EXISTS access_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  database_name TEXT NOT NULL,
  action TEXT NOT NULL,
  accessed_at TEXT NOT NULL DEFAULT (datetime('now'))
)`;

/**
 * Index for efficient access log queries by database and time
 */
export const CREATE_ACCESS_LOG_INDEX = `CREATE INDEX IF NOT EXISTS idx_access_log_db_time ON access_log(database_name, accessed_at DESC)`;

/**
 * FTS5 virtual table for full-text search across database names, descriptions, and tags
 */
export const CREATE_DATABASES_FTS = `CREATE VIRTUAL TABLE IF NOT EXISTS databases_fts USING fts5(name, description, tags, tokenize='porter unicode61')`;

/**
 * Trigger: after inserting a database, populate FTS index
 */
export const TRIGGER_DATABASES_AI = `CREATE TRIGGER IF NOT EXISTS databases_ai AFTER INSERT ON databases BEGIN
  INSERT INTO databases_fts(rowid, name, description, tags)
  VALUES (NEW.rowid, NEW.name, COALESCE(NEW.description, ''), '');
END`;

/**
 * Trigger: after updating a database, refresh FTS index with aggregated tags
 */
export const TRIGGER_DATABASES_AU = `CREATE TRIGGER IF NOT EXISTS databases_au AFTER UPDATE ON databases BEGIN
  DELETE FROM databases_fts WHERE rowid = OLD.rowid;
  INSERT INTO databases_fts(rowid, name, description, tags)
  VALUES (NEW.rowid, NEW.name, COALESCE(NEW.description, ''),
    COALESCE((SELECT GROUP_CONCAT(tag, ' ') FROM database_tags WHERE database_name = NEW.name), ''));
END`;

/**
 * Trigger: after deleting a database, remove from FTS index
 */
export const TRIGGER_DATABASES_AD = `CREATE TRIGGER IF NOT EXISTS databases_ad AFTER DELETE ON databases BEGIN
  DELETE FROM databases_fts WHERE rowid = OLD.rowid;
END`;

/**
 * Trigger: after inserting a tag, fire database UPDATE trigger to refresh FTS tags
 */
export const TRIGGER_TAGS_AI = `CREATE TRIGGER IF NOT EXISTS tags_ai AFTER INSERT ON database_tags BEGIN
  UPDATE databases SET name = name WHERE name = NEW.database_name;
END`;

/**
 * Trigger: after deleting a tag, fire database UPDATE trigger to refresh FTS tags
 */
export const TRIGGER_TAGS_AD = `CREATE TRIGGER IF NOT EXISTS tags_ad AFTER DELETE ON database_tags BEGIN
  UPDATE databases SET name = name WHERE name = OLD.database_name;
END`;
