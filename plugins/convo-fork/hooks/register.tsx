import { atom, read, update } from 'claude-code'
import type { Hook, Register, SessionMessage } from 'claude-code'

import type { Bridge, Tree, View } from '../types'
import {
  ROOT,
  addBranches,
  branchContext,
  branchOf,
  compact,
  emptyTree,
  findBranch,
  finishTurn,
  isReturning,
  labelOf,
  listText,
  pathTo,
  patchBranch,
  ranges,
  restore,
  rows,
  startTurn,
  strip,
  switchTo,
  tokensOf,
  turnsOf,
} from './tree'
import type { Row } from './tree'

type Api = Parameters<Hook<'session.start'>>[0]

const PANE = 'convo-fork'
const TITLE = 'Forks'
const COLORS = ['claude', 'suggestion', 'success', 'warning', 'planMode', 'autoAccept', 'ide', 'merged'] as const

const tree = atom({ plugin: 'convo-fork', key: 'tree' } as const, emptyTree())
const view = atom({ plugin: 'convo-fork', key: 'view' } as const, { openId: null, openTurnId: null } as View)
const bridge = atom({ plugin: 'convo-fork', key: 'bridge' } as const, null as Bridge | null)
const pending = atom({ plugin: 'convo-fork', key: 'pending' } as const, null as string | null)

const snapshotOf = async ($: Api, id: string) =>
  (await $.state.get({ plugin: 'convo-fork', key: 'snapshot', id })).value ?? null

const saveSnapshot = ($: Api, id: string, messages: SessionMessage[]) =>
  $.state.set({ plugin: 'convo-fork', key: 'snapshot', id }, messages)

// The last turn on the main thread has no reply yet
const isRunning = (t: Tree) => t.turns.at(-1)?.reply === null

// Hands the tree to the browser view's server, when one is up
const publish = async ($: Api) => {
  const at = await read($, bridge)
  if (at === null) return
  await $.http
    .fetch(`http://127.0.0.1:${at.port}/tree`, {
      method: 'POST',
      headers: { 'x-token': at.token, 'content-type': 'application/json' },
      body: JSON.stringify(await read($, tree)),
    })
    .catch(() => undefined)
}

// Every tree write goes through here, so the browser view sees it too
const change = async ($: Api, fn: (t: Tree) => Tree) => {
  await update($, tree, fn)
  await publish($)
}

// Creation order, as the browser page colors them
const colorOf = (t: Tree, id: string) =>
  id === ROOT ? 'text' : COLORS[(t.branches.findIndex(b => b.id === id) - 1) % COLORS.length]

const cut = (text: string, room: number) => (text.length <= room ? text : `${text.slice(0, Math.max(0, room - 1))}…`)

const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim()

const haiku = async ($: Api, prompt: string, maxTokens: number) => {
  const reply = await $.model.complete({ model: 'haiku', prompt, maxTokens, timeoutMs: 20000 })
  return reply.isAnswered ? reply.text.trim() : undefined
}

const labelBranch = async ($: Api, id: string, prompt: string) => {
  const label = await haiku(
    $,
    `Give a 2-5 word title for a conversation thread that starts with this message. Answer with the title alone, no quotes.\n\n<message>\n${prompt.slice(0, 1500)}\n</message>`,
    20,
  )
  if (label !== undefined) await change($, t => patchBranch(t, id, { label: cut(oneLine(label), 40) }))
}

const finishedOf = (t: Tree, id: string) => turnsOf(t, id).filter(x => x.reply !== null)

const summarizeBranch = async ($: Api, id: string) => {
  const all = finishedOf(await read($, tree), id)
  const turns = all.slice(-6)
  if (turns.length === 0) return
  const body = turns
    .map(t => `User: ${t.prompt.slice(0, 600)}\nAssistant: ${(t.reply ?? '').slice(0, 600)}`)
    .join('\n\n')
  const summary = await haiku(
    $,
    `Summarize where this conversation thread stands in one sentence of at most 18 words: what is being explored and what was decided or is open. Answer with the sentence alone.\n\n<thread>\n${body}\n</thread>`,
    50,
  )
  if (summary !== undefined) {
    await change($, t => patchBranch(t, id, { summary: oneLine(summary), summarizedTurns: all.length }))
  }
}

