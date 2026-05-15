/**
 * canUseTool permission flow — 驗證 deny 拒絕 tool / allow 通過 / 修改 input。
 *
 * 場景：要求 LLM 用 set_expression(joy)，但 canUseTool 強制 deny → agent
 * 應收到拒絕、不能完成 tool dispatch、但對話能繼續（不 crash）。
 */
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { z } from 'zod'

const MY_AGENT_REPO = process.env.MY_AGENT_REPO || 'C:/Users/LOREN/Documents/_projects/my-agent'
const MODEL_ABS = resolve(MY_AGENT_REPO, 'models/Qwen3.5-9B-Q4_K_M.gguf')
if (!existsSync(MODEL_ABS)) { console.error(`[perm] FAIL: 缺 model`); process.exit(2) }

const TEMP = join(tmpdir(), `vad-perm-${process.pid}-${Date.now()}`)
mkdirSync(TEMP, { recursive: true })
process.env.CLAUDE_CONFIG_DIR = TEMP
process.env.MY_AGENT_REMOTE_MEMORY_DIR = TEMP
process.env.MY_AGENT_LLAMACPP_EMBEDDED = '1'

writeFileSync(join(TEMP, 'llamacpp.jsonc'),
  `{"baseUrl":"http://127.0.0.1:8081/v1","model":"qwen3.5-9b","contextSize":131072,"debug":false,"modelAliases":["qwen3.5-9b"],"server":{"host":"127.0.0.1","port":8081,"ctxSize":131072,"gpuLayers":99,"modelPath":${JSON.stringify(MODEL_ABS)},"alias":"qwen3.5-9b","binaryPath":${JSON.stringify(resolve(MY_AGENT_REPO,'buun-llama-cpp/build/bin/Release/llama-server.exe'))},"extraArgs":["--flash-attn","on","--cache-type-k","turbo4","--cache-type-v","turbo4","-b","2048","-ub","512","--threads","12","--no-mmap"],"binaryKind":"buun"}}`, 'utf-8')

// mascot tool（會被 permission gate 攔截）
let toolCalls = 0
const setExprTool = {
  name: 'set_expression',
  inputSchema: z.object({ name: z.string() }),
  description: async () => '切換桌寵表情。',
  prompt: async () => '切換桌寵表情。',
  isEnabled: () => true,
  isConcurrencySafe: () => false,
  isReadOnly: () => true,
  isDestructive: () => false,
  userFacingName: () => 'set_expression',
  checkPermissions: async (input) => ({ behavior: 'allow', updatedInput: input }),
  toAutoClassifierInput: () => '',
  async call(args) {
    toolCalls++
    return { data: { ok: true }, resultForAssistant: `expression set to ${args.name}` }
  },
}

const { AgentEmbedded } = await import('../../vendor/my-agent/dist-embedded/index.js')

// canUseTool 對所有 set_expression 都拒絕
let canUseToolCalled = 0
const agent = await AgentEmbedded.create({
  cwd: TEMP,
  configDir: TEMP,
  extraTools: [setExprTool],
  skipMcp: true,
  canUseTool: async (name, _input) => {
    canUseToolCalled++
    if (name === 'set_expression') {
      return { behavior: 'deny', message: 'Mascot expressions are user-controlled; please ask the user.' }
    }
    return { behavior: 'allow', updatedInput: _input }
  },
  onPreloadProgress: () => {},
})

const session = agent.createSession({ source: 'mascot' })
let turnEnded = false
const toolResults = []
session.on('frame', (f) => {
  if (f.type === 'runnerEvent' && f.event?.type === 'output') {
    const p = f.event.payload
    if (p?.type === 'user' && Array.isArray(p.message?.content)) {
      for (const b of p.message.content) {
        if (b.type === 'tool_result') toolResults.push(b)
      }
    }
  }
  if (f.type === 'turnEnd') turnEnded = true
})

await new Promise(r => setTimeout(r, 30))
session.send('請使用 set_expression tool 把表情設為 joy。')

const tStart = Date.now()
await new Promise(r => {
  const t = setInterval(() => {
    if (turnEnded || Date.now() - tStart > 120000) { clearInterval(t); r() }
  }, 100)
})

try { await session.close() } catch {}
try { await agent.shutdown?.() } catch {}

console.log(`\n══════════════════════════════════════════════════════`)
console.log(`           PERMISSION FLOW E2E RESULTS`)
console.log(`══════════════════════════════════════════════════════`)
console.log(`elapsed: ${Date.now() - tStart}ms`)
console.log(`canUseTool 被呼叫: ${canUseToolCalled} 次`)
console.log(`tool.call() 實際執行: ${toolCalls} 次（預期 0，因為被 deny）`)
console.log(`tool_result blocks 收到: ${toolResults.length}`)

const t1 = canUseToolCalled >= 1
const t2 = toolCalls === 0  // tool 不應被執行
const t3 = turnEnded         // turn 必須正常結束
const t4 = toolResults.some(r => {
  const content = typeof r.content === 'string' ? r.content : JSON.stringify(r.content)
  return /deny|denied|refuse|reject|permission|user-controlled/i.test(content)
})

console.log(`\nT1 canUseTool 被呼叫:        ${t1 ? 'PASS' : 'FAIL'}`)
console.log(`T2 tool.call() 沒被執行:     ${t2 ? 'PASS' : 'FAIL'}`)
console.log(`T3 turn 正常結束（不 crash）: ${t3 ? 'PASS' : 'FAIL'}`)
console.log(`T4 收到 deny tool_result:    ${t4 ? 'PASS' : 'FAIL'}`)

const pass = t1 && t2 && t3 && t4
console.log(`\nVerdict: ${pass ? 'PASS' : 'FAIL'}\n`)
process.exit(pass ? 0 : 1)
