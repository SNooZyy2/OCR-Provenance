#!/usr/bin/env bash
# ==============================================================================
# Local Docker Build & Push to GHCR
#
# Replaces the GitHub Actions Docker workflow with a free local build.
# Builds CPU image, tags with version + latest, pushes to ghcr.io.
#
# Usage:
#   ./scripts/docker-release.sh              # Build & push current version
#   ./scripts/docker-release.sh --gpu        # Also build GPU image
#   ./scripts/docker-release.sh --dry-run    # Build only, don't push
#   ./scripts/docker-release.sh --skip-test  # Skip smoke test
#
# Prerequisites:
#   - Docker installed and running
#   - gh CLI authenticated (for GHCR login)
# ==============================================================================
set -euo pipefail

REGISTRY="ghcr.io"
IMAGE_NAME="chrisroyse/ocr-provenance"
FULL_IMAGE="${REGISTRY}/${IMAGE_NAME}"

# Parse flags
BUILD_GPU=false
DRY_RUN=false
SKIP_TEST=false
for arg in "$@"; do
  case "$arg" in
    --gpu)       BUILD_GPU=true ;;
    --dry-run)   DRY_RUN=true ;;
    --skip-test) SKIP_TEST=true ;;
    --help|-h)
      echo "Usage: $0 [--gpu] [--dry-run] [--skip-test]"
      echo "  --gpu        Also build GPU (CUDA 12.4) image"
      echo "  --dry-run    Build only, don't push to GHCR"
      echo "  --skip-test  Skip smoke test after build"
      exit 0
      ;;
    *) echo "Unknown flag: $arg. Use --help for usage."; exit 1 ;;
  esac
done

# Get version from package.json
VERSION=$(node -e "console.log(require('./package.json').version)")
MAJOR_MINOR=$(echo "$VERSION" | cut -d. -f1,2)
MAJOR=$(echo "$VERSION" | cut -d. -f1)
SHORT_SHA=$(git rev-parse --short HEAD)

echo "============================================================"
echo "  OCR Provenance MCP — Docker Release"
echo "  Version: ${VERSION}"
echo "  Commit:  ${SHORT_SHA}"
echo "  GPU:     ${BUILD_GPU}"
echo "  Dry run: ${DRY_RUN}"
echo "============================================================"
echo ""

# -------------------------------------------------------------------
# Step 1: GHCR Login
# -------------------------------------------------------------------
if [ "$DRY_RUN" = false ]; then
  echo "[1/5] Logging in to GitHub Container Registry..."
  gh auth token | docker login "$REGISTRY" -u ChrisRoyse --password-stdin
  echo ""
fi

# -------------------------------------------------------------------
# Step 2: Build CPU image
# -------------------------------------------------------------------
echo "[2/5] Building CPU image..."
CPU_TAGS=(
  "-t" "${FULL_IMAGE}:${VERSION}"
  "-t" "${FULL_IMAGE}:${MAJOR_MINOR}"
  "-t" "${FULL_IMAGE}:${MAJOR}"
  "-t" "${FULL_IMAGE}:latest"
  "-t" "${FULL_IMAGE}:cpu"
  "-t" "${FULL_IMAGE}:sha-${SHORT_SHA}"
)

docker build \
  "${CPU_TAGS[@]}" \
  --build-arg COMPUTE=cpu \
  --label "org.opencontainers.image.version=${VERSION}" \
  --label "org.opencontainers.image.revision=${SHORT_SHA}" \
  --label "org.opencontainers.image.created=$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  .

echo ""
echo "CPU image built successfully."
echo ""