// Titles every untitled branch that has turns and refreshes every stale summary,
// so work a reload dropped is picked up by the next turn or load
const catchUp = async ($: Api) => {
  for (const { id } of (await read($, tree)).branches) {
    const t = await read($, tree)
    const branch = branchOf(t, id)
    const first = turnsOf(t, id).find(x => x.prompt !== '')
    if (branch === undefined || first === undefined) continue
    if (branch.label === null) await labelBranch($, id, first.prompt)
    if (branch.summarizedTurns !== finishedOf(t, id).length) await summarizeBranch($, id)
  }
}

let isBusy = false

// Runs catchUp outside the hook's budget, one at a time; a call skipped meanwhile is caught up next turn
const settle = ($: Api) =>
  $.clock.after(0, () => {
    if (isBusy) return
    isBusy = true
    void catchUp($)
      .catch(() => undefined)
      .finally(() => {
        isBusy = false
      })
  })

const MID_TURN = 'Fork once this turn finishes: its transcript is still being written.'

// Forks the live transcript: the parent and the new branch both start from it, and the session stays on it.
// Undefined while a turn runs, whose rest would land on the fork
const newBranch = async ($: Api, label: string | null) => {
  if (isRunning(await read($, tree))) return undefined
  const live = strip(await $.session.messages())
  await saveSnapshot($, (await read($, tree)).activeId, live)
  let id = ''
  await change($, t => {
    const made = addBranches(t, [label])
    id = made.branches.at(-1)?.id ?? ROOT
    return switchTo(made, id)
  })
  await saveSnapshot($, id, live)
  await update($, view, () => ({ openId: id, openTurnId: null }))
  return id
}

const splitReply = async ($: Api) => {
  const t = await read($, tree)
  if (isRunning(t)) {
    $.ui.toast(MID_TURN)
    return
  }
  const last = finishedOf(t, t.activeId).at(-1)
  if (last === undefined) {
    $.ui.toast('Nothing to split: this branch has no reply yet.')
    return
  }
  const answer = await haiku(
    $,
    `The assistant reply below may offer several distinct options, ideas or directions to explore. List each as a 2-5 word title, one per line, at most 6, no numbering. If it offers no distinct options, answer NONE.\n\n<reply>\n${last.reply ?? ''}\n</reply>`,
    120,
  )
  const labels = (answer ?? '')
    .split('\n')
    .map(line => oneLine(line.replace(/^[-*\d.)\s]+/, '')))
    .filter(line => line !== '' && line !== 'NONE')
    .slice(0, 6)
    .map(line => cut(line, 40))
  if (labels.length === 0) {
    $.ui.toast('No distinct options found in the last reply.')
    return
  }
  const live = strip(await $.session.messages())
  let ids: string[] = []
  await change($, cur => {
    const made = addBranches(cur, labels)
    ids = made.branches.slice(cur.branches.length).map(b => b.id)
    return made
  })
  await Promise.all(ids.map(id => saveSnapshot($, id, live)))
  $.ui.toast(`Split into ${labels.length} branches.`)
}

const AGENT = 'convo-fork:branch'
const BRANCH_LINE = /^\s*Branch:\s*(.+?)\s*$/m

const AGENT_PROMPT = `You are a subagent that sees one branch of the user's conversation with Claude, not the whole conversation. Its turns (user prompts and final assistant replies; tool calls omitted) open your task message, under "# Conversation branch". Other branches of the conversation are deliberately left out: work from this branch alone, and say so when the task needs something it does not hold. Finish with a concise answer for the main conversation.`

// The branch's turns, then the task: what a branch subagent is handed
const withBranch = (t: Tree, id: string, task: string) => `${branchContext(t, id) ?? ''}\n\n---\n\nTask: ${task}`

const recordAgent =
  (agentId: string, branchId: string, task: string) =>
  (cur: Tree): Tree => ({
    ...cur,
    agents: [...cur.agents, { agentId, branchId, task, isDone: false }],
  })

const startAgent = async ($: Api, ref: string, task: string) => {
  const t = await read($, tree)
  const branch = findBranch(t, ref)
  if (branch === undefined) return `No branch "${ref}". Branches:\n${listText(t)}`
  if (task.trim() === '') return `Give the subagent a task: /fork-agent ${branch.id} <task>`
  const spawned = await $.agent.spawn({
    subagentType: AGENT,
    prompt: withBranch(t, branch.id, task),
    description: `Branch ${branch.id}: ${labelOf(branch)}`,
  })
  if (spawned.deny !== undefined) return `Subagent refused: ${spawned.deny}`
  if (spawned.agentId !== undefined) await change($, recordAgent(spawned.agentId, branch.id, task))
  return `Started a subagent on branch ${branch.id} "${labelOf(branch)}" with ${turnsOf(t, branch.id).length} of its turns.`
}

