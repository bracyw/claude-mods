import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, PromptEditInput, SessionMessage } from 'claude-code'

import { restore } from './tree'

const PANE = {
  component: 'Pane',
  requestId: 'convo-fork',
  props: {
    title: 'Forks',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
  viewport: { columns: 160, rows: 40, isFullscreen: true },
} as const

// The live transcript beneath the plugin: each test turn adds its prompt and reply
let live: SessionMessage[] = []
const said = (role: 'user' | 'assistant', text: string): SessionMessage => ({ role, text, toolUses: [] })

const bottom = (on: On, haiku = 'Mods research') => {
  const clock = mock.clock(on)
  live = []
  snapshots = {}
  notes = []
  on('ui.toast', ($, e) => (notes.push(e.text), { value: undefined }))
  on('ui.log', ($, e) => (notes.push(e.text), { value: undefined }))
  on('session.messages', () => ({ value: live }))
  on('prompt.edit', ($, e) => ({ text: e.inputText, cursor: e.inputText.length }))
  on('state.set', ($, e, next) => {
    if (e.key === 'snapshot' && e.id !== undefined) {
      snapshots[e.id] = (e.value as SessionMessage[] | null)?.map(m => m.text) ?? null
    }
    return next(e)
  })
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('prompt.submit', ($, e) => ({ text: e.text, context: e.context }))
  on('model.complete', () => ({
    value: {
      isAnswered: true as const,
      text: haiku,
      usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    },
  }))
  return clock
}

const ORIGIN = { kind: 'composer' } as const
const branch = ($: Engine, args: string) =>
  $.command.run({ command: 'fork', args, origin: ORIGIN, presentation: { isFullscreen: true, columns: 160 } })

const spawn = ($: Engine, prompt: string) =>
  $.agent.spawn({
    tool_use_id: 'tu1',
    prompt,
    description: 'branch task',
    subagentType: 'convo-fork:branch',
    provider: { plugin: 'core', tier: 'builtin' },
    parentModel: 'opus',
    background: false,
    fork: false,
  })

let seq = 0
const turn = async ($: Engine, text: string, answer = `reply to ${text}`) => {
  const turnId = `t${++seq}`
  await $.turn.start({ text, turnId })
  live = [...live, said('user', text), said('assistant', answer)]
  await $.turn.complete({
    answer,
    turnId,
    durationMs: 10,
    isAborted: false,
    reason: 'answer',
    usage: {
      model: 'opus',
      input_tokens: 100,
      output_tokens: 50,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
  })
}

let notes: string[] = []
let snapshots: Record<string, string[] | null> = {}
const snapshot = async (_: Engine, id: string) => snapshots[id]

const BAND = {
  component: 'AbovePrompt',
  props: {
    bodyColumns: 60,
    hasSurvey: false,
    isWorking: false,
    maxRows: 4,
    scroll: { offset: 0, bodyRows: 4 },
    view: {},
  },
  viewport: { columns: 160, rows: 40, isFullscreen: true },
} as const

// What the band above the prompt says
const band = async ($: Engine) => {
  const ui = await $.ui.mount({ plugin: 'convo-fork', surface: 'terminal', ...BAND })
  const text = (await ui.find({ type: 'Text' }))?.text
  await ui.unmount()
  return text
}

// A key in the prompt box: the first edit installs an asked-for switch.
// The kit dispatches prompt.edit though Engine's type leaves it out
const type = ($: Engine) =>
  ($.prompt as unknown as { edit: (e: PromptEditInput) => Promise<unknown> }).edit({
    text: '',
    cursor: 0,
    start: 0,
    end: 0,
    inputText: 'n',
    origin: { kind: 'composer' },
  })

const forkTo = async ($: Engine, args: string) =>
  (
    await $.command.run({
      command: 'fork-to',
      args,
      origin: ORIGIN,
      presentation: { isFullscreen: true, columns: 160 },
    })
  ).text ?? ''

const list = async ($: Engine) =>
  (
    await $.command.run({
      command: 'forks',
      args: '',
      origin: ORIGIN,
      presentation: { isFullscreen: true, columns: 160 },
    })
  ).text ?? ''

test('turns land on the active branch and a new branch takes the next ones', async ($, on) => {
  bottom(on)
  await turn($, 'look into claude mods')
  await branch($, 'TUI surfaces')
  await turn($, 'which TUI elements exist?')
  await turn($, 'and Raster?')

  expect(await list($)).toBe('root "Root": T1\n└─ A "TUI surfaces" (active): T2–3')
})

test('switching back to a branch with turns adds a note to the next prompt', async ($, on) => {
  bottom(on)
  await turn($, 'start')
  await branch($, 'Side quest')
  await turn($, 'side')

  const ui = await $.ui.mount({ plugin: 'convo-fork', surface: 'terminal', ...PANE })
  await ui.press({ key: 'branch-root' })
  await ui.press({ key: 'switch-root' })
  const sent = await $.prompt.submit({ text: 'back to it', wait: false, origin: ORIGIN })

  expect(await list($)).toContain('root "Root" (active)')
  expect(sent.context?.some(c => c.includes('switched the session to branch root'))).toBe(true)
  await ui.unmount()
})

test('a convo-fork:branch spawn gets the lead-in and its branch, not branches started after it', async ($, on) => {
  bottom(on)
  let sent = ''
  on('agent.spawn', ($, e) => {
    sent = e.prompt
    return { model: 'haiku', agentId: 'ag1' }
  })
  await turn($, 'root question')
  await branch($, 'Alpha')
  await turn($, 'alpha question')
  await branch($, 'Beta')
  await turn($, 'beta question')

  await spawn($, 'Branch: alpha\nCompare the options.')

  expect(sent).toContain('root question')
  expect(sent).toContain('alpha question')
  expect(sent).not.toContain('beta question')
  expect(sent).toContain('Task: Compare the options.')
})

test('a convo-fork:branch spawn naming no branch is refused with the list', async ($, on) => {
  bottom(on)
  const spawned = await spawn($, 'do something')

  expect(spawned.deny).toContain('root "Root"')
})

test('the pane draws the tree and its controls on every surface with buttons', async ($, on) => {
  bottom(on)
  await turn($, 'first')
  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ plugin: 'convo-fork', surface, ...PANE })
    expect(await ui.find({ key: 'branch-root' })).toBeDefined()
    expect(await ui.find({ key: 'new' })).toBeDefined()
    await ui.press({ key: 'new' })
    await ui.unmount()
  }
  expect((await list($)).split('\n').length).toBe(5)
})