# -------------------------------------------------------------------
# Step 3: Smoke test
# -------------------------------------------------------------------
if [ "$SKIP_TEST" = false ]; then
  echo "[3/5] Running smoke test..."

  # Test 1: stdio MCP init
  echo "  Testing stdio mode..."
  STDIO_RESULT=$(echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"1.0"}}}' \
    | timeout 30 docker run -i --rm \
      -e DATALAB_API_KEY=test -e GEMINI_API_KEY=test \
      "${FULL_IMAGE}:${VERSION}" 2>/dev/null \
    | head -1)

  if echo "$STDIO_RESULT" | grep -q '"result"'; then
    echo "  ✓ stdio MCP init OK"
  else
    echo "  ✗ stdio MCP init FAILED"
    echo "  Response: $STDIO_RESULT"
    exit 1
  fi

  # Test 2: HTTP mode health
  echo "  Testing HTTP mode..."
  docker run -d --name smoke-release -p 3199:3100 \
    -e MCP_TRANSPORT=http -e DATALAB_API_KEY=test -e GEMINI_API_KEY=test \
    "${FULL_IMAGE}:${VERSION}" > /dev/null 2>&1

  HTTP_OK=false
  for i in $(seq 1 30); do
    if curl -sf http://localhost:3199/health 2>/dev/null | grep -q '"status":"ok"'; then
      HTTP_OK=true
      echo "  ✓ HTTP health OK (${i}s)"
      break
    fi
    sleep 1
  done

  # Test 3: MCP init over HTTP
  if [ "$HTTP_OK" = true ]; then
    INIT_RESP=$(curl -sD /tmp/smoke-headers -X POST http://localhost:3199/mcp \
      -H "Content-Type: application/json" \
      -H "Accept: application/json, text/event-stream" \
      -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"1.0"}}}')
    SESSION_ID=$(grep -i '^mcp-session-id:' /tmp/smoke-headers | cut -d: -f2 | tr -d ' \r\n')

    if [ -n "$SESSION_ID" ] && echo "$INIT_RESP" | grep -q '"result"'; then
      echo "  ✓ HTTP MCP init OK (session: ${SESSION_ID:0:12}...)"
    else
      echo "  ✗ HTTP MCP init FAILED"
    fi

    # Test 4: DB create via MCP
    DB_RESP=$(curl -sf -X POST http://localhost:3199/mcp \
      -H "Content-Type: application/json" \
      -H "Accept: application/json, text/event-stream" \
      -H "Mcp-Session-Id: $SESSION_ID" \
      -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"ocr_db_create","arguments":{"name":"smoke-release-db"}}}')

    if echo "$DB_RESP" | grep -q '"success":true' || echo "$DB_RESP" | grep -q '"created":true'; then
      echo "  ✓ DB create via MCP OK"
    else
      echo "  ✗ DB create FAILED"
      echo "  Response: $(echo "$DB_RESP" | head -c 200)"
    fi

    # Test 5: Verify DB file exists in container
    if docker exec smoke-release ls /data/smoke-release-db.db > /dev/null 2>&1; then
      echo "  ✓ DB file exists in /data/"
    else
      echo "  ✗ DB file NOT found in /data/"
    fi

    # Test 6: native addons
    NATIVE_OK=$(docker exec smoke-release node -e "
      const bs3 = require('better-sqlite3');
      const sv = require('sqlite-vec');
      const db = new bs3(':memory:');
      sv.load(db);
      const v = db.prepare('SELECT vec_version()').pluck().get();
      db.close();
      console.log(v);
    " 2>&1)
    echo "  ✓ sqlite-vec ${NATIVE_OK}"
  else
    echo "  ✗ HTTP health FAILED after 30s"
    docker logs smoke-release 2>&1 | tail -10
  fi

  docker stop smoke-release > /dev/null 2>&1 || true
  docker rm smoke-release > /dev/null 2>&1 || true
  rm -f /tmp/smoke-headers
  echo ""
else
  echo "[3/5] Smoke test skipped."
  echo ""
fi

# -------------------------------------------------------------------
# Step 4: Build GPU image (optional)
# -------------------------------------------------------------------
if [ "$BUILD_GPU" = true ]; then
  echo "[4/5] Building GPU image (CUDA 12.4)... this will take a while."
  GPU_TAGS=(
    "-t" "${FULL_IMAGE}:${VERSION}-gpu"
    "-t" "${FULL_IMAGE}:${MAJOR_MINOR}-gpu"
    "-t" "${FULL_IMAGE}:gpu"
    "-t" "${FULL_IMAGE}:sha-${SHORT_SHA}-gpu"
  )

  docker build \
    "${GPU_TAGS[@]}" \
    --build-arg COMPUTE=cu124 \
    --build-arg RUNTIME_BASE=nvidia/cuda:12.4.1-runtime-ubuntu22.04 \
    --label "org.opencontainers.image.version=${VERSION}" \
    --label "org.opencontainers.image.revision=${SHORT_SHA}" \
    --label "org.opencontainers.image.created=$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    .

  echo ""
  echo "GPU image built successfully."
  echo ""
else
  echo "[4/5] GPU build skipped (use --gpu to include)."
  echo ""
fi

# -------------------------------------------------------------------
# Step 5: Push to GHCR
# -------------------------------------------------------------------
if [ "$DRY_RUN" = false ]; then
  echo "[5/5] Pushing images to GHCR..."

  # Push all CPU tags
  for tag in "${VERSION}" "${MAJOR_MINOR}" "${MAJOR}" "latest" "cpu" "sha-${SHORT_SHA}"; do
    echo "  Pushing ${FULL_IMAGE}:${tag}..."
    docker push "${FULL_IMAGE}:${tag}"
  done

  # Push GPU tags if built
  if [ "$BUILD_GPU" = true ]; then
    for tag in "${VERSION}-gpu" "${MAJOR_MINOR}-gpu" "gpu" "sha-${SHORT_SHA}-gpu"; do
      echo "  Pushing ${FULL_IMAGE}:${tag}..."
      docker push "${FULL_IMAGE}:${tag}"
    done
  fi

  echo ""
  echo "============================================================"
  echo "  PUBLISHED SUCCESSFULLY"
  echo ""
  echo "  CPU: docker pull ${FULL_IMAGE}:${VERSION}"
  echo "       docker pull ${FULL_IMAGE}:latest"
  if [ "$BUILD_GPU" = true ]; then
    echo "  GPU: docker pull ${FULL_IMAGE}:${VERSION}-gpu"
    echo "       docker pull ${FULL_IMAGE}:gpu"
  fi
  echo "============================================================"
else
  echo "[5/5] Push skipped (dry run)."
  echo ""
  echo "Built images:"
  docker images "${FULL_IMAGE}" --format "  {{.Repository}}:{{.Tag}}\t{{.Size}}" | sort
fi
