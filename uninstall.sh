#!/usr/bin/env bash
set -euo pipefail

TARGET="${OPENCODE_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/opencode}"
SHOW_HELP=0
PURGE=0
UNSLIM=0

usage() {
  cat <<'EOF'
Usage: uninstall.sh [--purge] [--unslim] [--help|-h]

Removes yak plugin files from the OpenCode config directory.
  --purge   Prompt to remove user config: $TARGET/yak.jsonc
  --unslim  Remove oh-my-opencode-slim from $TARGET/opencode.json plugin[]
  --help    Show this help
EOF
}

remove_path() {
  local path="$1"
  if [ -L "$path" ] || [ -f "$path" ]; then
    rm -f "$path"
  elif [ -d "$path" ]; then
    rm -rf "$path"
  fi
}

removed=()
preserved=()
backups=()

while [ $# -gt 0 ]; do
  case "$1" in
    --purge) PURGE=1 ;;
    --unslim) UNSLIM=1 ;;
    --help|-h) SHOW_HELP=1 ;;
    *) echo "Unknown option: $1" >&2; usage; exit 1 ;;
  esac
  shift
done

if [ "$SHOW_HELP" -eq 1 ]; then
  usage
  exit 0
fi

if [ -e "$TARGET/yak" ] || [ -L "$TARGET/yak" ]; then
  remove_path "$TARGET/yak"
  removed+=("$TARGET/yak")
else
  preserved+=("$TARGET/yak (not present)")
fi

if [ -e "$TARGET/plugins/yak.js" ] || [ -L "$TARGET/plugins/yak.js" ]; then
  remove_path "$TARGET/plugins/yak.js"
  removed+=("$TARGET/plugins/yak.js")
else
  preserved+=("$TARGET/plugins/yak.js (not present)")
fi

if [ "$PURGE" -eq 1 ]; then
  if [ -e "$TARGET/yak.jsonc" ] || [ -L "$TARGET/yak.jsonc" ]; then
    read -r -p "Remove user config $TARGET/yak.jsonc? [y/N] " ans
    if [ "$ans" = "y" ] || [ "$ans" = "Y" ]; then
      remove_path "$TARGET/yak.jsonc"
      removed+=("$TARGET/yak.jsonc")
    else
      preserved+=("$TARGET/yak.jsonc")
      echo "Skipped $TARGET/yak.jsonc"
    fi
  else
    preserved+=("$TARGET/yak.jsonc (not present)")
  fi
else
  preserved+=("$TARGET/yak.jsonc")
fi

if [ "$UNSLIM" -eq 1 ]; then
  if [ -f "$TARGET/opencode.json" ]; then
    backup="$TARGET/.opencode.json.bak-$(date +%s)"
    cp "$TARGET/opencode.json" "$backup"
    backups+=("$backup")
    node -e '
const fs = require("fs");
const path = process.argv[1];
const data = JSON.parse(fs.readFileSync(path, "utf8"));
if (data && Array.isArray(data.plugin)) {
  data.plugin = data.plugin.filter((item) => item !== "oh-my-opencode-slim");
}
const tmp = `${path}.tmp-${process.pid}`;
fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n");
fs.renameSync(tmp, path);
' "$TARGET/opencode.json"
  else
    preserved+=("$TARGET/opencode.json (not present)")
  fi
else
  preserved+=("$TARGET/opencode.json")
fi

echo "Removed: ${removed[*]:-none}"
echo "Preserved: ${preserved[*]:-none}"
echo "Backups: ${backups[*]:-none}"