test('the first turn of an unlabeled branch is titled and summarized by haiku', async ($, on) => {
  const clock = bottom(on, 'Claude Code mods')
  await turn($, 'I want to prototype some claude code mods')
  await clock.advance(10)

  expect(await list($)).toBe('root "Claude Code mods" (active): T1 — Claude Code mods')
})

test('a fork waits for the running turn, whose rest would land on it', async ($, on) => {
  bottom(on)
  await $.turn.start({ text: 'long question', turnId: 'mid' })
  const said = await branch($, 'Later idea')
  await $.turn.complete({ answer: 'done', turnId: 'mid', durationMs: 10, isAborted: false, reason: 'answer' })

  expect(said.text).toBe('Fork once this turn finishes: its transcript is still being written.')
  expect(await list($)).toBe('root "Root" (active): T1')
})

test('a branch whose title was lost is titled after its next turn', async ($, on) => {
  const clock = mock.clock(on)
  let isDown = true
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('model.complete', () => ({
    value: isDown
      ? {
          isAnswered: false as const,
          reason: 'empty-reply' as const,
          usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        }
      : {
          isAnswered: true as const,
          text: 'Late title',
          usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        },
  }))
  await turn($, 'first')
  await clock.advance(10)
  expect(await list($)).toContain('root "Root"')

  isDown = false
  await turn($, 'second')
  await clock.advance(10)
  expect(await list($)).toContain('root "Late title" (active): T')
})

test('the switch note is added once, not again after the branch has a newer turn', async ($, on) => {
  bottom(on)
  await turn($, 'start')
  await branch($, 'Side quest')
  await turn($, 'side')
  const ui = await $.ui.mount({ plugin: 'convo-fork', surface: 'terminal', ...PANE })
  await ui.press({ key: 'branch-root' })
  await ui.press({ key: 'switch-root' })
  await turn($, 'back on root')
  const sent = await $.prompt.submit({ text: 'still root', wait: false, origin: ORIGIN })

  expect(sent.context?.some(c => c.includes('[convo-fork]')) ?? false).toBe(false)
  await ui.unmount()
})

