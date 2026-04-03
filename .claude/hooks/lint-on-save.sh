#!/bin/bash
# =============================================================
# .claude/hooks/lint-on-save.sh
# Claude Code post-edit hook for TypeScript/Svelte files
# 每次編輯 .ts 或 .svelte 檔案後自動執行 Prettier 格式檢查
# =============================================================

# 只在編輯 TypeScript 或 Svelte 檔案時觸發
if echo "$EDITED_FILE" | grep -qE '\.(ts|svelte)$'; then
  echo "📝 TypeScript/Svelte 檔案已修改，檢查格式..."
  OUTPUT=$(npx prettier --check "$EDITED_FILE" 2>&1)
  EXIT_CODE=$?

  if [ $EXIT_CODE -ne 0 ]; then
    echo "⚠️  格式不符合 Prettier 規範："
    echo "$OUTPUT"
    echo "💡 執行 npx prettier --write \"$EDITED_FILE\" 可自動修正"
  else
    echo "✅ 格式檢查通過"
  fi
fi
