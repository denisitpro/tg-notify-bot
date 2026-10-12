name: ci

# Free-minute budget: run checks only after merge to main (push), never on
# pull_request.
on:
  push:
    branches:
      - main
  workflow_dispatch:

# One ref, one run. A newer push supersedes the previous run instead of
# queueing behind it — there is no point paying for a verdict on a commit
# that has already been superseded.
concurrency:
  group: ci-${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true

permissions:
  contents: read

jobs:
  checks:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@v7

      - uses: oven-sh/setup-bun@v2
        with:
          bun-version-file: version.txt

      - name: bun install
        run: bun install --frozen-lockfile

      - name: typecheck
        run: bun run typecheck

      - name: bun test
        run: bun test

  docker:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@v7

      - name: Resolve Bun toolchain
        id: bunversion
        run: |
          set -euo pipefail
          BUN_VERSION="$(tr -d '[:space:]' < version.txt)"
          if [ -z "$BUN_VERSION" ]; then
            echo "::error::empty version.txt" >&2
            exit 1
          fi
          echo "bun_version=$BUN_VERSION" >> "$GITHUB_OUTPUT"

      - uses: docker/setup-buildx-action@v4

      - name: Resolve build identity
        id: build
        run: |
          set -euo pipefail
          SHORT_SHA="${GITHUB_SHA::7}"
          BRANCH_RAW="$GITHUB_REF_NAME"
          BRANCH="$(printf '%s' "$BRANCH_RAW" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9._-]/-/g' | sed -E 's/-+/-/g' | sed -E 's/^-+|-+$//g')"
          if [ -z "$BRANCH" ]; then
            BRANCH=unknown
          fi
          BUILD_ID="${BRANCH}-${SHORT_SHA}"
          echo "build_id=$BUILD_ID" >> "$GITHUB_OUTPUT"

      - name: Docker build
        run: docker build --build-arg BUN_VERSION=${{ steps.bunversion.outputs.bun_version }} -t tg-notify-bot:ci-${{ steps.build.outputs.build_id }} .