test('the browser view gets each tree change, and its clicks act on the tree', async ($, on) => {
  const clock = bottom(on)
  const posts: string[] = []
  on('process.spawn', async function* () {
    yield { stream: 'stdout' as const, text: 'bun warming up\nACTION null\nACTION {oops\n' }
    yield { stream: 'stdout' as const, text: 'READY {"port":4000,"token":"tk"}\nACTION {"action":"new"}\n' }
    yield { stream: 'stdout' as const, text: 'ACTION {"action":"switch",' }
    yield { stream: 'stdout' as const, text: '"id":"root"}\n' }
    return { value: { code: 0, signal: null } }
  })
  on('http.fetch', ($, e) => {
    posts.push(`${e.url} ${e.init?.headers?.['x-token'] ?? ''}`)
    return { value: { status: 200, ok: true, headers: {}, text: 'ok' } }
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('agent.register', ($, e) => ({ value: { agent: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await clock.advance(10)
  await type($)

  expect(await list($)).toBe('root "Root" (active): no turns\n└─ A "New branch": no turns')
  expect(posts.at(-1)).toBe('http://127.0.0.1:4000/tree tk')
})

test('host tags around a prompt are not kept as the prompt', async ($, on) => {
  bottom(on)
  let sent = ''
  on('agent.spawn', ($, e) => {
    sent = e.prompt
    return { model: 'haiku', agentId: 'ag1' }
  })
  await turn(
    $,
    '<system-reminder>\nThis conversation is now continuing in the desktop app.\n</system-reminder>\nshow me the tree',
    'Here it is.',
  )
  await spawn($, 'Branch: root\nRecap.')

  expect(sent).toContain('show me the tree')
  expect(sent).not.toContain('system-reminder')
})

test('a host tag with no closing tag is dropped to the end', async ($, on) => {
  bottom(on)
  let sent = ''
  on('agent.spawn', ($, e) => {
    sent = e.prompt
    return { model: 'haiku', agentId: 'ag1' }
  })
  await turn($, 'first question', 'First answer.')
  await turn($, '<system-reminder>\nA reminder with no closing tag', 'Second answer.')
  await spawn($, 'Branch: root\nRecap.')

  expect(sent).toContain('first question')
  expect(sent).not.toContain('system-reminder')
})

test('a card opens to its turns and actions, and opening it does not switch', async ($, on) => {
  bottom(on)
  await turn($, 'start')
  await branch($, 'Side quest')
  await turn($, 'side')
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'convo-fork', surface, ...PANE })
    expect(await ui.find({ key: 'switch-root' })).toBeUndefined()
    await ui.press({ key: 'branch-root' })
    expect(await ui.find({ key: 'switch-root' })).toBeDefined()
    expect(await ui.find({ key: 'open-t' + String(seq - 1) })).toBeDefined()
    await ui.press({ key: 'branch-root' })
    expect(await ui.find({ key: 'switch-root' })).toBeUndefined()
    await ui.unmount()
  }
  expect(await list($)).toContain('A "Side quest" (active)')
})

test("forking saves the live transcript as both the parent's and the fork's", async ($, on) => {
  bottom(on)
  await turn($, 'start', 'ok')
  await branch($, 'Side quest')

  expect(await snapshot($, 'root')).toEqual(['start', 'ok'])
  expect(await snapshot($, 'A')).toEqual(['start', 'ok'])
})

test('switching saves the branch being left and moves the session to the other', async ($, on) => {
  bottom(on)
  await turn($, 'start', 'ok')
  await branch($, 'Side quest')
  await turn($, 'side', 'sure')

  expect(await forkTo($, 'root')).toBe('Your next prompt goes to branch root "Root".')
  expect(await band($)).toBe('⑂ Next prompt goes to branch root · Root')
  await type($)

  expect(notes).toEqual(['Switched the session to branch root.'])
  expect(await snapshot($, 'A')).toEqual(['start', 'ok', 'side', 'sure'])
  expect(await list($)).toContain('root "Root" (active)')
})

test('a switch asked for during a turn goes in when the next turn starts, before its prompt lands', async ($, on) => {
  bottom(on)
  await turn($, 'start', 'ok')
  await branch($, 'Side quest')
  await $.turn.start({ text: 'long one', turnId: 'running' })
  await forkTo($, 'root')
  await type($)
  expect(await list($)).toContain('A "Side quest" (active)')
  live = [...live, said('user', 'long one'), said('assistant', 'done')]
  await $.turn.complete({ answer: 'done', turnId: 'running', durationMs: 10, isAborted: false, reason: 'answer' })

  await turn($, 'back on root')

  expect(await list($)).toBe('root "Root" (active): T1, T3\n└─ A "Side quest": T2')
  expect(await snapshot($, 'A')).toEqual(['start', 'ok', 'long one', 'done'])
})

test('a prompt already in the transcript when its turn starts moves with the switch', async ($, on) => {
  bottom(on)
  await turn($, 'start', 'ok')
  await branch($, 'Side quest')
  await turn($, 'side', 'sure')
  await forkTo($, 'root')
  live = [...live, said('user', 'where were we')]
  await $.turn.start({ text: 'where were we', turnId: 'next' })

  expect(await snapshot($, 'A')).toEqual(['start', 'ok', 'side', 'sure'])
  expect(await list($)).toContain('root "Root" (active): T1, T3')
})

test('a branch with no saved transcript is not installed', async ($, on) => {
  bottom(on)
  let isDropped = false
  on('state.get', ($, e, next) =>
    isDropped && e.key === 'snapshot' ? { value: { value: null, version: 0 } } : next(e),
  )
  await turn($, 'start')
  await branch($, 'Side quest')
  isDropped = true
  await forkTo($, 'root')
  await type($)

  expect(notes).toContain('Could not switch: branch root has no saved transcript')
  expect(await list($)).toContain('A "Side quest" (active)')
})

test('restore keeps the shared opening as the engine has it and rebuilds the rest', () => {
  const engine = [
    { ...said('user', 'a'), handle: 'h1' },
    { ...said('assistant', 'b'), handle: 'h2' },
    { ...said('user', 'x'), handle: 'h3' },
  ]
  const target = [said('user', 'a'), said('assistant', 'b'), said('user', 'y'), said('assistant', 'z')]

  expect(restore(engine, target).map(m => m.handle ?? m.text)).toEqual(['h1', 'h2', 'y', 'z'])
})
