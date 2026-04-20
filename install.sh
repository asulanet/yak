#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

usage() {
  cat <<'EOF'
Usage: ./install.sh --copy|--link [--no-slim]

Flags:
  --copy      Copy yak into opencode config directory
  --link      Symlink yak into opencode config directory
  --no-slim   Skip opencode.json slim registration
  -h, --help  Show this help and exit

Behavior:
  - Exactly one of --copy or --link is required.
  - Target resolves from OPENCODE_CONFIG_DIR, else XDG_CONFIG_HOME/opencode, else $HOME/.config/opencode.
  - Existing yak and plugins/yak.js are backed up before replacement.
  - Slim is registered in opencode.json unless --no-slim is passed.
EOF
}

error() {
  printf '%s\n' "$*" >&2
}

MODE=""
NO_SLIM=0
ts=""

while (($#)); do
  case "$1" in
    --copy)
      if [[ -n "$MODE" && "$MODE" != "copy" ]]; then
        error "mutually exclusive"
        exit 1
      fi
      MODE="copy"
      ;;
    --link)
      if [[ -n "$MODE" && "$MODE" != "link" ]]; then
        error "mutually exclusive"
        exit 1
      fi
      MODE="link"
      ;;
    --no-slim)
      NO_SLIM=1
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      error "Unknown flag: $1"
      usage
      exit 1
      ;;
  esac
  shift
done

if [[ -z "$MODE" ]]; then
  usage
  exit 1
fi

if [[ -n "${OPENCODE_CONFIG_DIR:-}" ]]; then
  TARGET="$OPENCODE_CONFIG_DIR"
elif [[ -n "${XDG_CONFIG_HOME:-}" ]]; then
  TARGET="$XDG_CONFIG_HOME/opencode"
else
  TARGET="$HOME/.config/opencode"
fi

if [[ ! -d "$TARGET" ]]; then
  error "Target config directory does not exist: $TARGET"
  exit 1
fi

mkdir -p "$TARGET/plugins"

backup_dir=""
if [[ -e "$TARGET/yak" || -L "$TARGET/yak" || -e "$TARGET/plugins/yak.js" || -L "$TARGET/plugins/yak.js" ]]; then
  ts="$(date +%s)"
  backup_dir="$TARGET/.yak-backup-$ts"
  mkdir -p "$backup_dir/yak" "$backup_dir/plugins"
  if [[ -e "$TARGET/yak" || -L "$TARGET/yak" ]]; then
    mv "$TARGET/yak" "$backup_dir/yak/"
  fi
  if [[ -e "$TARGET/plugins/yak.js" || -L "$TARGET/plugins/yak.js" ]]; then
    mv "$TARGET/plugins/yak.js" "$backup_dir/plugins/yak.js"
  fi
fi

if [[ "$MODE" == "link" ]]; then
  ln -s "$SCRIPT_DIR/yak" "$TARGET/yak"
  ln -s "$SCRIPT_DIR/plugins/yak.js" "$TARGET/plugins/yak.js"
else
  cp -R "$SCRIPT_DIR/yak" "$TARGET/yak"
  cp "$SCRIPT_DIR/plugins/yak.js" "$TARGET/plugins/yak.js"
fi

installed_files=("$TARGET/yak" "$TARGET/plugins/yak.js")

if [[ ! -e "$TARGET/yak.jsonc" ]]; then
  if [[ -f "$SCRIPT_DIR/examples/yak.jsonc.example" ]]; then
    cp "$SCRIPT_DIR/examples/yak.jsonc.example" "$TARGET/yak.jsonc"
    installed_files+=("$TARGET/yak.jsonc")
  else
    printf '%s\n' "Note: examples/yak.jsonc.example missing; skipping yak.jsonc seed" >&2
  fi
fi

if [[ "$NO_SLIM" -eq 0 ]]; then
  if [[ -z "$ts" ]]; then
    ts="$(date +%s)"
  fi
  if [[ -f "$TARGET/opencode.json" ]]; then
    cp "$TARGET/opencode.json" "$TARGET/.opencode.json.bak-$ts"
  else
    : > "$TARGET/.opencode.json.bak-$ts"
  fi
  node -e '
const fs = require("fs");
const path = process.argv[1];
const data = fs.readFileSync(path, "utf8");
let obj = data.trim() ? JSON.parse(data) : {};
if (!Array.isArray(obj.plugin)) obj.plugin = [];
if (!obj.plugin.includes("oh-my-opencode-slim")) obj.plugin.push("oh-my-opencode-slim");
const out = JSON.stringify(obj, null, 2) + "\n";
const tmp = `${path}.tmp-${process.pid}`;
fs.writeFileSync(tmp, out);
fs.renameSync(tmp, path);
' "$TARGET/opencode.json"
  printf '%s\n' "Note: slim registered in $TARGET/opencode.json"
else
  printf '%s\n' "skipping slim; add 'oh-my-opencode-slim' to opencode.json plugin[] manually to enable council/oracle routing"
fi

echo "Mode: $MODE"
echo "Target: $TARGET"
echo "Installed:"
for f in "${installed_files[@]}"; do
  echo "  - $f"
done
if [[ -n "$backup_dir" ]]; then
  echo "Backups: $backup_dir"
else
  echo "Backups: none"
fi
echo "Next: restart opencode to pick up new plugin"
