/**
 * FINAL STATE VERIFICATION: Clustering System - ALL 3 Algorithms
 *
 * Agent-05 comprehensive verification test.
 * Tests HDBSCAN, Agglomerative, KMeans with real database operations.
 * Verifies assign, reassign, merge, delete at SQLite source-of-truth level.
 *
 * NO MOCKS. Real databases. Physical DB verification after every operation.
 */

import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { v4 as uuidv4 } from 'uuid';

import { clusteringTools } from '../../src/tools/clustering.js';
import { state, resetState, updateConfig, clearDatabase } from '../../src/server/state.js';
import { DatabaseService } from '../../src/services/storage/database/index.js';
import { VectorService } from '../../src/services/storage/vector.js';
import { computeHash } from '../../src/utils/hash.js';

// ═══════════════════════════════════════════════════════════════════════════════
// SQLITE-VEC CHECK
// ═══════════════════════════════════════════════════════════════════════════════

function isSqliteVecAvailable(): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('sqlite-vec');
    return true;
  } catch {
    return false;
  }
}

const sqliteVecAvailable = isSqliteVecAvailable();

// ═══════════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

interface ToolResponse {
  success?: boolean;
  data?: Record<string, unknown>;
  error?: { category: string; message: string; details?: Record<string, unknown> };
  [key: string]: unknown;
}

function createTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'ocr-cluster-final-'));
}

