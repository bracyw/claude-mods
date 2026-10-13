import { expect, test } from 'claude-code/testing'

// The live engine is what this probes; here only the probe's own wiring is checked
test('run asks for a fork, and a fork-probe notice is dropped on request', async ($, on) => {
  let asked = ''
  // The kit raises the plugin's spawn in the Agent tool's shape
  on('agent.spawn', ($, e) => {
    asked = (e as unknown as { subagent_type: string }).subagent_type
    return { model: 'opus', agentId: 'f1' }
  })
  on('prompt.submit', ($, e) => ({ text: e.text }))

  await $.tool.call({ tool: 'mcp__fork-probe__run', nonce: 'n-42', dropNotice: true } as never)
  expect(asked).toBe('fork')

  const notice = await $.prompt.submit({
    text: '<task-notification>"fork probe" completed</task-notification>',
    wait: false,
    origin: { kind: 'task-notification' },
  } as never)
  expect(JSON.stringify(notice)).toContain('drop')

  const report = JSON.stringify(await $.tool.call({ tool: 'mcp__fork-probe__report' } as never))
  expect(report).toContain('spawn.request')
  expect(report).toContain('notice')
})
