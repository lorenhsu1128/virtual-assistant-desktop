/**
 * Postinstall：bun install 結束後自動 build vendor/my-agent 的 embedded library
 * + 設定 node-llama-tcq junction（Windows）/ 修正 llama.cpp.info.json。
 *
 * 為何需要：
 *  1. vendor/my-agent/dist-embedded/index.js 已加 .gitignore（10MB+ 不入版控），
 *     桌寵 dev / production 都需要該檔案 import AgentEmbedded。每個 dev clone
 *     後第一次 bun install 自動跑 build，使用者無感。
 *  2. node-llama-tcq 是 `file:./vendor/node-llama-tcq` workspace dep，bun install
 *     會把它**複製**到 node_modules/node-llama-tcq。但 .gitignore 排除的
 *     localBuilds/（native .node + CUDA DLLs）不會被複製過去 → runtime 找不到
 *     binding 會觸發 auto-rebuild（失敗）。Windows 上改用 junction 直接 alias，
 *     讓 node_modules/node-llama-tcq 與 vendor/.../node-llama-tcq 為同一目錄。
 *  3. node-llama-tcq 用 llama.cpp.info.json 判定 variant 名（spiritbuun/72d130e
 *     vs ggml-org/b9145）。若 dev 不小心跑了 `source download` 會覆寫成 upstream，
 *     postinstall 主動還原為 buun。
 *
 * 流程：
 * 1. 檢查 vendor/my-agent/package.json 存在（submodule 已 init）
 * 2. 若 vendor/my-agent/node_modules 不存在 → bun install
 * 3. 若 vendor/my-agent/dist-embedded/index.js 不存在 → bun run build:embedded
 * 4. 還原 llama.cpp.info.json 為 spiritbuun/buun-llama-cpp + 對應 tag
 * 5. （Windows 限定）建 node_modules/node-llama-tcq junction → vendor/node-llama-tcq
 *
 * 失敗時 log warning 但不 fail（讓 bun install 整體完成；桌寵可在執行期
 * 降級為「無 AI 模式」）。
 *
 * 跳過條件：CI=true（CI 環境另外處理）/ MY_AGENT_SKIP_VENDOR_BUILD=1（dev 覆寫）。
 */
import { existsSync, readFileSync, writeFileSync, rmSync, symlinkSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { join } from 'node:path'
import { platform } from 'node:os'

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

// --- step 4: 還原 llama.cpp.info.json 為 spiritbuun（防 `source download` 污染）
// node-llama-tcq 用此檔判定 build variant 命名。若被覆寫為 ggml-org/b9145，
// getLlama() 找不到既有 prebuild → 觸發 auto-rebuild。
const nltVendor = join(vendorDir, 'vendor', 'node-llama-tcq')
const infoJsonPath = join(nltVendor, 'llama', 'llama.cpp.info.json')
const EXPECTED_REPO = 'spiritbuun/buun-llama-cpp'
const EXPECTED_TAG = '72d130e' // 與 my-agent 自家 vendored buun 對齊；改 buun 時要同步
if (existsSync(infoJsonPath)) {
  try {
    const cur = JSON.parse(readFileSync(infoJsonPath, 'utf8'))
    if (cur.llamaCppGithubRepo !== EXPECTED_REPO || cur.tag !== EXPECTED_TAG) {
      const fixed = { tag: EXPECTED_TAG, llamaCppGithubRepo: EXPECTED_REPO }
      writeFileSync(infoJsonPath, JSON.stringify(fixed, null, 4) + '\n', 'utf8')
      console.log(
        `[postinstall-vendor] llama.cpp.info.json 已還原為 ${EXPECTED_REPO}@${EXPECTED_TAG}`,
      )
    }
  } catch (e) {
    console.warn(`[postinstall-vendor] 讀 llama.cpp.info.json 失敗：${e.message}`)
  }
}

// --- step 5: Windows 限定 — 建 node_modules/node-llama-tcq junction
// bun install 把 file: dep 用 copy 而非 symlink，導致 .gitignore 排除的
// localBuilds（含 .node 與 CUDA DLLs）不在 node_modules 內 → 改用 junction
// alias 整個 vendor 目錄。
if (platform() === 'win32') {
  const junctionLink = join(vendorDir, 'node_modules', 'node-llama-tcq')
  const junctionTarget = nltVendor
  if (existsSync(junctionTarget)) {
    try {
      if (existsSync(junctionLink)) rmSync(junctionLink, { recursive: true, force: true })
      execSync(`cmd /c mklink /J "${junctionLink}" "${junctionTarget}"`, { stdio: 'pipe' })
      console.log(
        `[postinstall-vendor] junction node_modules/node-llama-tcq → vendor/node-llama-tcq 已建`,
      )
    } catch (e) {
      console.warn(
        `[postinstall-vendor] 建 junction 失敗（${e.message}）— embedded 模式可能 fallback rebuild`,
      )
    }
  }
} else if (platform() === 'darwin' || platform() === 'linux') {
  // macOS / Linux：bun 在這些平台 file: dep 預設用 symlink，正常會直接生效。
  // 但若 bun 行為改變，補一次 symlink 確保 localBuilds 可見。
  const symLink = join(vendorDir, 'node_modules', 'node-llama-tcq')
  const symTarget = nltVendor
  if (existsSync(symTarget) && existsSync(symLink)) {
    try {
      // 若已是 symlink 就跳過；若是 copy（罕見）則替換
      const stat = (await import('node:fs')).lstatSync(symLink)
      if (!stat.isSymbolicLink()) {
        rmSync(symLink, { recursive: true, force: true })
        symlinkSync(symTarget, symLink, 'dir')
        console.log(`[postinstall-vendor] symlink node_modules/node-llama-tcq 已重建`)
      }
    } catch (e) {
      console.warn(`[postinstall-vendor] 檢查/重建 symlink 失敗：${e.message}`)
    }
  }
}

console.log('[postinstall-vendor] ok — vendor/my-agent/dist-embedded ready')
