#!/bin/sh
set -eu

find_node() {
  if command -v node >/dev/null 2>&1; then
    command -v node
    return 0
  fi
  for candidate in \
    /opt/homebrew/bin/node \
    /usr/local/bin/node \
    "$HOME/.volta/bin/node" \
    "$HOME/.asdf/shims/node" \
    "$HOME/.fnm/aliases/default/bin/node"
  do
    if [ -x "$candidate" ]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  latest_nvm=""
  for candidate in "$HOME"/.nvm/versions/node/*/bin/node; do
    if [ -x "$candidate" ]; then
      latest_nvm="$candidate"
    fi
  done
  if [ -n "$latest_nvm" ]; then
    printf '%s\n' "$latest_nvm"
    return 0
  fi
  return 1
}

NODE_BIN="$(find_node || true)"
if [ -z "$NODE_BIN" ]; then
  echo "node binary not found in PATH, Homebrew, /usr/local/bin, volta, asdf, fnm, or ~/.nvm" >&2
  exit 1
fi

exec "$NODE_BIN" ./launcher.mjs
