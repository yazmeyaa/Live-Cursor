#!/usr/bin/env bash
set -Eeuo pipefail

PROJECT_DIR="/home/eugene/programming/js/Live-Cursor"
VAULT_DIR="/home/eugene/obsidian_data/teseting"

PLUGIN_ID="laplas-cowork"
PLUGIN_NAME="Laplas Cowork"
PLUGIN_DIR="$VAULT_DIR/.obsidian/plugins/$PLUGIN_ID"
COMMUNITY_PLUGINS="$VAULT_DIR/.obsidian/community-plugins.json"

echo "==> Проверка каталогов"

[[ -f "$PROJECT_DIR/package.json" ]] || {
  echo "Ошибка: проект не найден: $PROJECT_DIR"
  exit 1
}

[[ -d "$VAULT_DIR/.obsidian" ]] || {
  echo "Ошибка: Obsidian vault не найден: $VAULT_DIR"
  exit 1
}

echo "==> Установка зависимостей и сборка"

cd "$PROJECT_DIR"
npm ci --legacy-peer-deps
npm run typecheck
npm run build

for artifact in main.js manifest.json; do
  [[ -f "$PROJECT_DIR/$artifact" ]] || {
    echo "Ошибка: после сборки отсутствует $artifact"
    exit 1
  }
done

echo "==> Установка плагина в $PLUGIN_DIR"

mkdir -p "$PLUGIN_DIR"

install -m 0644 "$PROJECT_DIR/main.js" "$PLUGIN_DIR/main.js"
install -m 0644 "$PROJECT_DIR/manifest.json" "$PLUGIN_DIR/manifest.json"

echo "==> Включение плагина в Obsidian"

node - "$COMMUNITY_PLUGINS" "$PLUGIN_ID" <<'NODE'
const fs = require("fs");

const [, , communityFile, pluginId] = process.argv;

let plugins = [];

if (fs.existsSync(communityFile)) {
  plugins = JSON.parse(fs.readFileSync(communityFile, "utf8"));
}

if (!Array.isArray(plugins)) {
  throw new Error(`${communityFile} должен содержать JSON-массив`);
}

if (!plugins.includes(pluginId)) {
  plugins.push(pluginId);
}

fs.writeFileSync(
  communityFile,
  JSON.stringify(plugins, null, 2) + "\n"
);
NODE

echo
echo "Установка завершена:"
echo "  Имя:   $PLUGIN_NAME"
echo "  ID:    $PLUGIN_ID"
echo "  Папка: $PLUGIN_DIR"
echo
echo "Теперь полностью перезапусти Obsidian."
