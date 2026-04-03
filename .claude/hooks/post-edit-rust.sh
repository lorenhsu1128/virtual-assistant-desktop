#!/bin/bash
# =============================================================
# .claude/hooks/post-edit-rust.sh
# Claude Code post-edit hook for Rust files
# 每次編輯 .rs 檔案後自動執行 cargo check
# =============================================================

# 只在編輯 Rust 檔案時觸發
if echo "$EDITED_FILE" | grep -qE '\.rs$'; then
  echo "🦀 Rust 檔案已修改，執行 cargo check..."
  cd src-tauri
  OUTPUT=$(cargo check 2>&1)
  EXIT_CODE=$?
  cd ..

  if [ $EXIT_CODE -ne 0 ]; then
    echo "❌ cargo check 失敗："
    echo "$OUTPUT" | tail -20
  else
    echo "✅ cargo check 通過"
  fi
fi