// The branch a switch is installing, and the prompt that started the turn installing it, if one did
let switching: { id: string; prompt: string | null } | null = null

// Saves the live transcript as the active branch's and puts the asked-for branch's in its place,
// through a compaction this module answers itself: no summary is made, no model call.
// The engine runs a plugin's own compaction hook only when another of its hooks asks, and not a
// command or prompt hook (they hold the turn): so a press, an edit of the prompt or a turn's start.
const install = async ($: Api, prompt: string | null = null) => {
  const id = await read($, pending)
  // A turn's start means the last one is over, even one that ended with no reply
  if (id === null || switching !== null || (prompt === null && isRunning(await read($, tree)))) return
  switching = { id, prompt }
  try {
    const done = await $.session.compact({ instructions: `convo-fork: switch to branch ${id}` })
    $.ui.toast(done.skip === undefined ? `Switched the session to branch ${id}.` : `Could not switch: ${done.skip}`)
  } catch {
    // busy: the next press, edit or turn tries again
  } finally {
    switching = null
  }
}

// Asks for a switch; the next press, edit of the prompt or turn installs it, before Claude reads anything
const swapTo = async ($: Api, id: string) => {
  const t = await read($, tree)
  const branch = branchOf(t, id)
  if (branch === undefined) return `No branch "${id}".`
  if (id === t.activeId) return `Already on branch ${id}.`
  await update($, pending, () => id)
  return `Your next prompt goes to branch ${id} "${labelOf(branch)}".`
}

const showBranch = async ($: Api, id: string) => {
  const said = await swapTo($, id)
  $.ui.toast(said)
}

// The browser view: browser/server.ts, run with bun, serves the page and prints its clicks
const BUNS = ['bun', '/opt/homebrew/bin/bun', '/usr/local/bin/bun']

const onAction = async ($: Api, action: Record<string, unknown>) => {
  if (action.action === 'switch' && typeof action.id === 'string') await showBranch($, action.id)
  if (action.action === 'new' && (await newBranch($, null)) === undefined) $.ui.toast(MID_TURN)
  if (action.action === 'split') await splitReply($)
}

// `READY {"port","token"}` once the server listens, `ACTION {...}` per click on the page
const onLine = async ($: Api, line: string) => {
  const [, kind, json = ''] = /^(READY|ACTION) (.+)$/.exec(line) ?? []
  let body: Record<string, unknown>
  try {
    body = JSON.parse(json) ?? {}
  } catch {
    return
  }
  if (kind === 'READY' && typeof body.port === 'number' && typeof body.token === 'string') {
    const at = { port: body.port, token: body.token }
    await update($, bridge, () => at)
    await publish($)
  }
  if (kind === 'ACTION') await onAction($, body)
}

// Runs one server until it exits; false when no bun could start it
const runServer = async ($: Api) => {
  const saved = await read($, bridge)
  const script = `${$.plugin.root}/browser/server.ts`
  for (const bun of BUNS) {
    try {
      const child = $.process.spawn({ argv: [bun, script, String(saved?.port ?? 0), saved?.token ?? ''] })
      let rest = ''
      for await (const piece of child) {
        if (piece.stream !== 'stdout') continue
        const lines = (rest + piece.text).split('\n')
        rest = lines.pop() ?? ''
        for (const line of lines) await onLine($, line)
      }
      return true
    } catch {
      // not at this path: try the next
    }
  }
  return false
}

// For the module's life: a server that exits starts again on the same port, five times at most.
// A reload kills the child and drops this loop's timer, and the next load starts its own.
const serve = async ($: Api) => {
  for (let restarts = 0; restarts < 5; restarts++) {
    if (!(await runServer($))) break
    await $.clock.sleep(1000)
  }
  await update($, bridge, () => null)
}

const browserUrl = (at: Bridge) => `http://127.0.0.1:${at.port}/?t=${at.token}`

