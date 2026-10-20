#!/usr/bin/env bash
# Builds the web app and publishes it to the gh-pages branch (GitHub Pages
# serves that branch directly, so no Actions minutes are needed).
# Usage: npm run deploy:web
set -euo pipefail

cd "$(dirname "$0")/.."
# uncommitted changes, or new files where the build can pick them up, would ship
# something that isn't in git; stray files elsewhere (screenshots, notes) don't matter
if [ -n "$(git status --porcelain --untracked-files=no)" ] || [ -n "$(git ls-files --others --exclude-standard -- src public index.html vite.config.ts package.json)" ]; then
  echo "Working tree is not clean; commit or stash first." >&2
  exit 1
fi

sha=$(git rev-parse --short HEAD)
BASE_PATH=/nodal/ npx vite build

out=$(mktemp -d)
trap 'git worktree remove --force "$out" 2>/dev/null || rm -rf "$out"' EXIT

git fetch -q origin gh-pages 2>/dev/null || true
if git rev-parse -q --verify origin/gh-pages >/dev/null; then
  git worktree add -q -B gh-pages "$out" origin/gh-pages
else
  git worktree add -q --detach "$out"
  git -C "$out" checkout -q --orphan gh-pages
fi

git -C "$out" rm -rqf --ignore-unmatch .
cp -r dist/. "$out"/
touch "$out"/.nojekyll
git -C "$out" add -A
if git -C "$out" diff --cached --quiet; then
  echo "gh-pages already up to date."
  exit 0
fi
git -C "$out" commit -q -m "deploy: web app from $sha"
git -C "$out" push -q origin gh-pages
echo "Deployed $sha to gh-pages."
