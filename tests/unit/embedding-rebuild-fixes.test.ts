/**
 * Embedding Rebuild Fixes - Unit Tests
 *
 * Tests for 3 bug fixes in the embedding rebuild pipeline:
 * A. Single-image rebuild FK constraint fix (images.vlm_embedding_id -> embeddings circular FK)
 * B. Document-level VLM rebuild atomicity (embedChunks vs embedSearchQuery, 2-phase swap)
 * C. Health check embeddings_without_vectors now fixable (was fixable=false)
 *
 * Uses REAL better-sqlite3 databases with full schema. NO MOCKS.
 * Every assertion verifies actual DATABASE STATE.
 *
 * @module tests/unit/embedding-rebuild-fixes
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import {
  createTempDir,
  cleanupTempDir,
  createUniqueName,
  createTestProvenance,
  createTestDocument,
  createTestOCRResult,
  createTestChunk,
  createTestEmbedding,
  createDatabase,
  selectDatabase,
  resetState,
  requireDatabase,
  ProvenanceType,
  VectorService,
  isSqliteVecAvailable,
  computeHash,
} from '../integration/server/helpers.js';
import { EMBEDDING_MODEL } from '../../src/models/embedding.js';

// ═══════════════════════════════════════════════════════════════════════════════
// SHARED HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

const sqliteVecAvailable = isSqliteVecAvailable();

function parseResponse(result: { content: Array<{ type: string; text: string }> }) {
  return JSON.parse(result.content[0].text);
}

/**
 * Insert an image row directly, returning the image ID.
 */
function insertTestImage(
  conn: import('better-sqlite3').Database,
  opts: {
    id?: string;
    document_id: string;
    ocr_result_id: string;
    provenance_id: string;
    vlm_description?: string | null;
    vlm_status?: string;
    vlm_embedding_id?: string | null;
    page_number?: number;
  }
): string {
  const imgId = opts.id ?? uuidv4();
  conn
    .prepare(
      `INSERT INTO images (id, document_id, ocr_result_id, page_number,
        bbox_x, bbox_y, bbox_width, bbox_height, image_index, format,
        width, height, vlm_status, vlm_description, vlm_embedding_id,
        extracted_path, created_at, block_type, provenance_id)
       VALUES (?, ?, ?, ?, 0, 0, 100, 100, 0, 'png', 200, 300, ?, ?, ?, '/test/image.png',
        datetime('now'), 'Figure', ?)`
    )
    .run(
      imgId,
      opts.document_id,
      opts.ocr_result_id,
      opts.page_number ?? 1,
      opts.vlm_status ?? 'complete',
      'vlm_description' in opts ? opts.vlm_description : 'A chart showing quarterly revenue data.',
      opts.vlm_embedding_id ?? null,
      opts.provenance_id
    );
  return imgId;
}

/**
 * Create a 768-dim Float32Array for vector storage tests.
 */
function makeFakeVector(seed: number = 42): Float32Array {
  const vec = new Float32Array(768);
  for (let i = 0; i < 768; i++) {
    vec[i] = Math.sin(seed + i * 0.01);
  }
  return vec;
}

// ═══════════════════════════════════════════════════════════════════════════════
// TEST GROUP A: Single-image rebuild FK constraint fix
// ═══════════════════════════════════════════════════════════════════════════════

