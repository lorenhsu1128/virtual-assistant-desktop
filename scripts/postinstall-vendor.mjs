/**
 * Postinstall：bun install 結束後自動 build vendor/my-agent 的 embedded library。
 *
 * 為何需要：vendor/my-agent/dist-embedded/index.js 已加 .gitignore（10MB+ 不入版控），
 * 桌寵 dev / production 都需要該檔案 import AgentEmbedded。每個 dev clone
 * 後第一次 bun install 自動跑 build，使用者無感。
 *
 * 流程：
 * 1. 檢查 vendor/my-agent/package.json 存在（submodule 已 init）
 * 2. 若 vendor/my-agent/node_modules 不存在 → bun install
 * 3. 若 vendor/my-agent/dist-embedded/index.js 不存在 → bun run build:embedded
 *
 * 失敗時 log warning 但不 fail（讓 bun install 整體完成；桌寵可在執行期
 * 降級為「無 AI 模式」）。
 *
 * 跳過條件：CI=true（CI 環境另外處理）/ MY_AGENT_SKIP_VENDOR_BUILD=1（dev 覆寫）。
 */
import { existsSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { join } from 'node:path'

if (process.env.CI === 'true' || process.env.MY_AGENT_SKIP_VENDOR_BUILD === '1') {
  console.log('[postinstall-vendor] skip (CI or MY_AGENT_SKIP_VENDOR_BUILD)')
  process.exit(0)
}

const vendorDir = join(process.cwd(), 'vendor', 'my-agent')
const vendorPkg = join(vendorDir, 'package.json')

if (!existsSync(vendorPkg)) {
  console.log(
    '[postinstall-vendor] vendor/my-agent submodule 尚未 init —— ' +
      '請先 `git submodule update --init --recursive` 再重新 bun install',
  )
  process.exit(0)
}

import { rmSync } from 'node:fs'

function run(cmd, args, cwd, cleanupOnFail) {
  console.log(`[postinstall-vendor] (cwd=${cwd}) ${cmd} ${args.join(' ')}`)
  try {
    execSync(`${cmd} ${args.join(' ')}`, { cwd, stdio: 'inherit' })
    return true
  } catch (e) {
    console.warn(
      `[postinstall-vendor] ${cmd} failed (${e.message}) — 桌寵會降級為「無 AI 模式」`,
    )
    // reviewer M7：失敗時清掉半 populated state，下次 bun install 才會重試
    if (cleanupOnFail) {
      try {
        rmSync(cleanupOnFail, { recursive: true, force: true })
        console.log(`[postinstall-vendor] cleaned ${cleanupOnFail} (允許下次重試)`)
      } catch {
        /* ignore */
      }
    }
    return false
  }
}

const vendorNodeModules = join(vendorDir, 'node_modules')
if (!existsSync(vendorNodeModules)) {
  if (!run('bun', ['install'], vendorDir, vendorNodeModules)) {
    process.exit(0)
  }
}

const vendorDistDir = join(vendorDir, 'dist-embedded')
const vendorDist = join(vendorDistDir, 'index.js')
if (!existsSync(vendorDist)) {
  if (!run('bun', ['run', 'build:embedded'], vendorDir, vendorDistDir)) {
    process.exit(0)
  }
}

console.log('[postinstall-vendor] ok — vendor/my-agent/dist-embedded ready')