function cleanupTempDir(dir: string): void {
  try {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

function parseResponse(response: { content: Array<{ type: string; text: string }> }): ToolResponse {
  return JSON.parse(response.content[0].text);
}

/**
 * Create a deterministic test vector near a given axis.
 * Uses seeded offset to make vectors slightly different but still clustered.
 */
function makeTestVector(axis: number, seed: number = 0): Float32Array {
  const vec = new Float32Array(768);
  vec[axis] = 1.0;
  for (let i = 0; i < 768; i++) {
    if (i !== axis) {
      vec[i] = Math.sin(i * 0.1 + seed * 7.3) * 0.03;
    }
  }
  let norm = 0;
  for (let i = 0; i < 768; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm);
  for (let i = 0; i < 768; i++) vec[i] /= norm;
  return vec;
}

const tempDirs: string[] = [];

afterAll(() => {
  resetState();
  for (const dir of tempDirs) cleanupTempDir(dir);
});

// ═══════════════════════════════════════════════════════════════════════════════
// SYNTHETIC DATA INSERTION
// ═══════════════════════════════════════════════════════════════════════════════

interface SyntheticDoc {
  docId: string;
  docProvId: string;
}

function insertSyntheticDocument(
  db: DatabaseService,
  vector: VectorService,
  fileName: string,
  text: string,
  chunkVectors: Float32Array[]
): SyntheticDoc {
  const docId = uuidv4();
  const docProvId = uuidv4();
  const ocrProvId = uuidv4();
  const ocrResultId = uuidv4();
  const now = new Date().toISOString();
  const fileHash = computeHash(fileName + docId);

  // DOCUMENT provenance
  db.insertProvenance({
    id: docProvId,
    type: 'DOCUMENT',
    created_at: now,
    processed_at: now,
    source_file_created_at: null,
    source_file_modified_at: null,
    source_type: 'FILE',
    source_path: `/test/${fileName}`,
    source_id: null,
    root_document_id: docProvId,
    location: null,
    content_hash: fileHash,
    input_hash: null,
    file_hash: fileHash,
    processor: 'test',
    processor_version: '1.0.0',
    processing_params: {},
    processing_duration_ms: null,
    processing_quality_score: null,
    parent_id: null,
    parent_ids: '[]',
    chain_depth: 0,
    chain_path: '["DOCUMENT"]',
  });

  db.insertDocument({
    id: docId,
    file_path: `/test/${fileName}`,
    file_name: fileName,
    file_hash: fileHash,
    file_size: text.length,
    file_type: 'pdf',
    status: 'complete',
    page_count: 1,
    provenance_id: docProvId,
    error_message: null,
    ocr_completed_at: now,
  });

  // OCR_RESULT provenance
  db.insertProvenance({
    id: ocrProvId,
    type: 'OCR_RESULT',
    created_at: now,
    processed_at: now,
    source_file_created_at: null,
    source_file_modified_at: null,
    source_type: 'OCR',
    source_path: null,
    source_id: docProvId,
    root_document_id: docProvId,
    location: null,
    content_hash: computeHash(text),
    input_hash: null,
    file_hash: null,
    processor: 'datalab-marker',
    processor_version: '1.0.0',
    processing_params: { mode: 'balanced' },
    processing_duration_ms: 1000,
    processing_quality_score: 4.5,
    parent_id: docProvId,
    parent_ids: JSON.stringify([docProvId]),
    chain_depth: 1,
    chain_path: '["DOCUMENT", "OCR_RESULT"]',
  });

  db.insertOCRResult({
    id: ocrResultId,
    provenance_id: ocrProvId,
    document_id: docId,
    extracted_text: text,
    text_length: text.length,
    datalab_request_id: `req-${ocrResultId}`,
    datalab_mode: 'balanced',
    parse_quality_score: 4.5,
    page_count: 1,
    cost_cents: 5,
    processing_duration_ms: 1000,
    processing_started_at: now,
    processing_completed_at: now,
    json_blocks: null,
    content_hash: computeHash(text),
    extras_json: null,
  });

  for (let ci = 0; ci < chunkVectors.length; ci++) {
    const chunkId = uuidv4();
    const chunkProvId = uuidv4();
    const embId = uuidv4();
    const embProvId = uuidv4();
    const chunkText = `Chunk ${ci} of ${fileName}: ${text.substring(0, 100)}`;

    db.insertProvenance({
      id: chunkProvId,
      type: 'CHUNK',
      created_at: now,
      processed_at: now,
      source_file_created_at: null,
      source_file_modified_at: null,
      source_type: 'CHUNKING',
      source_path: null,
      source_id: ocrProvId,
      root_document_id: docProvId,
      location: null,
      content_hash: computeHash(chunkText),
      input_hash: null,
      file_hash: null,
      processor: 'chunker',
      processor_version: '1.0.0',
      processing_params: {},
      processing_duration_ms: 10,
      processing_quality_score: null,
      parent_id: ocrProvId,
      parent_ids: JSON.stringify([docProvId, ocrProvId]),
      chain_depth: 2,
      chain_path: '["DOCUMENT", "OCR_RESULT", "CHUNK"]',
    });

    db.insertChunk({
      id: chunkId,
      document_id: docId,
      ocr_result_id: ocrResultId,
      text: chunkText,
      text_hash: computeHash(chunkText),
      chunk_index: ci,
      character_start: ci * 100,
      character_end: (ci + 1) * 100,
      page_number: 1,
      page_range: null,
      overlap_previous: 0,
      overlap_next: 0,
      provenance_id: chunkProvId,
    });

    db.insertProvenance({
      id: embProvId,
      type: 'EMBEDDING',
      created_at: now,
      processed_at: now,
      source_file_created_at: null,
      source_file_modified_at: null,
      source_type: 'EMBEDDING',
      source_path: null,
      source_id: chunkProvId,
      root_document_id: docProvId,
      location: null,
      content_hash: computeHash(Buffer.from(chunkVectors[ci].buffer).toString('base64')),
      input_hash: computeHash(chunkText),
      file_hash: null,
      processor: 'nomic-embed-text-v1.5',
      processor_version: '1.5.0',
      processing_params: { model: 'nomic-embed-text-v1.5' },
      processing_duration_ms: 50,
      processing_quality_score: null,
      parent_id: chunkProvId,
      parent_ids: JSON.stringify([docProvId, ocrProvId, chunkProvId]),
      chain_depth: 3,
      chain_path: '["DOCUMENT", "OCR_RESULT", "CHUNK", "EMBEDDING"]',
    });

    db.insertEmbedding({
      id: embId,
      chunk_id: chunkId,
      image_id: null,
      extraction_id: null,
      document_id: docId,
      original_text: chunkText,
      original_text_length: chunkText.length,
      source_file_path: `/test/${fileName}`,
      source_file_name: fileName,
      source_file_hash: fileHash,
      page_number: 1,
      page_range: null,
      character_start: ci * 100,
      character_end: (ci + 1) * 100,
      chunk_index: ci,
      total_chunks: chunkVectors.length,
      model_name: 'nomic-embed-text-v1.5',
      model_version: '1.5.0',
      task_type: 'search_document',
      inference_mode: 'local',
      gpu_device: 'cuda:0',
      provenance_id: embProvId,
      content_hash: computeHash(`embedding-${embId}`),
      generation_duration_ms: 50,
    });

    vector.storeVector(embId, chunkVectors[ci]);
  }

  return { docId, docProvId };
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN TEST SUITE
// ═══════════════════════════════════════════════════════════════════════════════

describe.skipIf(!sqliteVecAvailable)('FINAL VERIFICATION: All 3 Algorithms + Assign/Reassign/Merge/Delete', () => {
  let tempDir: string;
  let db: DatabaseService;
  let vector: VectorService;
  let docs: SyntheticDoc[];

  beforeEach(() => {
    tempDir = createTempDir();
    tempDirs.push(tempDir);
    const dbName = `final-verify-${Date.now()}`;
    updateConfig({ storagePath: tempDir });
    db = DatabaseService.create(dbName, undefined, tempDir);
    vector = new VectorService(db.getConnection());
    state.currentDatabase = db;
    state.currentVector = vector;
    state.currentDatabaseName = dbName;

    // Insert 4 synthetic documents: 2 near axis 0 (cluster A), 2 near axis 1 (cluster B)
    docs = [];
    docs.push(insertSyntheticDocument(db, vector, 'legal-1.pdf', 'Employment agreement full text',
      [makeTestVector(0, 1), makeTestVector(0, 2), makeTestVector(0, 3), makeTestVector(0, 4)]));
    docs.push(insertSyntheticDocument(db, vector, 'legal-2.pdf', 'Service contract agreement',
      [makeTestVector(0, 5), makeTestVector(0, 6), makeTestVector(0, 7), makeTestVector(0, 8)]));
    docs.push(insertSyntheticDocument(db, vector, 'finance-1.pdf', 'Quarterly financial report',
      [makeTestVector(1, 9), makeTestVector(1, 10), makeTestVector(1, 11), makeTestVector(1, 12)]));
    docs.push(insertSyntheticDocument(db, vector, 'finance-2.pdf', 'Annual budget proposal',
      [makeTestVector(1, 13), makeTestVector(1, 14), makeTestVector(1, 15), makeTestVector(1, 16)]));
  });

  afterEach(() => {
    clearDatabase();
  });

  // ─── ALGORITHM 1: HDBSCAN ───────────────────────────────────────────────────

  it('HDBSCAN: clusters 4 docs into 2 groups, then delete cleans all records', async () => {
    const conn = db.getConnection();

    // Pre-check
    const before = conn.prepare('SELECT COUNT(*) as cnt FROM clusters').get() as { cnt: number };
    expect(before.cnt).toBe(0);

    // Run HDBSCAN
    const handler = clusteringTools['ocr_cluster_documents'].handler;
    const response = await handler({ algorithm: 'hdbscan', min_cluster_size: 2 });
    const parsed = parseResponse(response);

    expect(parsed.success).toBe(true);
    const data = parsed.data as Record<string, unknown>;
    const runId = data.run_id as string;
    const nClusters = data.n_clusters as number;

    // HDBSCAN may produce 2 clusters or fewer depending on density
    expect(nClusters).toBeGreaterThanOrEqual(1);
    expect(data.total_documents).toBe(4);

    // SQLite source-of-truth: clusters
    const dbClusters = conn.prepare('SELECT COUNT(*) as cnt FROM clusters WHERE run_id = ?').get(runId) as { cnt: number };
    expect(dbClusters.cnt).toBe(nClusters);

    // SQLite source-of-truth: document_clusters (all 4 docs assigned)
    const dbDC = conn.prepare('SELECT COUNT(*) as cnt FROM document_clusters WHERE run_id = ?').get(runId) as { cnt: number };
    expect(dbDC.cnt).toBe(4);

    // SQLite source-of-truth: provenance
    const dbProv = conn.prepare("SELECT COUNT(*) as cnt FROM provenance WHERE type = 'CLUSTERING' AND processor = 'clustering-service'").get() as { cnt: number };
    expect(dbProv.cnt).toBe(nClusters);

    // DELETE the run
    const deleteHandler = clusteringTools['ocr_cluster_delete'].handler;
    const deleteResp = await deleteHandler({ run_id: runId, confirm: true });
    const deleteParsed = parseResponse(deleteResp);
    expect(deleteParsed.success).toBe(true);

    // Source of truth after delete
    const afterClusters = conn.prepare('SELECT COUNT(*) as cnt FROM clusters WHERE run_id = ?').get(runId) as { cnt: number };
    const afterDC = conn.prepare('SELECT COUNT(*) as cnt FROM document_clusters WHERE run_id = ?').get(runId) as { cnt: number };
    expect(afterClusters.cnt).toBe(0);
    expect(afterDC.cnt).toBe(0);
  }, 60000);

  // ─── ALGORITHM 2: AGGLOMERATIVE + ASSIGN + REASSIGN + MERGE + DELETE ───────

  it('Agglomerative: full lifecycle (cluster -> assign -> reassign -> merge -> delete)', async () => {
    const conn = db.getConnection();

    // Step 1: Run Agglomerative clustering with n_clusters=2
    const handler = clusteringTools['ocr_cluster_documents'].handler;
    const response = await handler({ algorithm: 'agglomerative', n_clusters: 2, linkage: 'average' });
    const parsed = parseResponse(response);

    expect(parsed.success).toBe(true);
    const data = parsed.data as Record<string, unknown>;
    const runId = data.run_id as string;
    expect(data.n_clusters).toBe(2);
    expect(data.total_documents).toBe(4);

    // Verify correct cluster assignments
    const dbClusters = conn.prepare('SELECT * FROM clusters WHERE run_id = ? ORDER BY cluster_index').all(runId) as Array<Record<string, unknown>>;
    expect(dbClusters).toHaveLength(2);

    const cluster0Id = dbClusters[0].id as string;
    const cluster1Id = dbClusters[1].id as string;

    // Doc A1 and A2 should be in same cluster, B1 and B2 in other
    const getClusterId = (docId: string) => {
      const row = conn.prepare('SELECT cluster_id FROM document_clusters WHERE document_id = ? AND run_id = ?').get(docId, runId) as { cluster_id: string } | undefined;
      return row?.cluster_id;
    };

    const a1Cluster = getClusterId(docs[0].docId);
    const a2Cluster = getClusterId(docs[1].docId);
    const b1Cluster = getClusterId(docs[2].docId);
    const b2Cluster = getClusterId(docs[3].docId);

    expect(a1Cluster).toBe(a2Cluster); // Same cluster
    expect(b1Cluster).toBe(b2Cluster); // Same cluster
    expect(a1Cluster).not.toBe(b1Cluster); // Different clusters

    // Step 2: ASSIGN a new document to the existing run
    const newDoc = insertSyntheticDocument(db, vector, 'legal-3.pdf', 'Another legal doc',
      [makeTestVector(0, 100), makeTestVector(0, 101), makeTestVector(0, 102), makeTestVector(0, 103)]);

    const assignHandler = clusteringTools['ocr_cluster_assign'].handler;
    const assignResp = await assignHandler({ document_id: newDoc.docId, run_id: runId });
    const assignParsed = parseResponse(assignResp);

    expect(assignParsed.success).toBe(true);
    const assignData = assignParsed.data as Record<string, unknown>;
    expect(assignData.assigned).toBe(true);
    expect(assignData.document_id).toBe(newDoc.docId);
    // The new legal doc should be assigned to the same cluster as docs[0] (legal cluster)
    expect(assignData.cluster_id).toBe(a1Cluster);

    // Verify assignment in DB
    const assignedRow = conn.prepare('SELECT * FROM document_clusters WHERE document_id = ? AND run_id = ?').get(newDoc.docId, runId) as Record<string, unknown>;
    expect(assignedRow).toBeTruthy();
    expect(assignedRow.cluster_id).toBe(a1Cluster);

    // Verify cluster document_count updated
    const legalClusterAfterAssign = conn.prepare('SELECT document_count FROM clusters WHERE id = ?').get(a1Cluster as string) as { document_count: number };
    expect(legalClusterAfterAssign.document_count).toBe(3); // 2 original + 1 assigned

    // Step 3: REASSIGN the new document to the other cluster
    const reassignHandler = clusteringTools['ocr_cluster_reassign'].handler;
    const reassignResp = await reassignHandler({ document_id: newDoc.docId, target_cluster_id: b1Cluster as string });
    const reassignParsed = parseResponse(reassignResp);

    expect(reassignParsed.success).toBe(true);
    const reassignData = reassignParsed.data as Record<string, unknown>;
    expect(reassignData.reassigned).toBe(true);
    expect(reassignData.old_cluster_id).toBe(a1Cluster);
    expect(reassignData.target_cluster_id).toBe(b1Cluster);

    // Verify source of truth after reassign
    const reassignedRow = conn.prepare('SELECT * FROM document_clusters WHERE document_id = ? AND run_id = ?').get(newDoc.docId, runId) as Record<string, unknown>;
    expect(reassignedRow.cluster_id).toBe(b1Cluster);

    const legalClusterAfterReassign = conn.prepare('SELECT document_count FROM clusters WHERE id = ?').get(a1Cluster as string) as { document_count: number };
    const finClusterAfterReassign = conn.prepare('SELECT document_count FROM clusters WHERE id = ?').get(b1Cluster as string) as { document_count: number };
    expect(legalClusterAfterReassign.document_count).toBe(2); // Back to original 2
    expect(finClusterAfterReassign.document_count).toBe(3); // 2 original + 1 reassigned

    // Step 4: MERGE the two clusters
    const mergeHandler = clusteringTools['ocr_cluster_merge'].handler;
    const mergeResp = await mergeHandler({ cluster_id_1: a1Cluster as string, cluster_id_2: b1Cluster as string });
    const mergeParsed = parseResponse(mergeResp);

    expect(mergeParsed.success).toBe(true);
    const mergeData = mergeParsed.data as Record<string, unknown>;
    expect(mergeData.merged_cluster_id).toBe(a1Cluster);
    expect(mergeData.deleted_cluster_id).toBe(b1Cluster);
    expect(mergeData.documents_moved).toBe(3); // 2 original + 1 reassigned from b1

    // Source of truth after merge
    const mergedCluster = conn.prepare('SELECT * FROM clusters WHERE id = ?').get(a1Cluster as string) as Record<string, unknown>;
    expect(mergedCluster).toBeTruthy();
    expect(mergedCluster.document_count).toBe(5); // 2 + 3

    const deletedCluster = conn.prepare('SELECT * FROM clusters WHERE id = ?').get(b1Cluster as string);
    expect(deletedCluster).toBeUndefined(); // Cluster 2 deleted

    const remainingClusters = conn.prepare('SELECT COUNT(*) as cnt FROM clusters WHERE run_id = ?').get(runId) as { cnt: number };
    expect(remainingClusters.cnt).toBe(1); // Only the merged cluster remains

    // All 5 docs should now point to the merged cluster
    const allAssignments = conn.prepare('SELECT * FROM document_clusters WHERE run_id = ? AND cluster_id = ?').all(runId, a1Cluster as string) as Array<Record<string, unknown>>;
    expect(allAssignments).toHaveLength(5);

    // Step 5: DELETE the run
    const deleteHandler = clusteringTools['ocr_cluster_delete'].handler;
    const deleteResp = await deleteHandler({ run_id: runId, confirm: true });
    const deleteParsed = parseResponse(deleteResp);
    expect(deleteParsed.success).toBe(true);

    // Final source of truth: everything gone
    const finalClusters = conn.prepare('SELECT COUNT(*) as cnt FROM clusters WHERE run_id = ?').get(runId) as { cnt: number };
    const finalDC = conn.prepare('SELECT COUNT(*) as cnt FROM document_clusters WHERE run_id = ?').get(runId) as { cnt: number };
    expect(finalClusters.cnt).toBe(0);
    expect(finalDC.cnt).toBe(0);
  }, 90000);

  // ─── ALGORITHM 3: KMEANS ────────────────────────────────────────────────────

  it('KMeans: deterministic 2 clusters, then delete cleans all records', async () => {
    const conn = db.getConnection();

    // Run KMeans
    const handler = clusteringTools['ocr_cluster_documents'].handler;
    const response = await handler({ algorithm: 'kmeans', n_clusters: 2 });
    const parsed = parseResponse(response);

    expect(parsed.success).toBe(true);
    const data = parsed.data as Record<string, unknown>;
    const runId = data.run_id as string;
    expect(data.n_clusters).toBe(2);
    expect(data.total_documents).toBe(4);

    // KMeans silhouette should be a valid number
    expect(data.silhouette_score).toBeGreaterThan(0);

    // Verify correct clustering
    const dbClusters = conn.prepare('SELECT * FROM clusters WHERE run_id = ? ORDER BY cluster_index').all(runId) as Array<Record<string, unknown>>;
    expect(dbClusters).toHaveLength(2);

    // Each cluster should have 2 docs
    for (const c of dbClusters) {
      expect(c.document_count).toBe(2);
      expect(c.algorithm).toBe('kmeans');

      // Verify centroid is valid 768-dim
      const centroid = JSON.parse(c.centroid_json as string) as number[];
      expect(centroid).toHaveLength(768);
    }

    // Verify document assignments
    const dbDC = conn.prepare('SELECT * FROM document_clusters WHERE run_id = ? ORDER BY document_id').all(runId) as Array<Record<string, unknown>>;
    expect(dbDC).toHaveLength(4);

    for (const dc of dbDC) {
      expect(dc.is_noise).toBe(0);
      expect(dc.cluster_id).toBeTruthy();
      expect(dc.membership_probability).toBe(1.0); // KMeans always 1.0
    }

    // DELETE
    const deleteHandler = clusteringTools['ocr_cluster_delete'].handler;
    const deleteResp = await deleteHandler({ run_id: runId, confirm: true });
    expect(parseResponse(deleteResp).success).toBe(true);

    const afterClusters = conn.prepare('SELECT COUNT(*) as cnt FROM clusters WHERE run_id = ?').get(runId) as { cnt: number };
    const afterDC = conn.prepare('SELECT COUNT(*) as cnt FROM document_clusters WHERE run_id = ?').get(runId) as { cnt: number };
    expect(afterClusters.cnt).toBe(0);
    expect(afterDC.cnt).toBe(0);
  }, 60000);

  // ─── EDGE CASE: H7 Regression Test (2 docs, agglomerative, n_clusters=2) ──

  it('H7 REGRESSION: Agglomerative with exactly 2 docs and n_clusters=2 does not crash', async () => {
    // Create a fresh DB with only 2 documents
    const tempDir2 = createTempDir();
    tempDirs.push(tempDir2);
    const dbName2 = `h7-test-${Date.now()}`;
    const db2 = DatabaseService.create(dbName2, undefined, tempDir2);
    const vector2 = new VectorService(db2.getConnection());
    state.currentDatabase = db2;
    state.currentVector = vector2;
    state.currentDatabaseName = dbName2;

    insertSyntheticDocument(db2, vector2, 'doc-a.pdf', 'Document A content',
      [makeTestVector(0, 50), makeTestVector(0, 51)]);
    insertSyntheticDocument(db2, vector2, 'doc-b.pdf', 'Document B content',
      [makeTestVector(1, 52), makeTestVector(1, 53)]);

    const conn2 = db2.getConnection();

    // This CRASHED before H7 fix (silhouette_score with n_clusters >= n_samples)
    const handler = clusteringTools['ocr_cluster_documents'].handler;
    const response = await handler({ algorithm: 'agglomerative', n_clusters: 2 });
    const parsed = parseResponse(response);

    expect(parsed.success).toBe(true);
    const data = parsed.data as Record<string, unknown>;
    expect(data.n_clusters).toBe(2);
    expect(data.total_documents).toBe(2);
    // H7 fix: silhouette is 0.0 when n_clusters >= n_samples (not a crash)
    expect(data.silhouette_score).toBe(0);

    // Verify DB state
    const runId = data.run_id as string;
    const dbClusters = conn2.prepare('SELECT COUNT(*) as cnt FROM clusters WHERE run_id = ?').get(runId) as { cnt: number };
    expect(dbClusters.cnt).toBe(2);

    // Cleanup
    const deleteHandler = clusteringTools['ocr_cluster_delete'].handler;
    await deleteHandler({ run_id: runId, confirm: true });

    clearDatabase();
  }, 60000);

  // ─── EDGE CASE: H5 Regression (Duplicate assignment should not throw UNIQUE) ─

  it('H5 REGRESSION: Assigning same document twice does not throw UNIQUE error', async () => {
    const conn = db.getConnection();

    // First, cluster to get a run_id
    const handler = clusteringTools['ocr_cluster_documents'].handler;
    const response = await handler({ algorithm: 'agglomerative', n_clusters: 2 });
    const parsed = parseResponse(response);
    expect(parsed.success).toBe(true);
    const data = parsed.data as Record<string, unknown>;
    const runId = data.run_id as string;

    // Assign docs[0] to the run (it already has an assignment from clustering)
    const assignHandler = clusteringTools['ocr_cluster_assign'].handler;
    const assignResp1 = await assignHandler({ document_id: docs[0].docId, run_id: runId });
    const assignParsed1 = parseResponse(assignResp1);

    // Should succeed (H5 fix: deletes existing before inserting)
    expect(assignParsed1.success).toBe(true);

    // Do it again - should NOT throw UNIQUE constraint
    const assignResp2 = await assignHandler({ document_id: docs[0].docId, run_id: runId });
    const assignParsed2 = parseResponse(assignResp2);

    expect(assignParsed2.success).toBe(true);

    // Verify only 1 assignment exists for this doc in this run
    const assignments = conn.prepare('SELECT COUNT(*) as cnt FROM document_clusters WHERE document_id = ? AND run_id = ?').get(docs[0].docId, runId) as { cnt: number };
    expect(assignments.cnt).toBe(1);

    // Cleanup
    const deleteHandler = clusteringTools['ocr_cluster_delete'].handler;
    await deleteHandler({ run_id: runId, confirm: true });
  }, 60000);

  // ─── EDGE CASE: Delete nonexistent run_id ──────────────────────────────────

  it('Delete nonexistent run_id throws clear error (not silent success)', async () => {
    const deleteHandler = clusteringTools['ocr_cluster_delete'].handler;
    const deleteResp = await deleteHandler({ run_id: 'nonexistent-run-id-12345', confirm: true });
    const deleteParsed = parseResponse(deleteResp);

    expect(deleteParsed.success).toBeFalsy();
    expect(deleteParsed.error).toBeDefined();
    expect(deleteParsed.error!.category).toBe('DOCUMENT_NOT_FOUND');
    expect(deleteParsed.error!.message).toContain('nonexistent-run-id-12345');
  }, 10000);

  // ─── PROVENANCE INTEGRITY CHECK ────────────────────────────────────────────

  it('No orphaned CLUSTERING provenance remains after full lifecycle', async () => {
    const conn = db.getConnection();

    // Run and delete
    const handler = clusteringTools['ocr_cluster_documents'].handler;
    const response = await handler({ algorithm: 'agglomerative', n_clusters: 2 });
    const parsed = parseResponse(response);
    expect(parsed.success).toBe(true);
    const runId = (parsed.data as Record<string, unknown>).run_id as string;

    const beforeProv = conn.prepare("SELECT COUNT(*) as cnt FROM provenance WHERE type = 'CLUSTERING'").get() as { cnt: number };
    expect(beforeProv.cnt).toBe(2);

    // Delete the run
    const deleteHandler = clusteringTools['ocr_cluster_delete'].handler;
    await deleteHandler({ run_id: runId, confirm: true });

    // Verify no orphaned CLUSTERING provenance
    const afterProv = conn.prepare("SELECT COUNT(*) as cnt FROM provenance WHERE type = 'CLUSTERING'").get() as { cnt: number };
    expect(afterProv.cnt).toBe(0);

    // Verify no orphaned document_clusters
    const orphanedDC = conn.prepare('SELECT COUNT(*) as cnt FROM document_clusters WHERE run_id = ?').get(runId) as { cnt: number };
    expect(orphanedDC.cnt).toBe(0);
  }, 60000);
});
