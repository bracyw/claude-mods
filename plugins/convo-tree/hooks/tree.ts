import type { Branch, Tree, Turn } from '../types'

export const ROOT = 'root'
const MAX_PROMPT = 2000
const MAX_REPLY = 4000
const MAX_CONTEXT = 60000

export const emptyTree = (): Tree => ({
  branches: [{ id: ROOT, parentId: null, label: null, summary: '', summarizedTurns: 0 }],
  turns: [],
  agents: [],
  activeId: ROOT,
})

// 0 → A, 25 → Z, 26 → AA
const keyOf = (n: number): string =>
  (n >= 26 ? keyOf(Math.floor(n / 26) - 1) : '') + String.fromCharCode(65 + (n % 26))

export const labelOf = (b: Branch) => b.label ?? (b.id === ROOT ? 'Root' : 'New branch')

export const branchOf = (tree: Tree, id: string) => tree.branches.find(b => b.id === id)

export const findBranch = (tree: Tree, ref: string) => {
  const want = ref.trim().toLowerCase()
  return (
    tree.branches.find(b => b.id.toLowerCase() === want) ??
    tree.branches.find(b => labelOf(b).toLowerCase() === want) ??
    tree.branches.find(b => labelOf(b).toLowerCase().includes(want))
  )
}

const childrenOf = (tree: Tree, id: string) => tree.branches.filter(b => b.parentId === id)

export const turnsOf = (tree: Tree, id: string) => tree.turns.filter(t => t.branchId === id)

export const tokensOf = (tree: Tree, id: string) => turnsOf(tree, id).reduce((sum, t) => sum + t.tokens, 0)

export const pathTo = (tree: Tree, id: string): Branch[] => {
  const branch = branchOf(tree, id)
  if (branch === undefined) return []
  return branch.parentId === null ? [branch] : [...pathTo(tree, branch.parentId), branch]
}

// Children of the active branch; ids follow on from the last, as branches are never removed
export const addBranches = (tree: Tree, labels: readonly (string | null)[]): Tree => ({
  ...tree,
  branches: [
    ...tree.branches,
    ...labels.map((label, i): Branch => ({
      id: keyOf(tree.branches.length - 1 + i),
      parentId: tree.activeId,
      label,
      summary: '',
      summarizedTurns: 0,
    })),
  ],
})

export const switchTo = (tree: Tree, id: string): Tree =>
  branchOf(tree, id) === undefined ? tree : { ...tree, activeId: id }

// What the host wraps around a typed prompt (reminders, slash-command echoes), not the person's words
// A tag with no closing tag runs to the end
const HOST_TAGS =
  /<(system-reminder|local-command-caveat|local-command-stdout|command-name|command-message|command-args)>[\s\S]*?(<\/\1>|$)/g

const cleanPrompt = (text: string) => text.replace(HOST_TAGS, '').trim()

// A turn belongs to the branch that is active when it starts
export const startTurn = (tree: Tree, id: string, prompt: string): Tree => ({
  ...tree,
  turns: [
    ...tree.turns,
    {
      id,
      branchId: tree.activeId,
      n: tree.turns.length + 1,
      prompt: cleanPrompt(prompt).slice(0, MAX_PROMPT),
      reply: null,
      tokens: 0,
    },
  ],
})

export const finishTurn = (tree: Tree, id: string, reply: string, tokens: number): Tree => ({
  ...tree,
  turns: tree.turns.map(t => (t.id === id ? { ...t, reply: reply.slice(0, MAX_REPLY), tokens } : t)),
})

export const patchBranch = (tree: Tree, id: string, patch: Partial<Branch>): Tree => ({
  ...tree,
  branches: tree.branches.map(b => (b.id === id ? { ...b, ...patch } : b)),
})

// The person is on a branch with turns, and the last turn was on another one
export const isReturning = (tree: Tree) => {
  const last = tree.turns.at(-1)
  return last !== undefined && last.branchId !== tree.activeId && turnsOf(tree, tree.activeId).length > 0
}

// "T2–3, T6" from turn numbers
export const ranges = (ns: readonly number[]): string => {
  const runs: [number, number][] = []
  for (const n of ns) {
    const last = runs.at(-1)
    if (last !== undefined && n === last[1] + 1) last[1] = n
    else runs.push([n, n])
  }
  return runs.map(([a, b]) => (a === b ? `T${a}` : `T${a}–${b}`)).join(', ')
}

export const compact = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : `${n}`)

export type Row = { branch: Branch; prefix: string; depth: number }

// Depth-first rows with box-drawing prefixes
export const rows = (tree: Tree): Row[] => {
  const walk = (id: string, lead: string, isLast: boolean, depth: number): Row[] => {
    const branch = branchOf(tree, id)
    if (branch === undefined) return []
    const prefix = depth === 0 ? '' : lead + (isLast ? '└─ ' : '├─ ')
    const childLead = depth === 0 ? '' : lead + (isLast ? '   ' : '│  ')
    const kids = childrenOf(tree, id)
    return [
      { branch, prefix, depth },
      ...kids.flatMap((kid, i) => walk(kid.id, childLead, i === kids.length - 1, depth + 1)),
    ]
  }
  return walk(ROOT, '', true, 0)
}

const nameOf = (b: Branch) => (b.id === ROOT ? `root "${labelOf(b)}"` : `${b.id} "${labelOf(b)}"`)

const turnText = (t: Turn) =>
  `### T${t.n} · user\n${t.prompt}\n\n### T${t.n} · assistant\n${t.reply ?? '(still running)'}`

// Root → branch: each ancestor's turns from before the branch began, then the branch's own
export const branchContext = (tree: Tree, id: string): string | undefined => {
  const path = pathTo(tree, id)
  const branch = path.at(-1)
  if (branch === undefined) return undefined
  const own = turnsOf(tree, id)
  const start = own[0]?.n ?? Infinity
  const sections = path.slice(0, -1).flatMap(a => {
    const lead = turnsOf(tree, a.id).filter(t => t.n < start)
    return lead.length === 0 ? [] : [`## Lead-in: ${nameOf(a)}\n\n${lead.map(turnText).join('\n\n')}`]
  })
  sections.push(
    `## Branch ${nameOf(branch)}\n\n${own.length === 0 ? '(no turns yet)' : own.map(turnText).join('\n\n')}`,
  )
  const head = [
    `# Conversation branch ${nameOf(branch)}`,
    `Path: ${path.map(nameOf).join(' › ')}`,
    branch.summary === '' ? '' : `Summary: ${branch.summary}`,
    'Only the user prompts and final assistant replies are kept; tool calls and outputs are omitted.',
  ].filter(Boolean)
  const text = [...head, ...sections].join('\n\n')
  return text.length > MAX_CONTEXT ? `…(earlier text cut)\n${text.slice(-MAX_CONTEXT)}` : text
}

export const listText = (tree: Tree): string =>
  rows(tree)
    .map(({ branch, prefix }) => {
      const turns = turnsOf(tree, branch.id).map(t => t.n)
      const mark = branch.id === tree.activeId ? ' (active)' : ''
      const where = turns.length === 0 ? 'no turns' : ranges(turns)
      const summary = branch.summary === '' ? '' : ` — ${branch.summary}`
      return `${prefix}${nameOf(branch)}${mark}: ${where}${summary}`
    })
    .join('\n')
