/**
 * Master E2E runner — 依序執行所有 embedded my-agent 相關 e2e 測試。
 *
 * 每個測試 spawn 獨立 node process（隔離 GPU / LLM singleton），收集 exit
 * code + 摘要輸出。最後總結成功/失敗清單與總耗時。
 *
 * 用法：node tests/integration/runAllE2E.mjs [name1] [name2] ...
 *   不帶參數 → 跑全部
 *   帶參數 → 只跑名稱含關鍵字的測試（substring match）
 */
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))

// 測試清單（順序：基礎 → 進階 → 整合）
const TESTS = [
  // ── GPU / 基礎 ──
  { name: 'gpuSanityCheck',          timeoutMs: 180_000, critical: false },
  { name: 'gpuProofE2E',             timeoutMs: 300_000, critical: false },

  // ── 核心對話功能 ──
  { name: 'agentScenariosE2E',       timeoutMs: 600_000, critical: true },
  { name: 'embeddedConversationHistoryE2E', timeoutMs: 480_000, critical: true },

  // ── Streaming / Watchdog / Abort ──
  { name: 'embeddedStreamingTimingE2E', timeoutMs: 180_000, critical: true },
  { name: 'embeddedWatchdogE2E',      timeoutMs: 300_000, critical: true },
  { name: 'embeddedAbortE2E',        timeoutMs: 300_000, critical: true },

  // ── Vision + Tools ──
  { name: 'embeddedVisionToolE2E',   timeoutMs: 360_000, critical: true },

  // ── Tool execution + Permission ──
  { name: 'embeddedBuiltinToolsE2E', timeoutMs: 300_000, critical: true },
  { name: 'embeddedPermissionFlowE2E', timeoutMs: 180_000, critical: true },

  // ── Session 隔離 / Reload ──
  { name: 'embeddedMultiSessionE2E', timeoutMs: 360_000, critical: true },
  { name: 'embeddedReloadCycleE2E',  timeoutMs: 600_000, critical: true },

  // ── opt-in 服務 ──
  { name: 'embeddedDaemonWsE2E',     timeoutMs: 600_000, critical: true },
  { name: 'embeddedDiscordE2E',      timeoutMs: 180_000, critical: true },
  { name: 'embeddedWebUiE2E',        timeoutMs: 180_000, critical: true },
  { name: 'embeddedAllServicesE2E',  timeoutMs: 180_000, critical: true },
  { name: 'embeddedDaemonWsConversationE2E', timeoutMs: 300_000, critical: true },
]

const filterArgs = process.argv.slice(2)
const filtered = filterArgs.length
  ? TESTS.filter(t => filterArgs.some(arg => t.name.toLowerCase().includes(arg.toLowerCase())))
  : TESTS

if (filtered.length === 0) {
  console.error(`No tests matched filters: ${filterArgs.join(', ')}`)
  console.error(`Available: ${TESTS.map(t => t.name).join(', ')}`)
  process.exit(2)
}

function runOne(test) {
  return new Promise(resolve => {
    const file = join(__dirname, test.name + '.mjs')
    const t0 = Date.now()
    const child = spawn(process.execPath, [file], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    })
    let stdout = ''
    let stderr = ''
    let killed = false
    const timer = setTimeout(() => {
      killed = true
      try { child.kill('SIGKILL') } catch {}
    }, test.timeoutMs)
    child.stdout.on('data', d => { stdout += d.toString() })
    child.stderr.on('data', d => { stderr += d.toString() })
    child.on('close', (code) => {
      clearTimeout(timer)
      const elapsed = Date.now() - t0
      // Exit code 為 source of truth；stdout 的 Verdict 文字僅供顯示參考
      const verdict = killed
        ? 'TIMEOUT'
        : code === 0
          ? 'PASS'
          : 'FAIL'
      const subResults = []
      for (const line of stdout.split('\n')) {
        const m = /^(T\d+|S\d+\S*)\s+(PASS|FAIL|WARN|SKIP)/i.exec(line.trim())
        if (m) subResults.push({ id: m[1], result: m[2].toUpperCase() })
      }
      resolve({
        name: test.name,
        verdict,
        code,
        killed,
        elapsed,
        subResults,
        critical: test.critical,
        stdoutTail: stdout.split('\n').slice(-30).join('\n'),
        stderrTail: stderr.split('\n').slice(-10).join('\n'),
      })
    })
  })
}

const t0 = Date.now()
const results = []
for (let i = 0; i < filtered.length; i++) {
  const t = filtered[i]
  const banner = `[${i + 1}/${filtered.length}] ${t.name}`
  console.log(`\n========================================================`)
  console.log(`▶ ${banner}`)
  console.log(`========================================================`)
  const r = await runOne(t)
  results.push(r)
  const tag =
    r.verdict === 'PASS' ? '✅' :
    r.verdict === 'TIMEOUT' ? '⏱️' :
    '❌'
  console.log(`${tag} ${r.name}: ${r.verdict} (${r.elapsed}ms, exit ${r.code})`)
  if (r.subResults.length) {
    const passed = r.subResults.filter(s => s.result === 'PASS').length
    const failed = r.subResults.filter(s => s.result === 'FAIL').length
    console.log(`   sub: ${passed} PASS / ${failed} FAIL / ${r.subResults.length} total`)
    for (const s of r.subResults) {
      const icon = s.result === 'PASS' ? '✓' : s.result === 'FAIL' ? '✗' : '·'
      console.log(`     ${icon} ${s.id}: ${s.result}`)
    }
  }
  if (r.verdict !== 'PASS' && r.stdoutTail) {
    console.log(`   stdout tail:\n${r.stdoutTail.split('\n').map(l => '     ' + l).join('\n')}`)
  }
  if (r.verdict !== 'PASS' && r.stderrTail.trim()) {
    console.log(`   stderr tail:\n${r.stderrTail.split('\n').map(l => '     ' + l).join('\n')}`)
  }
}

const totalElapsed = Date.now() - t0
const passCount = results.filter(r => r.verdict === 'PASS').length
const failCount = results.filter(r => r.verdict === 'FAIL').length
const timeoutCount = results.filter(r => r.verdict === 'TIMEOUT').length
const criticalFailures = results.filter(r => r.critical && r.verdict !== 'PASS')

console.log(`\n\n════════════════════════════════════════════════════════`)
console.log(`              FULL E2E SUITE RESULTS`)
console.log(`════════════════════════════════════════════════════════`)
console.log(`Total: ${results.length} tests   elapsed: ${(totalElapsed / 1000).toFixed(1)}s`)
console.log(`PASS: ${passCount}   FAIL: ${failCount}   TIMEOUT: ${timeoutCount}`)
console.log()
console.log(`Detail:`)
for (const r of results) {
  const icon = r.verdict === 'PASS' ? '✅' : r.verdict === 'TIMEOUT' ? '⏱️' : '❌'
  const crit = r.critical && r.verdict !== 'PASS' ? ' [CRITICAL]' : ''
  console.log(`  ${icon} ${r.name.padEnd(42)} ${r.verdict.padEnd(8)} ${(r.elapsed / 1000).toFixed(1)}s${crit}`)
}

if (criticalFailures.length > 0) {
  console.log(`\n❌ ${criticalFailures.length} critical test(s) failed`)
  process.exit(1)
}
console.log(`\n✅ All critical tests passed`)
process.exit(0)
