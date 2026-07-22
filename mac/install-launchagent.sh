#!/bin/sh
set -e

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
NODE_BIN="$(command -v node)"

if [ -z "$NODE_BIN" ]; then
  echo "Node.jsが見つかりません。https://nodejs.org からインストールしてください" >&2
  exit 1
fi

LAUNCH_AGENTS_DIR="$HOME/Library/LaunchAgents"
LOG_DIR="$HOME/Library/Logs/Enchanter"
PLIST_PATH="$LAUNCH_AGENTS_DIR/com.enchanter.server.plist"
TEMPLATE_PATH="$REPO_DIR/mac/com.enchanter.server.plist.template"

mkdir -p "$LAUNCH_AGENTS_DIR"
mkdir -p "$LOG_DIR"

sed \
  -e "s|__NODE_BIN__|$NODE_BIN|g" \
  -e "s|__REPO_DIR__|$REPO_DIR|g" \
  -e "s|__HOME__|$HOME|g" \
  "$TEMPLATE_PATH" > "$PLIST_PATH"

launchctl unload -w "$PLIST_PATH" 2>/dev/null || true
launchctl load -w "$PLIST_PATH"

echo "Enchanterサーバーをログイン時に自動起動するよう設定しました。"
echo "http://localhost:8787 にアクセスできます。"
echo "ログの場所: $LOG_DIR"
echo "止める場合は mac/uninstall-launchagent.sh を実行してください。"
