#!/usr/bin/env bash
# 从插件目录生成网站下载用的 skill zip。
# 唯一来源是 plugins/wanapis-media/skills/wanapis-media —— Codex 插件和独立
# skill 共用它，避免两份各自漂移。
set -euo pipefail
cd "$(dirname "$0")/.."
OUT="dist/wanapis-media.zip"
mkdir -p dist
rm -f "$OUT"
( cd plugins/wanapis-media/skills && zip -qr "../../../$OUT" wanapis-media -x '*.DS_Store' '*/._*' )
echo "$OUT — $(unzip -l "$OUT" | tail -1 | awk '{print $2}') files, $(wc -c < "$OUT") bytes"