const openBrowser = async ($: Api) => {
  const at = await read($, bridge)
  if (at === null) return 'The browser view is not running: it needs bun (https://bun.sh).'
  await $.process.run(['open', browserUrl(at)]).catch(() => undefined)
  return `Opened ${browserUrl(at)}`
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await Promise.all([
      $.command.register({ name: 'fork-tree', description: 'Open the session fork pane' }),
      $.command.register({ name: 'forks', description: 'List the session forks' }),
      $.command.register({ name: 'fork-web', description: 'Open the session forks in your browser' }),
      $.command.register({
        name: 'fork',
        description: 'Fork the session here; your next prompts go to the fork',
        argumentHint: '[label]',
      }),
      $.command.register({
        name: 'fork-to',
        description: 'Switch the session to another fork: Claude sees only that branch from then on',
        argumentHint: '<branch>',
      }),
      $.command.register({
        name: 'fork-agent',
        description: 'Run a subagent that sees only one branch of the conversation',
        argumentHint: '<branch> <task>',
      }),
      $.agent.register({
        name: 'branch',
        description:
          'Runs a task with only one branch of this conversation as context, the forks the user made in the convo-fork pane (A, B, … or "root"). Use when the user asks for an agent that sees just one branch. Start the prompt with a line "Branch: <id or label>", then the task; the branch\'s turns are added for you, so do not restate them.',
        prompt: AGENT_PROMPT,
      }),
    ])
    void $.ui.open({ id: PANE, title: TITLE })
    void serve($).catch(() => undefined) // an unload cancels its sleep
    settle($)

    return next(e)
  })

  on('command.run', { command: 'fork-tree' }, async $ => {
    await $.ui.open({ id: PANE, title: TITLE, focus: true })
    return { text: 'Fork pane opened.' }
  })

  on('command.run', { command: 'forks' }, async $ => ({ text: listText(await read($, tree)) }))

  on('command.run', { command: 'fork-web' }, async $ => ({ text: await openBrowser($) }))

  on('command.run', { command: 'fork' }, async ($, e) => {
    const label = oneLine(e.args)
    const id = await newBranch($, label === '' ? null : cut(label, 40))
    if (id === undefined) return { text: MID_TURN }
    return { text: `Forked the session as branch ${id}. Your next prompt continues there.` }
  }).catch(() => ({ text: 'convo-fork: could not fork the session.' }))

  on('command.run', { command: 'fork-to' }, async ($, e) => {
    const branch = findBranch(await read($, tree), e.args)
    if (branch === undefined)
      return { text: `No branch "${e.args.trim()}". Branches:\n${listText(await read($, tree))}` }
    return { text: await swapTo($, branch.id) }
  })

  // The switch: the transcript handed in is the branch being left; the one handed back is the branch's
  on('session.compact', async ($, e, next) => {
    const at = switching
    if (e.agentId !== undefined || at === null) return next(e)
    await update($, pending, () => null)
    const target = await snapshotOf($, at.id)
    if (target === null) return { skip: `branch ${at.id} has no saved transcript` }
    // The engine hands its transcript in; read it when a host does not
    const all = Array.isArray(e.messages) ? e.messages : await $.session.messages()
    // At a turn's start the transcript may already end on its prompt: that prompt moves with the switch
    const last = all.at(-1)
    const isPrompt =
      at.prompt !== null &&
      last?.role === 'user' &&
      last.toolResults === undefined &&
      last.text.includes(at.prompt.trim())
    const live = isPrompt ? all.slice(0, -1) : all
    await saveSnapshot($, (await read($, tree)).activeId, strip(live))
    await change($, cur => switchTo(cur, at.id))
    await update($, view, () => ({ openId: at.id, openTurnId: null }))
    const restored = restore(live, target)
    return { messages: isPrompt && last !== undefined ? [...restored, last] : restored }
  }).catch(($, e, next) =>
    next.called || switching === null ? next(e) : { skip: 'convo-fork: could not switch branches' },
  )

  // A switch asked for from the pane, the browser or /fork-to goes in at the first of these
  on('ui.press', async ($, e, next) => {
    const done = await next(e)
    await install($)
    return done
  }).catch(($, e, next) => (next.called ? undefined : next(e)))

  on('prompt.edit', async ($, e, next) => {
    await install($)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'fork-agent' }, async ($, e) => {
    const [ref = '', ...rest] = e.args.trim().split(/\s+/)
    return { text: await startAgent($, ref, rest.join(' ')) }
  })

  // Claude spawns convo-fork:branch with "Branch: A"; the branch's turns are spliced in here
  on('agent.spawn', async ($, e, next) => {
    if (e.subagentType !== AGENT) return next(e)
    const t = await read($, tree)
    const ref = BRANCH_LINE.exec(e.prompt)?.[1]
    const branch = ref === undefined ? undefined : findBranch(t, ref)
    if (branch === undefined) {
      return {
        deny: `Start the prompt with a line "Branch: <id or label>" naming one of these branches:\n${listText(t)}`,
      }
    }
    const task = e.prompt.replace(BRANCH_LINE, '').trim()
    const spawned = await next({ ...e, prompt: withBranch(t, branch.id, task) })
    if (spawned.agentId !== undefined) await change($, recordAgent(spawned.agentId, branch.id, task))
    return spawned
  }).catch(($, e, next) => (next.called ? next(e) : { deny: 'convo-fork: could not attach the branch.' }))

  // Back on a branch after talking elsewhere: the transcript is, or is about to be, that branch's; say so once
  on('prompt.submit', async ($, e, next) => {
    const t = await read($, tree)
    const asked = await read($, pending)
    const branch = branchOf(t, asked ?? t.activeId)
    if (branch === undefined || (asked === null && !isReturning(t))) return next(e)
    const note = `[convo-fork] The user switched the session to branch ${branch.id} "${labelOf(branch)}"; the conversation above is that branch's.${branch.summary === '' ? '' : ` Where it stood: ${branch.summary}`}`
    return next({ ...e, context: [...(e.context ?? []), note] })
  }).catch(($, e, next) => next(e))

  on('turn.start', async ($, e, next) => {
    await install($, e.text)
    await change($, t => startTurn(t, e.turnId, e.text))
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)

    if (e.agentId !== undefined) {
      const mine = (await read($, tree)).agents.find(a => a.agentId === e.agentId)
      if (mine !== undefined) {
        await change($, cur => ({
          ...cur,
          agents: cur.agents.map(a => (a.agentId === e.agentId ? { ...a, isDone: true } : a)),
        }))
        $.ui.toast(`Branch ${mine.branchId} subagent finished.`)
      }
      return done
    }

    const u = e.usage
    const tokens = u === undefined ? 0 : u.input_tokens + u.cache_creation_input_tokens + u.output_tokens
    await change($, t => finishTurn(t, e.turnId, e.answer, tokens))
    settle($)

    return done
  })

  // While a switch waits to go in, a band says where the next prompt goes
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const id = await read($, pending)
    const branch = id === null ? undefined : branchOf(await read($, tree), id)
    if (branch === undefined) return next(e)
    const { Text } = $.ui.resolve(e)
    return (
      <Text dimColor>
        ⑂ Next prompt goes to branch {branch.id} · {labelOf(branch)}
      </Text>
    )
  })

  // One bordered card per branch, indented by depth; opening a card shows its last turns and actions
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Markdown } = $.ui.resolve(e)
    const t = await read($, tree)
    const v = await read($, view)
    const width = Math.max(28, e.props.bodyColumns)
    const path = pathTo(t, t.activeId)
    const trail = path.map(b => (b.id === ROOT ? labelOf(b) : `${b.id} · ${labelOf(b)}`))

    const toggleCard = (id: string) => () =>
      update($, view, cur => ({ openId: cur.openId === id ? null : id, openTurnId: null }))
    const toggleTurn = (id: string) => () =>
      update($, view, cur => ({ ...cur, openTurnId: cur.openTurnId === id ? null : id }))

    // Dotted guides beside a card: ancestors' lines carry on, its own meets the card's title row
    const guides = (prefix: string, height: number) => {
      const chunks = prefix.match(/.{3}/g) ?? []
      const isLast = chunks.pop()?.startsWith('└') ?? true
      const lead = chunks.map(c => (c.startsWith('│') ? '┊  ' : '   ')).join('')
      const own = (i: number) => (i < 2 ? '┊  ' : i === 2 ? (isLast ? '╰┈┈' : '├┈┈') : isLast ? '   ' : '┊  ')
      return (
        <Box flexDirection="column">
          {Array.from({ length: height }, (_, i) => (
            <Text dimColor>{lead + own(i)}</Text>
          ))}
        </Box>
      )
    }

    // Lines a card takes, to draw its guides as tall: exact when closed, an estimate when open
    const heightOf = (id: string, room: number) => {
      if (id !== v.openId) return 4
      const turns = turnsOf(t, id)
      const shown = turns.slice(-3)
      const reply = shown.find(x => x.id === v.openTurnId)?.reply ?? ''
      const replyLines = cut(reply, 1500)
        .split('\n')
        .reduce((sum, line) => sum + Math.max(1, Math.ceil(line.length / Math.max(8, room - 2))), 0)
      const agents = Math.min(3, t.agents.filter(a => a.branchId === id).length)
      return 4 + 1 + (turns.length > 0 ? 1 : 0) + shown.length + (reply === '' ? 0 : replyLines) + agents + 2
    }

    const card = ({ branch, depth, prefix }: Row) => {
      const id = branch.id
      const turns = turnsOf(t, id)
      const isActive = id === t.activeId
      const isOpen = id === v.openId
      const room = width - depth * 3 - 4
      const count = turns.length === 0 ? 'empty' : `${turns.length} turn${turns.length === 1 ? '' : 's'}`
      const tag = id === ROOT ? '' : `${id} `
      const summary =
        branch.summary !== ''
          ? branch.summary
          : turns.length === 0
            ? 'No turns yet.'
            : oneLine(turns.at(-1)?.prompt ?? '')
      const border = isActive ? { borderColor: colorOf(t, id) } : { borderDimColor: true }
      return (
        <Box key={`row-${id}`}>
          {depth > 0 && guides(prefix, 1 + heightOf(id, room))}
          <Box
            key={`card-${id}`}
            flexDirection="column"
            flexGrow={1}
            marginTop={depth > 0 ? 1 : 0}
            borderStyle="round"
            paddingX={1}
            {...border}
          >
            <Box justifyContent="space-between">
              <Button key={`branch-${id}`} plain onPress={toggleCard(id)}>
                <Text color={colorOf(t, id)}>
                  {isActive ? '●' : turns.length === 0 ? '◌' : '○'} {tag}
                </Text>
                <Text bold={isActive}>{cut(labelOf(branch), Math.max(4, room - tag.length - count.length - 4))}</Text>
              </Button>
              <Text dimColor>{count}</Text>
            </Box>
            <Text dimColor>{cut(oneLine(summary), Math.max(8, room))}</Text>
            {isOpen && (
              <Box flexDirection="column" marginTop={1}>
                {turns.length > 0 && (
                  <Text dimColor>
                    {ranges(turns.map(x => x.n))} · {compact(tokensOf(t, id))} tokens
                  </Text>
                )}
                {turns.slice(-3).map(turn => (
                  <Box key={`turn-${turn.id}`} flexDirection="column">
                    <Button
                      key={`open-${turn.id}`}
                      plain
                      dimColor={v.openTurnId !== turn.id}
                      label={`${v.openTurnId === turn.id ? '▾' : '▸'} T${turn.n}  ${cut(oneLine(turn.prompt), room - 6 - String(turn.n).length)}`}
                      onPress={toggleTurn(turn.id)}
                    />
                    {v.openTurnId === turn.id && (
                      <Markdown key={`reply-${turn.id}`} text={cut(turn.reply ?? '_Still running…_', 1500)} />
                    )}
                  </Box>
                ))}
                {t.agents
                  .filter(a => a.branchId === id)
                  .slice(-3)
                  .map(a => (
                    <Text key={`agent-${a.agentId}`} dimColor>
                      ⧉ {cut(oneLine(a.task), room - 12)} {a.isDone ? '· done' : '· running'}
                    </Text>
                  ))}
                <Box marginTop={1} flexWrap="wrap" columnGap={1}>
                  {isActive ? (
                    <Button key={`split-${id}`} label="⑂ Split reply" onPress={() => void splitReply($)} />
                  ) : (
                    <Button
                      key={`switch-${id}`}
                      variant="primary"
                      label="Switch here"
                      onPress={() => showBranch($, id)}
                    />
                  )}
                  <Button
                    key={`agent-${id}`}
                    label="⧉ Agent"
                    onPress={() => void $.prompt.fill({ text: `/fork-agent ${id} `, mode: 'replace' })}
                  />
                </Box>
              </Box>
            )}
          </Box>
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        <Text dimColor>{cut(trail.join(' › '), width)}</Text>
        {rows(t).map(card)}
        <Box marginTop={1} flexWrap="wrap" columnGap={1}>
          <Button
            key="new"
            label="+ Branch"
            onPress={async () => {
              if ((await newBranch($, null)) === undefined) $.ui.toast(MID_TURN)
            }}
          />
          <Button key="web" label="↗ Map" onPress={() => void openBrowser($)} />
        </Box>
      </Box>
    )
  })
}
