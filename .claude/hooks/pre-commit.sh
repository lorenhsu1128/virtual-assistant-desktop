#!/bin/bash
# =============================================================
# .claude/hooks/pre-commit.sh
# Claude Code pre-commit hook
# 提交前自動檢查：敏感檔案、TypeScript lint、Rust clippy
# =============================================================

set -e

echo "🔍 執行提交前檢查..."

# ----- 1. 阻止提交敏感檔案 -----
SENSITIVE_FILES=$(git diff --cached --name-only | grep -E '\.(env|key|pem|p12|pfx)$|credentials|secrets' || true)
if [ -n "$SENSITIVE_FILES" ]; then
  echo "❌ BLOCKED: 偵測到敏感檔案，禁止提交："
  echo "$SENSITIVE_FILES"
  exit 1
fi

# ----- 2. TypeScript 檔案變更時執行 lint -----
TS_FILES=$(git diff --cached --name-only | grep -E '\.ts$|\.svelte$' || true)
if [ -n "$TS_FILES" ]; then
  echo "📝 檢查 TypeScript lint..."
  npx eslint $TS_FILES --quiet 2>/dev/null
  if [ $? -ne 0 ]; then
    echo "❌ ESLint 檢查失敗，請修正後重新提交"
    exit 1
  fi
  echo "✅ TypeScript lint 通過"
fi

# ----- 3. Rust 檔案變更時執行 clippy -----
RS_FILES=$(git diff --cached --name-only | grep -E '\.rs$' || true)
if [ -n "$RS_FILES" ]; then
  echo "🦀 檢查 Rust clippy..."
  cd src-tauri
  cargo clippy -- -D warnings 2>/dev/null
  if [ $? -ne 0 ]; then
    echo "❌ Clippy 檢查失敗，請修正後重新提交"
    exit 1
  fi
  cd ..
  echo "✅ Rust clippy 通過"
fi

# ----- 4. 檢查是否有 unwrap() 被新增 -----
UNWRAP_ADDED=$(git diff --cached -U0 -- '*.rs' | grep '^\+.*\.unwrap()' || true)
if [ -n "$UNWRAP_ADDED" ]; then
  echo "⚠️  警告：偵測到新增的 .unwrap() 呼叫："
  echo "$UNWRAP_ADDED"
  echo "   建議使用 ? 或 match 替代"
  # 不阻止，僅警告
fi

# ----- 5. 檢查是否有 any 型別被新增 -----
ANY_ADDED=$(git diff --cached -U0 -- '*.ts' | grep -E '^\+.*: any[^A-Za-z]|^\+.*as any' || true)
if [ -n "$ANY_ADDED" ]; then
  echo "⚠️  警告：偵測到新增的 any 型別："
  echo "$ANY_ADDED"
  echo "   建議使用具體型別替代"
  # 不阻止，僅警告
fi

echo "✅ 提交前檢查全部通過"
