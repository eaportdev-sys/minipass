#!/bin/bash
# Build minipass base images — run once on host setup
# Usage: ./build-base-images.sh [registry/]prefix

set -euo pipefail

PREFIX="${1:-minipass}"
BUILDKIT=1

echo "Building base images with prefix: ${PREFIX}"

# Build builder image (with all build tools + pre-compiled native modules)
echo "Building ${PREFIX}/node:22-builder..."
DOCKER_BUILDKIT=1 docker build \
  --tag "${PREFIX}/node:22-builder" \
  --file templates/base/node.Dockerfile \
  --target builder \
  .

# Build runtime image (minimal, only runtime deps)
echo "Building ${PREFIX}/node:22-runtime..."
DOCKER_BUILDKIT=1 docker build \
  --tag "${PREFIX}/node:22-runtime" \
  --file templates/base/node-runtime.Dockerfile \
  .

# Build combined base image (alias for backward compat)
echo "Building ${PREFIX}/node:22..."
docker tag "${PREFIX}/node:22-runtime" "${PREFIX}/node:22"

echo "Base images built:"
docker images "${PREFIX}/node" --format "table {{.Repository}}\t{{.Tag}}\t{{.Size}}"

echo ""
echo "To push to registry:"
echo "  docker push ${PREFIX}/node:22-builder"
echo "  docker push ${PREFIX}/node:22-runtime"
echo "  docker push ${PREFIX}/node:22"