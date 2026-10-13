import type { Register } from 'claude-code'

// What the probe saw, newest last; module state, so a reload starts it over
type Entry = { at: number; what: string; data?: unknown }

const RUN = 'mcp__fork-probe__run'
const REPORT = 'mcp__fork-probe__report'

export const register: Register = on => {
  const log: Entry[] = []
  const t0 = Date.now()
  const note = (what: string, data?: unknown) => log.push({ at: Date.now() - t0, what, data })
  const forks = new Set<string>()
  let isDropping = false

  on('session.start', async ($, e, next) => {
    const r = await next(e)
    await $.tool.register({
      name: 'run',
      description:
        'fork-probe: spawns a background fork of this conversation with $.agent.spawn({ subagentType: "fork" }) and returns at once. Pass a nonce you just wrote; the fork is asked to repeat it.',
      inputSchema: {
        type: 'object',
        properties: {
          nonce: { type: 'string' },
          dropNotice: {
            type: 'boolean',
            description: "drop the fork's completion notice before it reaches the main loop",
          },
          subagentType: { type: 'string', description: 'default "fork"' },
        },
        required: ['nonce'],
      },
      isDeferred: false,
    })
    await $.tool.register({
      name: 'report',
      description: 'fork-probe: returns everything the probe recorded so far, as JSON.',
      isDeferred: false,
    })
    return r
  })

  on('tool.call', { tool: RUN }, async ($, e) => {
    const input = e as unknown as { nonce: string; dropNotice?: boolean; subagentType?: string }
    isDropping = input.dropNotice === true
    const subagentType = input.subagentType ?? 'fork'
    const prompt = `Reply with only the nonce argument of the most recent ${RUN} tool call in this conversation, then the word DONE. If you cannot see one, reply NO-CONTEXT.`
    note('spawn.request', { subagentType, dropNotice: isDropping })
    try {
      const r = await $.agent.spawn({ subagentType, prompt, description: 'fork probe' })
      note('spawn.result', r)
      if (r.agentId !== undefined) forks.add(r.agentId)
      return { result: JSON.stringify({ spawned: r }) }
    } catch (err) {
      note('spawn.rejected', String(err))
      return { result: JSON.stringify({ rejected: String(err) }) }
    }
  })

  on('tool.call', { tool: REPORT }, async () => ({ result: JSON.stringify(log, null, 1) }))

  // What the engine tells the hooks about the spawn: is it a fork, in the background
  on('agent.spawn', async ($, e, next) => {
    if (e.description === 'fork probe')
      note('agent.spawn', { subagentType: e.subagentType, fork: e.fork, background: e.background, model: e.model })
    return next(e)
  })

  // How many messages the fork's first request carries: a fork that inherited sends the whole transcript
  on('turn.step', async function* ($, e, next) {
    if (e.agentId !== undefined && forks.has(e.agentId))
      note('fork.step', { index: e.index, messageCount: e.messageCount, model: e.model })
    return yield* next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined || !forks.has(e.agentId)) return next(e)
    const r = await next(e)
    const msgs = await $.session.messages({ agentId: e.agentId }).catch(err => String(err))
    note('fork.complete', {
      reason: e.reason,
      text: r.text.slice(0, 300),
      usage: e.usage,
      transcript: Array.isArray(msgs)
        ? { count: msgs.length, last: msgs.slice(-2).map(m => ({ role: m.role, text: m.text.slice(0, 120) })) }
        : msgs,
    })
    // The hand-back may carry the agent's final text: when dropping, hand back a stub instead
    return isDropping ? { ...r, text: 'fork-probe: reply saved to its branch' } : r
  })

  // Rows the main conversation keeps: does the hand-back pass here, and through which door
  on('session.append', async ($, e, next) => {
    const raw = JSON.stringify(e)
    if (e.agentId !== undefined || ![...forks].some(id => raw.includes(id))) return next(e)
    const isDelivery = e.door === 'delivery'
    note('append', { door: e.door, rewritten: isDelivery && isDropping, head: raw.slice(0, 300) })
    if (!isDelivery || !isDropping) return next(e)
    // The hand-back is the agent's own final text; this row is the one place it can be cut
    const text = 'fork-probe: a background reply finished and was kept off this conversation'
    return next({ ...e, message: { ...e.message, content: [{ type: 'text', text }] } } as typeof e)
  })

  // A subagent's hand-back may travel as a message: session.send from its loop, session.receive into main
  on('session.send', async ($, e, next) => {
    const from = (e as unknown as { agentId?: string }).agentId
    if (from !== undefined && forks.has(from))
      note('send', { from, text: String((e as unknown as { text?: string }).text ?? '').slice(0, 200) })
    return next(e)
  })

  on('session.receive', async ($, e, next) => {
    const isOurs =
      [...forks].some(id => e.text.includes(id)) || e.text.includes('NO-CONTEXT') || e.text.includes('DONE')
    note('receive', {
      origin: e.origin,
      agentId: e.agentId ?? null,
      isOurs,
      dropped: isOurs && isDropping,
      text: e.text.slice(0, 300),
    })
    if (isOurs && isDropping) return { consumed: 'fork-probe consumed the background agent’s hand-back' }
    return next(e)
  })

  // A background task's notice reaches the main loop as a prompt of origin task-notification
  on('prompt.submit', async ($, e, next) => {
    const kind = (e.origin as { kind?: string } | undefined)?.kind
    if (kind !== 'task-notification') return next(e)
    const isOurs = [...forks].some(id => e.text.includes(id)) || e.text.includes('fork probe')
    note('notice', { isOurs, intoTurn: e.turnId ?? null, dropped: isOurs && isDropping, text: e.text.slice(0, 400) })
    if (isOurs && isDropping) return { drop: 'fork-probe dropped the fork’s completion notice' }
    return next(e)
  })
}