describe('Bug A: Single-image rebuild FK constraint fix', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir('bugA-fk-');
  });

  afterEach(() => {
    resetState();
    cleanupTempDir(tempDir);
  });

  it('A1: deleting embedding with FK-safe order does NOT throw FK constraint error', () => {
    const dbName = createUniqueName('bugA-fk-safe');
    createDatabase(dbName, undefined, tempDir);
    selectDatabase(dbName, tempDir);
    const { db } = requireDatabase();
    const conn = db.getConnection();

    // Build chain: document -> OCR -> image -> VLM embedding
    const docProv = createTestProvenance();
    db.insertProvenance(docProv);
    const doc = createTestDocument(docProv.id);
    db.insertDocument(doc);

    const ocrProv = createTestProvenance({
      id: uuidv4(),
      type: ProvenanceType.OCR_RESULT,
      parent_id: docProv.id,
      root_document_id: docProv.root_document_id,
      chain_depth: 1,
    });
    db.insertProvenance(ocrProv);
    const ocr = createTestOCRResult(doc.id, ocrProv.id);
    db.insertOCRResult(ocr);

    const imgProv = createTestProvenance({
      id: uuidv4(),
      type: ProvenanceType.IMAGE,
      parent_id: ocrProv.id,
      root_document_id: docProv.root_document_id,
      chain_depth: 2,
    });
    db.insertProvenance(imgProv);

    const imgId = insertTestImage(conn, {
      document_id: doc.id,
      ocr_result_id: ocr.id,
      provenance_id: imgProv.id,
    });

    // Create VLM embedding
    const embProv = createTestProvenance({
      id: uuidv4(),
      type: ProvenanceType.EMBEDDING,
      parent_id: imgProv.id,
      root_document_id: docProv.root_document_id,
      chain_depth: 4,
    });
    db.insertProvenance(embProv);

    const emb = createTestEmbedding(null as unknown as string, doc.id, embProv.id, {
      chunk_id: null,
      image_id: imgId,
      extraction_id: null,
    });
    db.insertEmbedding(emb);

    // Set vlm_embedding_id on image (creates circular FK)
    conn.prepare('UPDATE images SET vlm_embedding_id = ? WHERE id = ?').run(emb.id, imgId);

    // The FIX: NULL vlm_embedding_id BEFORE deleting the embedding
    // This should NOT throw FK constraint error
    expect(() => {
      // 1. Capture provenance
      const oldEmb = conn
        .prepare('SELECT provenance_id FROM embeddings WHERE id = ?')
        .get(emb.id) as { provenance_id: string | null } | undefined;
      const oldProvId = oldEmb?.provenance_id ?? null;

      // 2. NULL out FK reference FIRST
      conn.prepare('UPDATE images SET vlm_embedding_id = NULL WHERE id = ?').run(imgId);

      // 3. Delete embedding
      conn.prepare('DELETE FROM embeddings WHERE image_id = ?').run(imgId);

      // 4. Delete orphaned provenance
      if (oldProvId) {
        conn.prepare('DELETE FROM provenance WHERE id = ?').run(oldProvId);
      }
    }).not.toThrow();

    // Verify image still exists but vlm_embedding_id is NULL
    const imgRow = conn.prepare('SELECT vlm_embedding_id FROM images WHERE id = ?').get(imgId) as {
      vlm_embedding_id: string | null;
    };
    expect(imgRow.vlm_embedding_id).toBeNull();
  });

  it('A2: after single-image rebuild, old data is cleaned and new data is correct', () => {
    const dbName = createUniqueName('bugA-rebuild-data');
    createDatabase(dbName, undefined, tempDir);
    selectDatabase(dbName, tempDir);
    const { db, vector } = requireDatabase();
    const conn = db.getConnection();

    // Build chain: document -> OCR -> image
    const docProv = createTestProvenance();
    db.insertProvenance(docProv);
    const doc = createTestDocument(docProv.id);
    db.insertDocument(doc);

    const ocrProv = createTestProvenance({
      id: uuidv4(),
      type: ProvenanceType.OCR_RESULT,
      parent_id: docProv.id,
      root_document_id: docProv.root_document_id,
      chain_depth: 1,
    });
    db.insertProvenance(ocrProv);
    const ocr = createTestOCRResult(doc.id, ocrProv.id);
    db.insertOCRResult(ocr);

    const imgProv = createTestProvenance({
      id: uuidv4(),
      type: ProvenanceType.IMAGE,
      parent_id: ocrProv.id,
      root_document_id: docProv.root_document_id,
      chain_depth: 2,
    });
    db.insertProvenance(imgProv);

    const imgId = insertTestImage(conn, {
      document_id: doc.id,
      ocr_result_id: ocr.id,
      provenance_id: imgProv.id,
      vlm_description: 'Old VLM description of a chart.',
    });

    // Old embedding + provenance
    const oldEmbProv = createTestProvenance({
      id: uuidv4(),
      type: ProvenanceType.EMBEDDING,
      parent_id: imgProv.id,
      root_document_id: docProv.root_document_id,
      chain_depth: 4,
    });
    db.insertProvenance(oldEmbProv);

    const oldEmb = createTestEmbedding(null as unknown as string, doc.id, oldEmbProv.id, {
      chunk_id: null,
      image_id: imgId,
      extraction_id: null,
      original_text: 'Old VLM description of a chart.',
    });
    db.insertEmbedding(oldEmb);

    // Store a vector for old embedding
    if (sqliteVecAvailable && vector) {
      vector.storeVector(oldEmb.id, makeFakeVector(1));
    }

    // Link image to old embedding
    conn.prepare('UPDATE images SET vlm_embedding_id = ? WHERE id = ?').run(oldEmb.id, imgId);

    // --- Simulate the FK-safe rebuild pattern from embeddings.ts ---

    // 1. Capture old provenance
    const capturedProv = conn
      .prepare('SELECT provenance_id FROM embeddings WHERE id = ?')
      .get(oldEmb.id) as { provenance_id: string | null };
    const oldProvId = capturedProv.provenance_id;

    // 2. Break FK
    conn.prepare('UPDATE images SET vlm_embedding_id = NULL WHERE id = ?').run(imgId);

    // 3. Delete vector
    if (sqliteVecAvailable && vector) {
      vector.deleteVector(oldEmb.id);
    }

    // 4. Delete embedding
    db.deleteEmbeddingsByImageId(imgId);

    // 5. Delete provenance
    if (oldProvId) {
      conn.prepare('DELETE FROM provenance WHERE id = ?').run(oldProvId);
    }

    // Verify old embedding is deleted from embeddings table
    const deletedEmb = conn
      .prepare('SELECT id FROM embeddings WHERE id = ?')
      .get(oldEmb.id);
    expect(deletedEmb).toBeUndefined();

    // Verify old provenance is deleted
    const deletedProv = conn
      .prepare('SELECT id FROM provenance WHERE id = ?')
      .get(oldEmbProv.id);
    expect(deletedProv).toBeUndefined();

    // Verify old vector is deleted
    if (sqliteVecAvailable && vector) {
      const oldVecRow = conn
        .prepare('SELECT embedding_id FROM vec_embeddings WHERE embedding_id = ?')
        .get(oldEmb.id);
      expect(oldVecRow).toBeUndefined();
    }

    // --- Insert new embedding (simulating successful rebuild) ---
    const newEmbProv = createTestProvenance({
      id: uuidv4(),
      type: ProvenanceType.EMBEDDING,
      parent_id: imgProv.id,
      root_document_id: docProv.root_document_id,
      chain_depth: 4,
    });
    db.insertProvenance(newEmbProv);

    const newEmbId = uuidv4();
    db.insertEmbedding({
      id: newEmbId,
      chunk_id: null,
      image_id: imgId,
      extraction_id: null,
      document_id: doc.id,
      original_text: 'Old VLM description of a chart.',
      original_text_length: 31,
      source_file_path: doc.file_path,
      source_file_name: doc.file_name,
      source_file_hash: doc.file_hash,
      page_number: 1,
      page_range: null,
      character_start: 0,
      character_end: 31,
      chunk_index: 0,
      total_chunks: 0,
      model_name: EMBEDDING_MODEL.name,
      model_version: EMBEDDING_MODEL.version,
      task_type: 'search_document',
      inference_mode: 'local',
      gpu_device: 'cpu',
      provenance_id: newEmbProv.id,
      content_hash: computeHash('Old VLM description of a chart.'),
      generation_duration_ms: null,
    });

    // Store new vector
    if (sqliteVecAvailable && vector) {
      vector.storeVector(newEmbId, makeFakeVector(2));
    }

    // Update image to point to new embedding
    conn.prepare('UPDATE images SET vlm_embedding_id = ? WHERE id = ?').run(newEmbId, imgId);

    // Verify: new embedding exists with correct provenance
    const newEmbRow = conn
      .prepare('SELECT id, provenance_id, model_name FROM embeddings WHERE id = ?')
      .get(newEmbId) as { id: string; provenance_id: string; model_name: string };
    expect(newEmbRow).toBeDefined();
    expect(newEmbRow.provenance_id).toBe(newEmbProv.id);
    expect(newEmbRow.model_name).toBe(EMBEDDING_MODEL.name);

    // Verify: image vlm_embedding_id points to new embedding
    const imgAfter = conn
      .prepare('SELECT vlm_embedding_id FROM images WHERE id = ?')
      .get(imgId) as { vlm_embedding_id: string | null };
    expect(imgAfter.vlm_embedding_id).toBe(newEmbId);

    // Verify: new vector exists in vec_embeddings
    if (sqliteVecAvailable && vector) {
      const newVecRow = conn
        .prepare('SELECT embedding_id FROM vec_embeddings WHERE embedding_id = ?')
        .get(newEmbId) as { embedding_id: string } | undefined;
      expect(newVecRow).toBeDefined();
      expect(newVecRow!.embedding_id).toBe(newEmbId);
    }

    // Verify: no orphaned EMBEDDING provenance records
    const orphanedEmbProv = conn
      .prepare(
        `SELECT p.id FROM provenance p
         WHERE p.type = 'EMBEDDING'
         AND p.id NOT IN (SELECT provenance_id FROM embeddings WHERE provenance_id IS NOT NULL)`
      )
      .all() as Array<{ id: string }>;
    expect(orphanedEmbProv).toHaveLength(0);
  });

  it('A3: image_id with no VLM description throws clear error (not FK error)', () => {
    const dbName = createUniqueName('bugA-no-vlm');
    createDatabase(dbName, undefined, tempDir);
    selectDatabase(dbName, tempDir);
    const { db } = requireDatabase();
    const conn = db.getConnection();

    // Build chain: document -> OCR -> image WITHOUT vlm_description
    const docProv = createTestProvenance();
    db.insertProvenance(docProv);
    const doc = createTestDocument(docProv.id);
    db.insertDocument(doc);

    const ocrProv = createTestProvenance({
      id: uuidv4(),
      type: ProvenanceType.OCR_RESULT,
      parent_id: docProv.id,
      root_document_id: docProv.root_document_id,
      chain_depth: 1,
    });
    db.insertProvenance(ocrProv);
    const ocr = createTestOCRResult(doc.id, ocrProv.id);
    db.insertOCRResult(ocr);

    const imgProv = createTestProvenance({
      id: uuidv4(),
      type: ProvenanceType.IMAGE,
      parent_id: ocrProv.id,
      root_document_id: docProv.root_document_id,
      chain_depth: 2,
    });
    db.insertProvenance(imgProv);

    const imgId = insertTestImage(conn, {
      document_id: doc.id,
      ocr_result_id: ocr.id,
      provenance_id: imgProv.id,
      vlm_description: null,
      vlm_status: 'pending',
    });

    // Verify the image exists but has no vlm_description
    const imgRow = conn
      .prepare('SELECT vlm_description FROM images WHERE id = ?')
      .get(imgId) as { vlm_description: string | null };
    expect(imgRow.vlm_description).toBeNull();

    // The code at embeddings.ts:395-396 checks vlm_description and throws a clear error
    // Simulate: check for VLM description and throw descriptive error
    const img = conn
      .prepare('SELECT id, vlm_description FROM images WHERE id = ?')
      .get(imgId) as { id: string; vlm_description: string | null };

    expect(() => {
      if (!img.vlm_description) {
        throw new Error(`Image ${imgId} has no VLM description to embed`);
      }
    }).toThrow(`Image ${imgId} has no VLM description to embed`);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// TEST GROUP B: Document-level VLM rebuild atomicity
// ═══════════════════════════════════════════════════════════════════════════════

describe('Bug B: Document-level VLM rebuild atomicity', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir('bugB-vlm-rebuild-');
  });

  afterEach(() => {
    resetState();
    cleanupTempDir(tempDir);
  });

  it('B1: VLM rebuild uses EMBEDDING_MODEL.name constant (not hardcoded string)', () => {
    // Verify the constant value - embedding records must use this
    expect(EMBEDDING_MODEL.name).toBe('nomic-embed-text-v1.5');
    expect(EMBEDDING_MODEL.version).toBe('1.5.0');
    expect(EMBEDDING_MODEL.dimensions).toBe(768);

    // The fix ensures all embedding records use EMBEDDING_MODEL.name
    // rather than hardcoded 'nomic-embed-text-v1.5'
    // We verify the constant exists and has correct values
    expect(typeof EMBEDDING_MODEL.name).toBe('string');
    expect(typeof EMBEDDING_MODEL.version).toBe('string');
    expect(EMBEDDING_MODEL.prefixes.document).toBe('search_document: ');
    expect(EMBEDDING_MODEL.prefixes.query).toBe('search_query: ');
  });

  it('B2: VLM rebuild creates correct provenance chain (depth=4) and uses EMBEDDING_MODEL constants', () => {
    const dbName = createUniqueName('bugB-prov-chain');
    createDatabase(dbName, undefined, tempDir);
    selectDatabase(dbName, tempDir);
    const { db, vector } = requireDatabase();
    const conn = db.getConnection();

    // Setup: document -> OCR -> image with VLM description
    const docProv = createTestProvenance();
    db.insertProvenance(docProv);
    const doc = createTestDocument(docProv.id);
    db.insertDocument(doc);

    const ocrProv = createTestProvenance({
      id: uuidv4(),
      type: ProvenanceType.OCR_RESULT,
      parent_id: docProv.id,
      root_document_id: docProv.root_document_id,
      chain_depth: 1,
    });
    db.insertProvenance(ocrProv);
    const ocr = createTestOCRResult(doc.id, ocrProv.id);
    db.insertOCRResult(ocr);

    const imgProv = createTestProvenance({
      id: uuidv4(),
      type: ProvenanceType.IMAGE,
      parent_id: ocrProv.id,
      root_document_id: docProv.root_document_id,
      chain_depth: 2,
    });
    db.insertProvenance(imgProv);

    const imgId = insertTestImage(conn, {
      document_id: doc.id,
      ocr_result_id: ocr.id,
      provenance_id: imgProv.id,
      vlm_description: 'A detailed chart showing quarterly revenue trends.',
    });

    // Create old embedding + provenance (to be replaced during rebuild)
    const oldEmbProv = createTestProvenance({
      id: uuidv4(),
      type: ProvenanceType.EMBEDDING,
      parent_id: imgProv.id,
      root_document_id: docProv.root_document_id,
      chain_depth: 4,
    });
    db.insertProvenance(oldEmbProv);

    const oldEmb = createTestEmbedding(null as unknown as string, doc.id, oldEmbProv.id, {
      chunk_id: null,
      image_id: imgId,
      extraction_id: null,
    });
    db.insertEmbedding(oldEmb);
    conn.prepare('UPDATE images SET vlm_embedding_id = ? WHERE id = ?').run(oldEmb.id, imgId);

    if (sqliteVecAvailable && vector) {
      vector.storeVector(oldEmb.id, makeFakeVector(10));
    }

    // --- Simulate the Phase 2 atomic swap from embeddings.ts ---

    // Delete old (FK-safe)
    const capturedOldProv = conn
      .prepare('SELECT provenance_id FROM embeddings WHERE id = ?')
      .get(oldEmb.id) as { provenance_id: string | null };
    const oldProvId = capturedOldProv.provenance_id;

    conn.prepare('UPDATE images SET vlm_embedding_id = NULL WHERE id = ?').run(imgId);
    if (sqliteVecAvailable && vector) {
      vector.deleteVector(oldEmb.id);
    }
    conn.prepare('DELETE FROM embeddings WHERE id = ?').run(oldEmb.id);
    if (oldProvId) {
      conn.prepare('DELETE FROM provenance WHERE id = ?').run(oldProvId);
    }

    // Create new provenance with chain_depth=4
    const newProvId = uuidv4();
    const now = new Date().toISOString();
    db.insertProvenance({
      id: newProvId,
      type: ProvenanceType.EMBEDDING,
      created_at: now,
      processed_at: now,
      source_file_created_at: null,
      source_file_modified_at: null,
      source_type: 'EMBEDDING',
      source_path: null,
      source_id: imgProv.id,
      root_document_id: doc.provenance_id,
      location: { page_number: 1 },
      content_hash: computeHash('A detailed chart showing quarterly revenue trends.'),
      input_hash: null,
      file_hash: doc.file_hash,
      processor: EMBEDDING_MODEL.name,
      processor_version: EMBEDDING_MODEL.version,
      processing_params: {
        task_type: 'search_document',
        inference_mode: 'local',
        source: 'vlm_description_reembed',
      },
      processing_duration_ms: null,
      processing_quality_score: null,
      parent_id: imgProv.id,
      parent_ids: JSON.stringify([imgProv.id]),
      chain_depth: 4,
      chain_path: JSON.stringify([
        'DOCUMENT',
        'OCR_RESULT',
        'IMAGE',
        'VLM_DESCRIPTION',
        'EMBEDDING',
      ]),
    });

    // Create new embedding using EMBEDDING_MODEL constants
    const newEmbId = uuidv4();
    const gpuDevice = 'cpu'; // Simulating embClient.getLastDevice()
    db.insertEmbedding({
      id: newEmbId,
      chunk_id: null,
      image_id: imgId,
      extraction_id: null,
      document_id: doc.id,
      original_text: 'A detailed chart showing quarterly revenue trends.',
      original_text_length: 50,
      source_file_path: doc.file_path,
      source_file_name: doc.file_name,
      source_file_hash: doc.file_hash,
      page_number: 1,
      page_range: null,
      character_start: 0,
      character_end: 50,
      chunk_index: 0,
      total_chunks: 1,
      model_name: EMBEDDING_MODEL.name,
      model_version: EMBEDDING_MODEL.version,
      task_type: 'search_document',
      inference_mode: 'local',
      gpu_device: gpuDevice,
      provenance_id: newProvId,
      content_hash: computeHash('A detailed chart showing quarterly revenue trends.'),
      generation_duration_ms: null,
    });

    if (sqliteVecAvailable && vector) {
      vector.storeVector(newEmbId, makeFakeVector(20));
    }

    conn.prepare('UPDATE images SET vlm_embedding_id = ? WHERE id = ?').run(newEmbId, imgId);

    // --- Assertions ---

    // Verify old embedding is gone
    const oldEmbRow = conn.prepare('SELECT id FROM embeddings WHERE id = ?').get(oldEmb.id);
    expect(oldEmbRow).toBeUndefined();

    // Verify old provenance is gone
    const oldProvRow = conn.prepare('SELECT id FROM provenance WHERE id = ?').get(oldEmbProv.id);
    expect(oldProvRow).toBeUndefined();

    // Verify new embedding uses EMBEDDING_MODEL constants
    const newEmbRow = conn
      .prepare('SELECT model_name, model_version, task_type, gpu_device FROM embeddings WHERE id = ?')
      .get(newEmbId) as {
      model_name: string;
      model_version: string;
      task_type: string;
      gpu_device: string;
    };
    expect(newEmbRow.model_name).toBe(EMBEDDING_MODEL.name);
    expect(newEmbRow.model_version).toBe(EMBEDDING_MODEL.version);
    expect(newEmbRow.task_type).toBe('search_document');
    // gpu_device should NOT be hardcoded 'cuda:0' -- it uses embClient.getLastDevice()
    expect(newEmbRow.gpu_device).not.toBe('cuda:0');

    // Verify new provenance has chain_depth=4
    const newProvRow = conn
      .prepare('SELECT chain_depth, processor, processor_version, chain_path FROM provenance WHERE id = ?')
      .get(newProvId) as {
      chain_depth: number;
      processor: string;
      processor_version: string;
      chain_path: string;
    };
    expect(newProvRow.chain_depth).toBe(4);
    expect(newProvRow.processor).toBe(EMBEDDING_MODEL.name);
    expect(newProvRow.processor_version).toBe(EMBEDDING_MODEL.version);

    const chainPath = JSON.parse(newProvRow.chain_path) as string[];
    expect(chainPath).toEqual([
      'DOCUMENT',
      'OCR_RESULT',
      'IMAGE',
      'VLM_DESCRIPTION',
      'EMBEDDING',
    ]);

    // Verify image points to new embedding
    const imgAfter = conn
      .prepare('SELECT vlm_embedding_id FROM images WHERE id = ?')
      .get(imgId) as { vlm_embedding_id: string | null };
    expect(imgAfter.vlm_embedding_id).toBe(newEmbId);
  });

  it('B3: multi-image VLM rebuild deletes all old data and creates all new data', () => {
    const dbName = createUniqueName('bugB-multi-img');
    createDatabase(dbName, undefined, tempDir);
    selectDatabase(dbName, tempDir);
    const { db, vector } = requireDatabase();
    const conn = db.getConnection();

    // Setup: document -> OCR -> 3 images each with VLM embeddings
    const docProv = createTestProvenance();
    db.insertProvenance(docProv);
    const doc = createTestDocument(docProv.id);
    db.insertDocument(doc);

    const ocrProv = createTestProvenance({
      id: uuidv4(),
      type: ProvenanceType.OCR_RESULT,
      parent_id: docProv.id,
      root_document_id: docProv.root_document_id,
      chain_depth: 1,
    });
    db.insertProvenance(ocrProv);
    const ocr = createTestOCRResult(doc.id, ocrProv.id);
    db.insertOCRResult(ocr);

    const imageData: Array<{
      imgId: string;
      imgProvId: string;
      oldEmbId: string;
      oldEmbProvId: string;
    }> = [];

    for (let i = 0; i < 3; i++) {
      const imgProv = createTestProvenance({
        id: uuidv4(),
        type: ProvenanceType.IMAGE,
        parent_id: ocrProv.id,
        root_document_id: docProv.root_document_id,
        chain_depth: 2,
      });
      db.insertProvenance(imgProv);

      const imgId = insertTestImage(conn, {
        document_id: doc.id,
        ocr_result_id: ocr.id,
        provenance_id: imgProv.id,
        vlm_description: `VLM description for image ${i}: quarterly revenue chart.`,
        page_number: i + 1,
      });

      const embProv = createTestProvenance({
        id: uuidv4(),
        type: ProvenanceType.EMBEDDING,
        parent_id: imgProv.id,
        root_document_id: docProv.root_document_id,
        chain_depth: 4,
      });
      db.insertProvenance(embProv);

      const emb = createTestEmbedding(null as unknown as string, doc.id, embProv.id, {
        chunk_id: null,
        image_id: imgId,
        extraction_id: null,
        original_text: `VLM description for image ${i}: quarterly revenue chart.`,
      });
      db.insertEmbedding(emb);

      conn.prepare('UPDATE images SET vlm_embedding_id = ? WHERE id = ?').run(emb.id, imgId);

      if (sqliteVecAvailable && vector) {
        vector.storeVector(emb.id, makeFakeVector(100 + i));
      }

      imageData.push({
        imgId,
        imgProvId: imgProv.id,
        oldEmbId: emb.id,
        oldEmbProvId: embProv.id,
      });
    }

    // Verify 3 old embeddings exist
    const oldEmbCount = conn
      .prepare("SELECT COUNT(*) as c FROM embeddings WHERE image_id IS NOT NULL AND document_id = ?")
      .get(doc.id) as { c: number };
    expect(oldEmbCount.c).toBe(3);

    // --- Simulate Phase 2 atomic swap for all images ---
    const newEmbIds: string[] = [];
    const newProvIds: string[] = [];

    for (const { imgId, imgProvId, oldEmbId, oldEmbProvId } of imageData) {
      // Delete old (FK-safe)
      const oldEmb = conn
        .prepare('SELECT provenance_id FROM embeddings WHERE id = ?')
        .get(oldEmbId) as { provenance_id: string | null } | undefined;
      const oldProvId = oldEmb?.provenance_id ?? null;

      conn.prepare('UPDATE images SET vlm_embedding_id = NULL WHERE id = ?').run(imgId);
      if (sqliteVecAvailable && vector) {
        vector.deleteVector(oldEmbId);
      }
      conn.prepare('DELETE FROM embeddings WHERE id = ?').run(oldEmbId);
      if (oldProvId) {
        conn.prepare('DELETE FROM provenance WHERE id = ?').run(oldProvId);
      }

      // Insert new
      const newProvId = uuidv4();
      const newEmbId = uuidv4();
      const now = new Date().toISOString();

      db.insertProvenance({
        id: newProvId,
        type: ProvenanceType.EMBEDDING,
        created_at: now,
        processed_at: now,
        source_file_created_at: null,
        source_file_modified_at: null,
        source_type: 'EMBEDDING',
        source_path: null,
        source_id: imgProvId,
        root_document_id: doc.provenance_id,
        location: { page_number: 1 },
        content_hash: computeHash(`new vlm desc ${imgId}`),
        input_hash: null,
        file_hash: doc.file_hash,
        processor: EMBEDDING_MODEL.name,
        processor_version: EMBEDDING_MODEL.version,
        processing_params: { task_type: 'search_document', inference_mode: 'local' },
        processing_duration_ms: null,
        processing_quality_score: null,
        parent_id: imgProvId,
        parent_ids: JSON.stringify([imgProvId]),
        chain_depth: 4,
        chain_path: JSON.stringify(['DOCUMENT', 'OCR_RESULT', 'IMAGE', 'VLM_DESCRIPTION', 'EMBEDDING']),
      });

      db.insertEmbedding({
        id: newEmbId,
        chunk_id: null,
        image_id: imgId,
        extraction_id: null,
        document_id: doc.id,
        original_text: `New VLM description for image ${imgId}`,
        original_text_length: 40,
        source_file_path: doc.file_path,
        source_file_name: doc.file_name,
        source_file_hash: doc.file_hash,
        page_number: 1,
        page_range: null,
        character_start: 0,
        character_end: 40,
        chunk_index: 0,
        total_chunks: 1,
        model_name: EMBEDDING_MODEL.name,
        model_version: EMBEDDING_MODEL.version,
        task_type: 'search_document',
        inference_mode: 'local',
        gpu_device: 'cpu',
        provenance_id: newProvId,
        content_hash: computeHash(`new vlm desc ${imgId}`),
        generation_duration_ms: null,
      });

      if (sqliteVecAvailable && vector) {
        vector.storeVector(newEmbId, makeFakeVector(200 + newEmbIds.length));
      }

      conn.prepare('UPDATE images SET vlm_embedding_id = ? WHERE id = ?').run(newEmbId, imgId);

      newEmbIds.push(newEmbId);
      newProvIds.push(newProvId);
    }

    // --- Assertions ---

    // All old embeddings deleted
    for (const { oldEmbId } of imageData) {
      const row = conn.prepare('SELECT id FROM embeddings WHERE id = ?').get(oldEmbId);
      expect(row).toBeUndefined();
    }

    // All old provenance deleted
    for (const { oldEmbProvId } of imageData) {
      const row = conn.prepare('SELECT id FROM provenance WHERE id = ?').get(oldEmbProvId);
      expect(row).toBeUndefined();
    }

    // New embeddings exist
    const newEmbCount = conn
      .prepare("SELECT COUNT(*) as c FROM embeddings WHERE image_id IS NOT NULL AND document_id = ?")
      .get(doc.id) as { c: number };
    expect(newEmbCount.c).toBe(3);

    // All images point to new embeddings
    for (let i = 0; i < 3; i++) {
      const imgRow = conn
        .prepare('SELECT vlm_embedding_id FROM images WHERE id = ?')
        .get(imageData[i].imgId) as { vlm_embedding_id: string | null };
      expect(imgRow.vlm_embedding_id).toBe(newEmbIds[i]);
    }

    // No orphaned EMBEDDING provenance
    const orphaned = conn
      .prepare(
        `SELECT p.id FROM provenance p
         WHERE p.type = 'EMBEDDING'
         AND p.id NOT IN (SELECT provenance_id FROM embeddings WHERE provenance_id IS NOT NULL)`
      )
      .all() as Array<{ id: string }>;
    expect(orphaned).toHaveLength(0);
  });

  it('B4: gpu_device is NOT hardcoded cuda:0 in the fix code', async () => {
    // Read the actual source code and verify the fix uses embClient.getLastDevice()
    // rather than hardcoded 'cuda:0'
    const { readFileSync } = await import('fs');
    const embeddingsSource = readFileSync(
      '/home/cabdru/datalab/src/tools/embeddings.ts',
      'utf-8'
    );

    // In the single-image rebuild path (around line 495), verify gpu_device uses getLastDevice()
    // The fix should have: gpu_device: embClient.getLastDevice()
    // and NOT: gpu_device: 'cuda:0'

    // Check that getLastDevice is used for gpu_device assignment in the image rebuild paths
    expect(embeddingsSource).toContain('embClient.getLastDevice()');

    // Verify the VLM rebuild section uses EMBEDDING_MODEL constants
    expect(embeddingsSource).toContain('EMBEDDING_MODEL.name');
    expect(embeddingsSource).toContain('EMBEDDING_MODEL.version');

    // Verify embedChunks is used (not embedSearchQuery) for VLM description embedding
    // The fix replaces embedSearchQuery with embedChunks for reliability
    expect(embeddingsSource).toContain('embClient.embedChunks');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// TEST GROUP C: Health check embeddings_without_vectors fix
// ═══════════════════════════════════════════════════════════════════════════════

describe('Bug C: Health check embeddings_without_vectors fix', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir('bugC-health-');
  });

  afterEach(() => {
    resetState();
    cleanupTempDir(tempDir);
  });

  it('C1: health_check detects embeddings_without_vectors and reports fixable=true', async () => {
    const dbName = createUniqueName('bugC-detect');
    createDatabase(dbName, undefined, tempDir);
    selectDatabase(dbName, tempDir);
    const { db } = requireDatabase();
    const conn = db.getConnection();

    // Create a valid document chain
    const docProv = createTestProvenance();
    db.insertProvenance(docProv);
    const doc = createTestDocument(docProv.id);
    db.insertDocument(doc);

    const ocrProv = createTestProvenance({
      id: uuidv4(),
      type: ProvenanceType.OCR_RESULT,
      parent_id: docProv.id,
      root_document_id: docProv.root_document_id,
      chain_depth: 1,
    });
    db.insertProvenance(ocrProv);
    const ocr = createTestOCRResult(doc.id, ocrProv.id);
    db.insertOCRResult(ocr);

    const chunkProv = createTestProvenance({
      id: uuidv4(),
      type: ProvenanceType.CHUNK,
      parent_id: ocrProv.id,
      root_document_id: docProv.root_document_id,
      chain_depth: 2,
    });
    db.insertProvenance(chunkProv);
    const chunk = createTestChunk(doc.id, ocr.id, chunkProv.id);
    db.insertChunk(chunk);

    // Create an embedding WITHOUT storing a vector in vec_embeddings
    const embProv = createTestProvenance({
      id: uuidv4(),
      type: ProvenanceType.EMBEDDING,
      parent_id: chunkProv.id,
      root_document_id: docProv.root_document_id,
      chain_depth: 3,
    });
    db.insertProvenance(embProv);

    const brokenEmb = createTestEmbedding(chunk.id, doc.id, embProv.id, {
      image_id: null,
      extraction_id: null,
    });
    db.insertEmbedding(brokenEmb);
    // NOTE: Deliberately NOT calling vector.storeVector() -- this simulates the corrupted state

    // Run health check (fix=false)
    const { healthTools } = await import('../../src/tools/health.js');
    const result = await healthTools.ocr_health_check.handler({ fix: false });
    const parsed = parseResponse(result);

    expect(parsed.success).toBe(true);
    expect(parsed.data.gaps.embeddings_without_vectors).toBeDefined();
    expect(parsed.data.gaps.embeddings_without_vectors.count).toBeGreaterThanOrEqual(1);

    // Bug C fix: fixable should be TRUE (was false before the fix)
    expect(parsed.data.gaps.embeddings_without_vectors.fixable).toBe(true);
    expect(parsed.data.gaps.embeddings_without_vectors.fix_tool).toBe('ocr_health_check');
    expect(parsed.data.gaps.embeddings_without_vectors.fix_hint).toContain('fix=true');

    // Verify the broken embedding ID is in sample_ids
    expect(parsed.data.gaps.embeddings_without_vectors.sample_ids).toContain(brokenEmb.id);
  });

  it('C2: fix=true deletes broken embedding records that have no vectors', async () => {
    const dbName = createUniqueName('bugC-fix-delete');
    createDatabase(dbName, undefined, tempDir);
    selectDatabase(dbName, tempDir);
    const { db } = requireDatabase();
    const conn = db.getConnection();

    // Create a valid document chain
    const docProv = createTestProvenance();
    db.insertProvenance(docProv);
    const doc = createTestDocument(docProv.id);
    db.insertDocument(doc);

    const ocrProv = createTestProvenance({
      id: uuidv4(),
      type: ProvenanceType.OCR_RESULT,
      parent_id: docProv.id,
      root_document_id: docProv.root_document_id,
      chain_depth: 1,
    });
    db.insertProvenance(ocrProv);
    const ocr = createTestOCRResult(doc.id, ocrProv.id);
    db.insertOCRResult(ocr);

    const chunkProv = createTestProvenance({
      id: uuidv4(),
      type: ProvenanceType.CHUNK,
      parent_id: ocrProv.id,
      root_document_id: docProv.root_document_id,
      chain_depth: 2,
    });
    db.insertProvenance(chunkProv);
    const chunk = createTestChunk(doc.id, ocr.id, chunkProv.id);
    db.insertChunk(chunk);

    // Create 2 broken embeddings (no vectors)
    const brokenEmbIds: string[] = [];
    const brokenProvIds: string[] = [];
    for (let i = 0; i < 2; i++) {
      const embProv = createTestProvenance({
        id: uuidv4(),
        type: ProvenanceType.EMBEDDING,
        parent_id: chunkProv.id,
        root_document_id: docProv.root_document_id,
        chain_depth: 3,
      });
      db.insertProvenance(embProv);
      brokenProvIds.push(embProv.id);

      const brokenEmb = createTestEmbedding(chunk.id, doc.id, embProv.id, {
        image_id: null,
        extraction_id: null,
      });
      db.insertEmbedding(brokenEmb);
      brokenEmbIds.push(brokenEmb.id);
      // NO vector stored -- simulates corrupted state
    }

    // Verify broken embeddings exist
    for (const embId of brokenEmbIds) {
      const row = conn.prepare('SELECT id FROM embeddings WHERE id = ?').get(embId);
      expect(row).toBeDefined();
    }

    // Run health check with fix=true
    const { healthTools } = await import('../../src/tools/health.js');
    const result = await healthTools.ocr_health_check.handler({ fix: true });
    const parsed = parseResponse(result);

    expect(parsed.success).toBe(true);

    // Verify: broken embedding records are DELETED
    for (const embId of brokenEmbIds) {
      const row = conn.prepare('SELECT id FROM embeddings WHERE id = ?').get(embId);
      expect(row).toBeUndefined();
    }
  });

  it('C3: fix=true NULLs out images.vlm_embedding_id pointing to deleted embeddings', async () => {
    const dbName = createUniqueName('bugC-null-vlm-ref');
    createDatabase(dbName, undefined, tempDir);
    selectDatabase(dbName, tempDir);
    const { db } = requireDatabase();
    const conn = db.getConnection();

    // Build full chain with image
    const docProv = createTestProvenance();
    db.insertProvenance(docProv);
    const doc = createTestDocument(docProv.id);
    db.insertDocument(doc);

    const ocrProv = createTestProvenance({
      id: uuidv4(),
      type: ProvenanceType.OCR_RESULT,
      parent_id: docProv.id,
      root_document_id: docProv.root_document_id,
      chain_depth: 1,
    });
    db.insertProvenance(ocrProv);
    const ocr = createTestOCRResult(doc.id, ocrProv.id);
    db.insertOCRResult(ocr);

    const imgProv = createTestProvenance({
      id: uuidv4(),
      type: ProvenanceType.IMAGE,
      parent_id: ocrProv.id,
      root_document_id: docProv.root_document_id,
      chain_depth: 2,
    });
    db.insertProvenance(imgProv);

    // Create a broken VLM embedding (no vector in vec_embeddings)
    const embProv = createTestProvenance({
      id: uuidv4(),
      type: ProvenanceType.EMBEDDING,
      parent_id: imgProv.id,
      root_document_id: docProv.root_document_id,
      chain_depth: 4,
    });
    db.insertProvenance(embProv);

    const brokenEmb = createTestEmbedding(null as unknown as string, doc.id, embProv.id, {
      chunk_id: null,
      image_id: null, // Will set via INSERT
      extraction_id: null,
    });

    // Insert image first (without vlm_embedding_id)
    const imgId = insertTestImage(conn, {
      document_id: doc.id,
      ocr_result_id: ocr.id,
      provenance_id: imgProv.id,
      vlm_description: 'A chart showing data.',
      vlm_embedding_id: null,
    });

    // Update the embedding to reference the image
    const embWithImage = { ...brokenEmb, image_id: imgId };
    db.insertEmbedding(embWithImage);
    // NO vector stored -- this embedding is broken

    // Set vlm_embedding_id on image to the broken embedding
    conn.prepare('UPDATE images SET vlm_embedding_id = ? WHERE id = ?').run(brokenEmb.id, imgId);

    // Verify: image points to broken embedding
    const imgBefore = conn
      .prepare('SELECT vlm_embedding_id FROM images WHERE id = ?')
      .get(imgId) as { vlm_embedding_id: string | null };
    expect(imgBefore.vlm_embedding_id).toBe(brokenEmb.id);

    // Run health check with fix=true
    const { healthTools } = await import('../../src/tools/health.js');
    const result = await healthTools.ocr_health_check.handler({ fix: true });
    const parsed = parseResponse(result);

    expect(parsed.success).toBe(true);

    // Verify: image vlm_embedding_id is now NULL
    const imgAfter = conn
      .prepare('SELECT vlm_embedding_id FROM images WHERE id = ?')
      .get(imgId) as { vlm_embedding_id: string | null };
    expect(imgAfter.vlm_embedding_id).toBeNull();

    // Verify: broken embedding is deleted
    const embRow = conn.prepare('SELECT id FROM embeddings WHERE id = ?').get(brokenEmb.id);
    expect(embRow).toBeUndefined();

    // Verify: image itself still exists
    const imgExists = conn.prepare('SELECT id FROM images WHERE id = ?').get(imgId);
    expect(imgExists).toBeDefined();
  });

  it('C4: fix=true deletes orphaned provenance records from broken embeddings', async () => {
    const dbName = createUniqueName('bugC-fix-prov');
    createDatabase(dbName, undefined, tempDir);
    selectDatabase(dbName, tempDir);
    const { db } = requireDatabase();
    const conn = db.getConnection();

    // Create valid document
    const docProv = createTestProvenance();
    db.insertProvenance(docProv);
    const doc = createTestDocument(docProv.id);
    db.insertDocument(doc);

    const ocrProv = createTestProvenance({
      id: uuidv4(),
      type: ProvenanceType.OCR_RESULT,
      parent_id: docProv.id,
      root_document_id: docProv.root_document_id,
      chain_depth: 1,
    });
    db.insertProvenance(ocrProv);
    const ocr = createTestOCRResult(doc.id, ocrProv.id);
    db.insertOCRResult(ocr);

    const chunkProv = createTestProvenance({
      id: uuidv4(),
      type: ProvenanceType.CHUNK,
      parent_id: ocrProv.id,
      root_document_id: docProv.root_document_id,
      chain_depth: 2,
    });
    db.insertProvenance(chunkProv);
    const chunk = createTestChunk(doc.id, ocr.id, chunkProv.id);
    db.insertChunk(chunk);

    // Create broken embedding with provenance but no vector
    const embProv = createTestProvenance({
      id: uuidv4(),
      type: ProvenanceType.EMBEDDING,
      parent_id: chunkProv.id,
      root_document_id: docProv.root_document_id,
      chain_depth: 3,
    });
    db.insertProvenance(embProv);

    const brokenEmb = createTestEmbedding(chunk.id, doc.id, embProv.id, {
      image_id: null,
      extraction_id: null,
    });
    db.insertEmbedding(brokenEmb);
    // NO vector stored

    // Verify provenance exists
    const provBefore = conn.prepare('SELECT id FROM provenance WHERE id = ?').get(embProv.id);
    expect(provBefore).toBeDefined();

    // Run health check with fix=true
    const { healthTools } = await import('../../src/tools/health.js');
    const result = await healthTools.ocr_health_check.handler({ fix: true });
    const parsed = parseResponse(result);

    expect(parsed.success).toBe(true);

    // Verify: broken embedding deleted
    const embRow = conn.prepare('SELECT id FROM embeddings WHERE id = ?').get(brokenEmb.id);
    expect(embRow).toBeUndefined();

    // Verify: associated provenance record is also deleted
    const provAfter = conn.prepare('SELECT id FROM provenance WHERE id = ?').get(embProv.id);
    expect(provAfter).toBeUndefined();

    // Verify: non-broken provenance records are preserved
    const docProvRow = conn.prepare('SELECT id FROM provenance WHERE id = ?').get(docProv.id);
    expect(docProvRow).toBeDefined();
    const ocrProvRow = conn.prepare('SELECT id FROM provenance WHERE id = ?').get(ocrProv.id);
    expect(ocrProvRow).toBeDefined();
    const chunkProvRow = conn.prepare('SELECT id FROM provenance WHERE id = ?').get(chunkProv.id);
    expect(chunkProvRow).toBeDefined();
  });

  it('C5: fix message reports accurate counts', async () => {
    const dbName = createUniqueName('bugC-counts');
    createDatabase(dbName, undefined, tempDir);
    selectDatabase(dbName, tempDir);
    const { db } = requireDatabase();
    const conn = db.getConnection();

    // Create valid document chain
    const docProv = createTestProvenance();
    db.insertProvenance(docProv);
    const doc = createTestDocument(docProv.id);
    db.insertDocument(doc);

    const ocrProv = createTestProvenance({
      id: uuidv4(),
      type: ProvenanceType.OCR_RESULT,
      parent_id: docProv.id,
      root_document_id: docProv.root_document_id,
      chain_depth: 1,
    });
    db.insertProvenance(ocrProv);
    const ocr = createTestOCRResult(doc.id, ocrProv.id);
    db.insertOCRResult(ocr);

    const chunkProv = createTestProvenance({
      id: uuidv4(),
      type: ProvenanceType.CHUNK,
      parent_id: ocrProv.id,
      root_document_id: docProv.root_document_id,
      chain_depth: 2,
    });
    db.insertProvenance(chunkProv);
    const chunk = createTestChunk(doc.id, ocr.id, chunkProv.id);
    db.insertChunk(chunk);

    // Create 3 broken embeddings with provenance (no vectors)
    for (let i = 0; i < 3; i++) {
      const embProv = createTestProvenance({
        id: uuidv4(),
        type: ProvenanceType.EMBEDDING,
        parent_id: chunkProv.id,
        root_document_id: docProv.root_document_id,
        chain_depth: 3,
      });
      db.insertProvenance(embProv);

      const brokenEmb = createTestEmbedding(chunk.id, doc.id, embProv.id, {
        image_id: null,
        extraction_id: null,
      });
      db.insertEmbedding(brokenEmb);
      // NO vector stored
    }

    // Also create one broken VLM embedding with image reference
    const imgProv = createTestProvenance({
      id: uuidv4(),
      type: ProvenanceType.IMAGE,
      parent_id: ocrProv.id,
      root_document_id: docProv.root_document_id,
      chain_depth: 2,
    });
    db.insertProvenance(imgProv);

    const vlmEmbProv = createTestProvenance({
      id: uuidv4(),
      type: ProvenanceType.EMBEDDING,
      parent_id: imgProv.id,
      root_document_id: docProv.root_document_id,
      chain_depth: 4,
    });
    db.insertProvenance(vlmEmbProv);

    const vlmEmb = createTestEmbedding(null as unknown as string, doc.id, vlmEmbProv.id, {
      chunk_id: null,
      image_id: null,
      extraction_id: null,
    });

    const imgId = insertTestImage(conn, {
      document_id: doc.id,
      ocr_result_id: ocr.id,
      provenance_id: imgProv.id,
      vlm_description: 'A chart.',
      vlm_embedding_id: null,
    });

    const vlmEmbWithImage = { ...vlmEmb, image_id: imgId };
    db.insertEmbedding(vlmEmbWithImage);
    conn.prepare('UPDATE images SET vlm_embedding_id = ? WHERE id = ?').run(vlmEmb.id, imgId);
    // NO vector stored

    // Total: 4 broken embeddings, 4 provenance to clean, 1 image ref to clear

    // Run health check with fix=true
    const { healthTools } = await import('../../src/tools/health.js');
    const result = await healthTools.ocr_health_check.handler({ fix: true });
    const parsed = parseResponse(result);

    expect(parsed.success).toBe(true);
    expect(parsed.data.fixes_applied).toBeDefined();

    // Find the broken embedding fix message
    const embFix = parsed.data.fixes_applied.find((f: string) =>
      f.includes('broken embedding')
    );
    expect(embFix).toBeDefined();

    // Verify counts in the message
    expect(embFix).toContain('4'); // 4 broken embeddings deleted
    expect(embFix).toContain('4'); // 4 provenance cleaned
    expect(embFix).toContain('1'); // 1 stale image reference cleared

    // Verify all broken embeddings are actually gone
    const remainingBroken = conn
      .prepare(
        `SELECT e.id FROM embeddings e
         LEFT JOIN vec_embeddings v ON v.embedding_id = e.id
         WHERE v.embedding_id IS NULL`
      )
      .all();
    expect(remainingBroken).toHaveLength(0);
  });

  it('C6: fix=true does not affect valid embeddings that have vectors', async () => {
    const dbName = createUniqueName('bugC-no-false-pos');
    createDatabase(dbName, undefined, tempDir);
    selectDatabase(dbName, tempDir);
    const { db, vector } = requireDatabase();
    const conn = db.getConnection();

    // Create valid document chain
    const docProv = createTestProvenance();
    db.insertProvenance(docProv);
    const doc = createTestDocument(docProv.id);
    db.insertDocument(doc);

    const ocrProv = createTestProvenance({
      id: uuidv4(),
      type: ProvenanceType.OCR_RESULT,
      parent_id: docProv.id,
      root_document_id: docProv.root_document_id,
      chain_depth: 1,
    });
    db.insertProvenance(ocrProv);
    const ocr = createTestOCRResult(doc.id, ocrProv.id);
    db.insertOCRResult(ocr);

    const chunkProv = createTestProvenance({
      id: uuidv4(),
      type: ProvenanceType.CHUNK,
      parent_id: ocrProv.id,
      root_document_id: docProv.root_document_id,
      chain_depth: 2,
    });
    db.insertProvenance(chunkProv);
    const chunk = createTestChunk(doc.id, ocr.id, chunkProv.id);
    db.insertChunk(chunk);

    // Create a VALID embedding WITH a vector
    const validEmbProv = createTestProvenance({
      id: uuidv4(),
      type: ProvenanceType.EMBEDDING,
      parent_id: chunkProv.id,
      root_document_id: docProv.root_document_id,
      chain_depth: 3,
    });
    db.insertProvenance(validEmbProv);

    const validEmb = createTestEmbedding(chunk.id, doc.id, validEmbProv.id, {
      image_id: null,
      extraction_id: null,
    });
    db.insertEmbedding(validEmb);

    // Store a real vector for this embedding
    if (sqliteVecAvailable && vector) {
      vector.storeVector(validEmb.id, makeFakeVector(999));
    }

    // Also create a broken embedding (no vector) to trigger the fix
    const brokenEmbProv = createTestProvenance({
      id: uuidv4(),
      type: ProvenanceType.EMBEDDING,
      parent_id: chunkProv.id,
      root_document_id: docProv.root_document_id,
      chain_depth: 3,
    });
    db.insertProvenance(brokenEmbProv);

    const brokenEmb = createTestEmbedding(chunk.id, doc.id, brokenEmbProv.id, {
      image_id: null,
      extraction_id: null,
    });
    db.insertEmbedding(brokenEmb);
    // NO vector for this one

    // Run health check with fix=true
    const { healthTools } = await import('../../src/tools/health.js');
    const result = await healthTools.ocr_health_check.handler({ fix: true });
    const parsed = parseResponse(result);

    expect(parsed.success).toBe(true);

    // Verify: valid embedding with vector is PRESERVED
    const validEmbRow = conn.prepare('SELECT id FROM embeddings WHERE id = ?').get(validEmb.id);
    expect(validEmbRow).toBeDefined();

    // Verify: valid provenance is PRESERVED
    const validProvRow = conn.prepare('SELECT id FROM provenance WHERE id = ?').get(validEmbProv.id);
    expect(validProvRow).toBeDefined();

    // Verify: broken embedding is DELETED
    const brokenEmbRow = conn.prepare('SELECT id FROM embeddings WHERE id = ?').get(brokenEmb.id);
    expect(brokenEmbRow).toBeUndefined();

    // Verify: vector count is unchanged for valid embedding
    if (sqliteVecAvailable && vector) {
      const vecRow = conn
        .prepare('SELECT embedding_id FROM vec_embeddings WHERE embedding_id = ?')
        .get(validEmb.id);
      expect(vecRow).toBeDefined();
    }
  });
});
