/**
 * Registry Type Definitions
 *
 * Pure data types for the database registry system.
 * No imports from other project files - these are standalone interfaces.
 */

/**
 * Core registry entry representing a tracked database
 */
export interface RegistryEntry {
  name: string;
  description: string | null;
  status: 'active' | 'archived';
  file_path: string;
  created_at: string;
  last_accessed_at: string | null;
  access_count: number;
  last_action: string | null;
  size_bytes: number;
  document_count: number;
  chunk_count: number;
  embedding_count: number;
  archive_reason: string | null;
  archived_at: string | null;
  profile_json: string | null;
}

/**
 * Registry entry with associated tags and metadata key-value pairs
 */
export interface RegistryEntryWithTags extends RegistryEntry {
  tags: string[];
  metadata: Record<string, string>;
}

/**
 * Filters for searching/listing registry entries
 */
export interface SearchFilters {
  tags?: string[];
  status?: 'active' | 'archived' | 'all';
  min_documents?: number;
  created_after?: string;
  created_before?: string;
  size_min_mb?: number;
  size_max_mb?: number;
  metadata?: Record<string, string>;
}

/**
 * Search result extending registry entry with match scoring
 */
export interface SearchResult extends RegistryEntryWithTags {
  match_score: number;
  match_reason: string;
}

/**
 * Workspace grouping multiple databases together
 */
export interface WorkspaceEntry {
  name: string;
  description: string | null;
  created_at: string;
  databases: string[];
}

/**
 * Statistics synced from individual databases into the registry
 */
export interface SyncStats {
  document_count: number;
  chunk_count: number;
  embedding_count: number;
  size_bytes: number;
}
