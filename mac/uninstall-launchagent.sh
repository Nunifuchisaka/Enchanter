#!/bin/sh
set -e

PLIST_PATH="$HOME/Library/LaunchAgents/com.enchanter.server.plist"

if [ ! -f "$PLIST_PATH" ]; then
  echo "インストールされていません($PLIST_PATH が見つかりません)"
  exit 0
fi

launchctl unload -w "$PLIST_PATH"
rm -f "$PLIST_PATH"

echo "Enchanterサーバーの自動起動設定を解除しました。"
