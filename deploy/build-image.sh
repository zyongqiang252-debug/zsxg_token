#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "$0")/.."
engine=${CONTAINER_ENGINE:-docker}
image=docker.io/xinguang/new-api:review
context=$(mktemp -d)
trap 'rm -rf -- "$context"' EXIT
if [[ -n "${PREBUILT_BINARY:-}" ]]; then
    cp -- "$PREBUILT_BINARY" "$context/new-api-linux-amd64"
    chmod +x "$context/new-api-linux-amd64"
    cp -- LICENSE NOTICE THIRD-PARTY-LICENSES.md ledongthuc-pdf-LICENSE "$context/"
    "$engine" build -t "$image" -f deploy/Dockerfile.runtime \
        --build-arg "BASE_IMAGE=${BASE_IMAGE:-docker.io/library/debian:bookworm-slim@sha256:f06537653ac770703bc45b4b113475bd402f451e85223f0f2837acbf89ab020a}" \
        --build-arg "DEBIAN_MIRROR=${DEBIAN_MIRROR:-http://deb.debian.org}" "$context"
else
    "$engine" build -t "$image" -f Dockerfile .
fi
mkdir -p ../release
"$engine" save -o "$context/image.tar" "$image"
mv -f -- "$context/image.tar" ../release/xinguang-new-api-review.tar
echo 'Image exported to ../release/xinguang-new-api-review.tar'
