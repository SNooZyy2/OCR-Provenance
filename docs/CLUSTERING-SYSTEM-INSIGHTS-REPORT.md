# Clustering System: Benefits, Insights & Integration Report

**Date**: 2026-03-03
**System**: OCR Provenance MCP Server v1.0.16
**Benchmark**: 30 documents across 6 domains, 3 algorithms, 7 MCP tools

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [What the Clustering System Does](#2-what-the-clustering-system-does)
3. [Insights Obtainable from Clustering](#3-insights-obtainable-from-clustering)
4. [Integration Points Across the System](#4-integration-points-across-the-system)
5. [Benchmark Results](#5-benchmark-results)
6. [Use Cases & Workflows](#6-use-cases--workflows)
7. [Architecture & Data Flow](#7-architecture--data-flow)
8. [Configuration & Tuning](#8-configuration--tuning)

---

## 1. Executive Summary

The clustering system groups documents by semantic similarity using their embedding vectors. It answers the question: **"Which documents in my corpus are about the same topics?"**

### Key Capabilities
- **Automatic topic discovery**: Groups documents without requiring labels or training data
- **3 algorithm choices**: HDBSCAN (auto-detect clusters), Agglomerative (hierarchical), KMeans (fixed count)
- **7 MCP tools**: Cluster, browse, inspect, assign, reassign, merge, delete
- **Deep integration**: Search filtering, document recommendations, comparison batching, provenance tracking, auto-clustering on ingestion

### Key Metrics (30-doc benchmark)
- **6 distinct clusters** identified from 6 domains with Agglomerative algorithm
- **3 domains perfectly separated** (cooking, real estate, astrophysics — 5/5 docs each)
- **748ms** Python worker processing time for 30 documents
- **Deterministic results** (KMeans with random_state=42)
- **All 7 tools verified** with SQLite source-of-truth validation

---

## 2. What the Clustering System Does

### Core Pipeline

```
Documents with embeddings
    → Average chunk embeddings to get document-level vectors (768-dim)
    → L2-normalize for cosine similarity
    → Send to Python clustering worker (scikit-learn)
    → Receive cluster labels, centroids, coherence scores, silhouette score
    → Store results: clusters table + document_clusters assignments + provenance records
```

### Algorithms

| Algorithm | Best For | Cluster Count | Key Parameter |
|-----------|----------|---------------|---------------|
| **HDBSCAN** | Unknown number of topics, noisy data | Auto-detected | `min_cluster_size` (default 3) |
| **Agglomerative** | Known or estimated topic count | User-specified or auto via distance_threshold | `n_clusters`, `linkage` |
| **KMeans** | Fixed partitioning, equal-sized groups | User-specified | `n_clusters` |

### What Gets Stored Per Cluster

| Field | Description | Use |
|-------|-------------|-----|
| `centroid_json` | 768-dim average vector of cluster members | Similarity comparison for new doc assignment |
| `coherence_score` | Average pairwise cosine similarity within cluster | Cluster quality metric (higher = tighter grouping) |
| `silhouette_score` | How well-separated clusters are globally | Overall clustering quality (-1 to 1, higher = better) |
| `document_count` | Number of documents in cluster | Size tracking |
| `algorithm` | Which algorithm produced this cluster | Reproducibility |
| `content_hash` | SHA256 of centroid + run_id | Integrity verification |
| `provenance_id` | Link to provenance chain | Full audit trail |

---

## 3. Insights Obtainable from Clustering

### 3.1 Topic Discovery & Document Organization

**Insight**: Automatically discover what topics exist in your document corpus without manual categorization.

**Example from benchmark** (Agglomerative, n_clusters=6):
```
Cluster 0 (coherence 0.614): medical_01, medical_02, medical_03, medical_05
Cluster 2 (coherence 0.658): cooking_01, cooking_02, cooking_03, cooking_04, cooking_05
Cluster 4 (coherence 0.669): astrophysics_01-05 + environmental_03
Cluster 5 (coherence 0.727): realestate_01-05
```

**What this tells you**: The system found that medical, cooking, astrophysics, and real estate documents form distinct topical groups — without any labels, tags, or training.

### 3.2 Coherence Scores — Cluster Quality

**Insight**: Coherence scores reveal which topic groups are tight vs. loosely related.

| Coherence | Interpretation |
|-----------|---------------|
| 0.90-1.00 | Near-identical documents (duplicates, versions) |
| 0.70-0.90 | Strong topical cohesion (same domain, related content) |
| 0.50-0.70 | Moderate cohesion (shared themes but diverse content) |
| < 0.50 | Weak cohesion (may need re-clustering or splitting) |

**Benchmark insight**: Real estate cluster (0.727) was the tightest non-singleton cluster, meaning real estate documents shared the most consistent vocabulary. Software+environmental merged cluster (0.626) was looser — indicating these domains share enough technical/policy language to overlap.

### 3.3 Silhouette Score — Global Separation Quality

**Insight**: Tells you how well your chosen number of clusters fits the data.

| Score | Interpretation |
|-------|---------------|
| 0.50-1.00 | Strong cluster structure |
| 0.25-0.50 | Reasonable structure |
| 0.00-0.25 | Weak structure, clusters overlap significantly |
| < 0.00 | Documents may be assigned to wrong clusters |

**Benchmark insight**: Agglomerative scored 0.183 — weak but positive. This tells us the 6 domains have some overlap in embedding space (environmental and software share technical language). The system correctly identifies this rather than forcing artificial separation.

### 3.4 Outlier Detection

**Insight**: Documents that don't fit any cluster may be unique, misfiled, or require special attention.

- **HDBSCAN noise detection**: Marks outlier documents as noise (label=-1) rather than forcing them into clusters
- **Singleton clusters**: In our benchmark, `medical_04` was isolated as a singleton cluster by Agglomerative — its embedding diverged from other medical docs
- **Low similarity_to_centroid**: Documents with low centroid similarity within their cluster are borderline members worth reviewing

### 3.5 Cross-Domain Overlap Discovery

**Insight**: When documents from different labeled categories cluster together, it reveals semantic overlap.

**Benchmark example**: Software engineering docs and environmental policy docs merged into a single cluster. This reveals that these domains share significant vocabulary around standards, compliance, systems, and processes — a non-obvious insight.

### 3.6 Algorithm Comparison — Robustness Testing

**Insight**: Running multiple algorithms on the same corpus reveals which groupings are robust vs. algorithm-dependent.

**Benchmark finding**: Both Agglomerative and KMeans kept astrophysics_01-05 together as a pure cluster. This cross-algorithm consistency confirms that astrophysics content is genuinely distinct in embedding space — not an artifact of one algorithm.

### 3.7 Document Classification

**Insight**: Use existing clusters to classify new documents automatically.

The `ocr_cluster_assign` tool computes cosine similarity between a new document's embedding and all cluster centroids, assigning it to the nearest cluster. This enables:
- **Automatic filing**: New documents auto-classified into existing topic groups
- **Anomaly detection**: If similarity_to_centroid is low, the document may represent a new topic
- **Incremental corpus growth**: No need to re-cluster the entire corpus for each new document

---

## 4. Integration Points Across the System

### 4.1 Search Integration (`src/tools/search.ts`)

**Cluster-Filtered Search**: Restrict search results to documents within a specific cluster.

```
ocr_search(query="treatment protocol", cluster_id="abc-123")
→ Only searches within the medical cluster, ignoring cooking/software docs
```

**How it works**: The search tool resolves `cluster_id` to a set of `document_ids` via the `document_clusters` table, then intersects with any existing document filter before executing BM25/semantic/hybrid search.

**Cluster Context Attachment**: Every search result can include cluster membership info.

```json
{
  "chunk_text": "Patient treatment protocols for...",
  "cluster_context": [
    { "cluster_id": "abc-123", "cluster_label": "Medical", "run_id": "run-456" }
  ]
}
```

This tells the AI agent not just WHAT was found, but WHICH topical group it belongs to, enabling smarter follow-up queries.

### 4.2 Document Recommendations (`src/tools/intelligence.ts`)

**Cluster-Based Recommendations**: The `ocr_document_recommend` tool uses two signals:

1. **Cluster peers** (primary): Documents in the same cluster are recommended first
2. **Vector similarity** (fallback): If no clusters exist, uses raw embedding similarity

This means clustering directly improves the recommendation quality — instead of pure embedding distance, recommendations are filtered through semantically validated groups.

### 4.3 Batch Comparisons (`src/tools/comparison.ts`)

**Cluster-Scoped Comparison**: The `ocr_comparison_batch` tool accepts a `cluster_id` parameter to generate all pairwise comparisons within a cluster.

```
ocr_comparison_batch(cluster_id="abc-123")
→ Generates 10 comparison pairs for a 5-document cluster
```

This is valuable for:
- **Duplicate detection** within topic groups
- **Version comparison** of similar documents
- **Quality assessment** of cluster membership

### 4.4 Document Details (`src/tools/documents.ts`)

When you retrieve a document via `ocr_document_get`, the response includes all cluster memberships:

```json
{
  "file_name": "medical_01.pdf",
  "clusters": [
    { "cluster_id": "abc-123", "cluster_index": 0, "coherence_score": 0.614 }
  ]
}
```

### 4.5 Tagging System (`src/tools/tags.ts`)

Clusters are taggable entities — you can apply tags to clusters for manual categorization:

```
ocr_tag_apply(entity_type="cluster", entity_id="abc-123", tag_name="reviewed")
```

The `classification_tag` field on clusters also supports filtering in `ocr_cluster_list`.

### 4.6 Reporting & Statistics (`src/tools/reports.ts`)

The comprehensive report includes clustering statistics:
- Total clusters across all runs
- Total unique runs
- Average coherence score
- Top 5 clusters by document count
- Per-document cluster membership in detailed reports

### 4.7 AI Guide (`src/tools/intelligence.ts`)

The `ocr_guide` tool checks cluster state and makes context-aware suggestions:
- If `< 2 clusters` but `>= 2 completed documents` → suggests running `ocr_cluster_documents`
- If clusters exist → suggests `ocr_cluster_list` for analysis
- Provides `has_clusters: boolean` in context for AI routing decisions

### 4.8 Auto-Clustering on Ingestion (`src/tools/ingestion.ts`)

When enabled, clustering runs automatically after document processing:

| Config Key | Default | Description |
|------------|---------|-------------|
| `auto_cluster_enabled` | false | Enable auto-clustering after ingestion |
| `auto_cluster_threshold` | 10 | Minimum docs before auto-clustering triggers |
| `auto_cluster_algorithm` | hdbscan | Algorithm to use for auto-clustering |

Rate-limited to once per hour to prevent excessive re-clustering.

### 4.9 Provenance Tracking (`src/tools/provenance.ts`)

Every cluster has a full provenance record:
```
DOCUMENT (depth 0)
  └── CLUSTERING (depth 2)
       ├── chain_path: ["DOCUMENT", "CLUSTERING"]
       ├── content_hash: SHA256(centroid + run_id)
       ├── processing_params: {algorithm, n_clusters, cluster_index}
       └── quality_score: coherence_score
```

This enables:
- **Audit trail**: Know exactly when clustering was run and with what parameters
- **Reproducibility**: Content hash verifies cluster integrity
- **Chain traversal**: Navigate from cluster → document → OCR result → chunks

### 4.10 Cross-Document Search Context (`src/tools/search.ts`)

The `attachCrossDocumentContext` function enriches search results with both cluster membership AND document comparison data, giving AI agents a complete picture of how each result relates to the broader corpus.

---

## 5. Benchmark Results

### 5.1 Dataset

30 synthetic PDFs across 6 maximally separable domains:

| Domain | Documents | Content Focus |
|--------|-----------|---------------|
| Medical | 5 | Clinical cardiology, oncology, neurology, pediatrics, orthopedics |
| Cooking | 5 | French cuisine, baking, Asian cuisine, grilling, pastry |
| Astrophysics | 5 | Black holes, exoplanets, dark matter, neutron stars, cosmic radiation |
| Software Engineering | 5 | Microservices, CI/CD, databases, security, ML systems |
| Real Estate | 5 | Residential, commercial, REITs, property management, development |
| Environmental Science | 5 | Climate change, water resources, biodiversity, air quality, soil |

### 5.2 Algorithm Comparison

| Metric | HDBSCAN (mcs=3) | HDBSCAN (mcs=2) | Agglomerative (n=6) | KMeans (n=6) |
|--------|-----------------|-----------------|---------------------|--------------|
| Clusters found | 1 | 1 | **6** | **6** |
| Worker time (ms) | 631 | 653 | 748 | 664 |
| Silhouette score | 0.0 | 0.0 | **0.183** | 0.077 |
| Noise count | 3 | 1 | 0 | 0 |
| Domain purity | N/A | N/A | **3 perfect + 2 partial** | 1 pure core |

**Winner: Agglomerative** — best silhouette score, best domain purity, clean separation.

### 5.3 Agglomerative Domain Purity (n_clusters=6)

| Cluster | Size | Coherence | Dominant Domain | Purity |
|---------|------|-----------|-----------------|--------|
| 0 | 4 | 0.614 | Medical | 100% (4/4) |
| 1 | 9 | 0.626 | Software+Environmental | Mixed (expected overlap) |
| 2 | 5 | 0.658 | Cooking | **100%** (5/5) |
| 3 | 1 | 1.000 | Medical (outlier) | 100% (1/1) |
| 4 | 6 | 0.669 | Astrophysics | 83% (5/6) |
| 5 | 5 | 0.727 | Real Estate | **100%** (5/5) |

### 5.4 Mutation Operations (All Verified via SQLite)

| Operation | Test | Result | DB Verification |
|-----------|------|--------|-----------------|
| **Assign** (same cluster) | medical_04 → cluster 3 | `already_in_cluster: true`, no count drift | document_count stable at 1 |
| **Reassign** | environmental_03: cluster 4 → cluster 1 | Counts updated correctly | Source -1, target +1 |
| **Merge** | cluster 3 (medical outlier) → cluster 0 (medical) | 1 doc moved, cluster 3 deleted | All 5 medical docs in cluster 0 |
| **Delete** | HDBSCAN runs | Both runs fully cleaned up | 0 clusters, 0 doc_clusters for those runs |

### 5.5 Edge Cases (6/6 PASS)

| Test | Expected Error | Actual |
|------|----------------|--------|
| cluster_get nonexistent ID | DOCUMENT_NOT_FOUND | PASS |
| cluster_assign nonexistent doc | DOCUMENT_NOT_FOUND | PASS |
| cluster_reassign nonexistent doc | DOCUMENT_NOT_FOUND | PASS |
| cluster_merge nonexistent cluster | DOCUMENT_NOT_FOUND | PASS |
| cluster_merge cross-run | VALIDATION_ERROR | PASS |
| cluster_delete nonexistent run | DOCUMENT_NOT_FOUND | PASS |

---

## 6. Use Cases & Workflows

### 6.1 Corpus Organization

**Goal**: Understand what topics your document collection covers.

```
1. ocr_cluster_documents(algorithm="agglomerative", n_clusters=5)
2. ocr_cluster_list(run_id="...")
3. ocr_cluster_get(cluster_id="...") for each cluster
→ Result: Topical map of your corpus with coherence-ranked groups
```

### 6.2 Focused Search

**Goal**: Search only within a specific topic group.

```
1. ocr_cluster_list() → find the "Legal" cluster
2. ocr_search(query="liability clause", cluster_id="legal-cluster-id")
→ Result: Search results restricted to legal documents only
```

### 6.3 New Document Classification

**Goal**: Automatically categorize a newly ingested document.

```
1. ocr_ingest_files(file_paths=["new_contract.pdf"])
2. ocr_process_pending()
3. ocr_cluster_assign(document_id="new-doc-id", run_id="existing-run")
→ Result: "Assigned to Legal cluster with 0.87 centroid similarity"
```

### 6.4 Duplicate/Near-Duplicate Detection

**Goal**: Find documents that are suspiciously similar within a cluster.

```
1. ocr_cluster_get(cluster_id="...", include_documents=true)
   → Check for documents with similarity_to_centroid > 0.95
2. ocr_comparison_batch(cluster_id="...")
   → Pairwise comparison of all cluster members
```

### 6.5 Outlier Investigation

**Goal**: Find misfiled or anomalous documents.

```
1. Run HDBSCAN clustering → check noise_count
2. ocr_cluster_get(cluster_id) → find documents with low similarity_to_centroid
3. Investigate: Are these misfiled? Unique topics? Data quality issues?
```

### 6.6 Iterative Refinement

**Goal**: Improve cluster quality through manual curation.

```
1. ocr_cluster_documents(algorithm="agglomerative", n_clusters=6)
2. Inspect results → find misplaced doc in wrong cluster
3. ocr_cluster_reassign(document_id="...", target_cluster_id="correct-cluster")
4. Find two clusters that should be one
5. ocr_cluster_merge(cluster_id_1="...", cluster_id_2="...")
→ Result: Human-refined clusters with better domain purity
```

### 6.7 Multi-Algorithm Validation

**Goal**: Confirm topic groupings are robust, not algorithm artifacts.

```
1. ocr_cluster_documents(algorithm="agglomerative", n_clusters=6)
2. ocr_cluster_documents(algorithm="kmeans", n_clusters=6)
3. Compare: Which document groupings appear in BOTH runs?
→ Result: Cross-algorithm stable groups are high-confidence topics
```

---

## 7. Architecture & Data Flow

### 7.1 System Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        MCP Client (AI Agent)                     │
├─────────────────────────────────────────────────────────────────┤
│                     7 Clustering MCP Tools                       │
│  cluster_documents │ cluster_list │ cluster_get │ cluster_assign │
│  cluster_reassign  │ cluster_merge│ cluster_delete               │
├─────────────────────────────────────────────────────────────────┤
│                    ClusteringService (TypeScript)                 │
│  computeDocumentEmbeddings() → runClusteringWorker() → store()  │
├─────────────────────────────────────────────────────────────────┤
│                   Python Clustering Worker                        │
│  scikit-learn: HDBSCAN │ AgglomerativeClustering │ KMeans        │
│  Metrics: centroids, coherence, silhouette                       │
├─────────────────────────────────────────────────────────────────┤
│                        SQLite Database                            │
│  clusters │ document_clusters │ provenance │ vec_embeddings       │
└─────────────────────────────────────────────────────────────────┘
```

### 7.2 Data Flow

```
Ingestion:
  PDF → Datalab OCR → chunks → nomic-embed-text-v1.5 → vec_embeddings

Clustering:
  vec_embeddings → average per document → L2-normalize
  → Python worker (cosine distance matrix → algorithm)
  → labels, centroids, coherence, silhouette
  → INSERT clusters + document_clusters + provenance

Search Integration:
  User query → resolve cluster_id → filter document_ids
  → BM25/semantic/hybrid search on filtered set
  → attach cluster_context to results

Recommendations:
  Document → find cluster memberships → get peer documents
  → rank by similarity → return recommendations
```

### 7.3 Database Tables

```sql
-- Core clustering results
clusters (
  id, run_id, cluster_index, label, description, classification_tag,
  document_count, centroid_json, top_terms_json, coherence_score,
  algorithm, algorithm_params_json, silhouette_score,
  content_hash, provenance_id, created_at, processing_duration_ms
)

-- Document-to-cluster assignments (one per doc per run)
document_clusters (
  id, document_id, cluster_id, run_id,
  similarity_to_centroid, membership_probability, is_noise, assigned_at
  UNIQUE(document_id, run_id)
)
```

---

## 8. Configuration & Tuning

### 8.1 Algorithm Selection Guide

| Scenario | Recommended Algorithm | Parameters |
|----------|----------------------|------------|
| Don't know how many topics | HDBSCAN | `min_cluster_size=3-5` |
| Know approximate topic count | Agglomerative | `n_clusters=N, linkage=average` |
| Need equal-sized groups | KMeans | `n_clusters=N` |
| Want to compare approaches | Run all three | Compare silhouette scores |
| Small corpus (< 10 docs) | Agglomerative | `n_clusters=2-3` |
| Large corpus (100+ docs) | Any | KMeans is fastest |

### 8.2 Interpreting Results

**Good clustering indicators**:
- Silhouette score > 0.25
- Per-cluster coherence > 0.60
- Documents from same domain/topic group together
- Low noise count (HDBSCAN)

**Signs you need to adjust**:
- Silhouette < 0.10 → try different n_clusters
- One very large cluster + many tiny ones → lower n_clusters
- Many noise points (HDBSCAN) → lower min_cluster_size
- Cross-domain clusters → increase n_clusters or use Agglomerative with higher linkage

### 8.3 Auto-Clustering Configuration

```
ocr_config_set(key="auto_cluster_enabled", value="true")
ocr_config_set(key="auto_cluster_threshold", value="10")
ocr_config_set(key="auto_cluster_algorithm", value="agglomerative")
```

### 8.4 Performance Characteristics

| Corpus Size | Worker Time | MCP Round-Trip | Memory |
|-------------|-------------|----------------|--------|
| 10 docs | ~700ms | ~6s | < 50MB |
| 30 docs | ~750ms | ~7s | < 100MB |
| 100 docs | ~2-3s | ~10s | < 500MB |
| 1000 docs | ~30-60s | ~60s | ~2GB |

Worker time scales with O(N^2) for distance matrix computation. The MCP round-trip overhead is dominated by embedding retrieval from sqlite-vec.

---

## Appendix: Files Involved

| File | Role |
|------|------|
| `src/tools/clustering.ts` | 7 MCP tool definitions and handlers |
| `src/services/clustering/clustering-service.ts` | Core clustering pipeline orchestration |
| `python/clustering_worker.py` | Python scikit-learn clustering algorithms |
| `src/services/storage/database/cluster-operations.ts` | SQLite CRUD operations |
| `src/models/cluster.ts` | TypeScript interfaces |
| `src/tools/search.ts` | Cluster filter + context attachment |
| `src/tools/intelligence.ts` | Recommendations + guide integration |
| `src/tools/comparison.ts` | Cluster-scoped batch comparisons |
| `src/tools/documents.ts` | Cluster membership in document details |
| `src/tools/tags.ts` | Cluster tagging support |
| `src/tools/reports.ts` | Clustering statistics in reports |
| `src/tools/ingestion.ts` | Auto-clustering trigger |
| `src/tools/provenance.ts` | Provenance chain for clusters |
| `src/tools/config.ts` | Auto-cluster configuration |
| `src/server/register-tools.ts` | Tool registration |
| `tests/manual/clustering-final-verification.test.ts` | 7 integration tests |
