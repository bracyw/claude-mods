// A prompt and its reply, on the branch that was active when it was sent
export type Turn = {
  id: string
  branchId: string
  n: number
  prompt: string
  reply: string | null // null while the turn runs
  tokens: number
}

export type Branch = {
  id: string
  parentId: string | null
  label: string | null // null until Haiku titles it
  summary: string
  summarizedTurns: number // how many finished turns the summary covers
}

export type BranchAgent = {
  agentId: string
  branchId: string
  task: string
  isDone: boolean
}

// Branch ids, turn counts and token totals are all derived from these
export type Tree = {
  branches: Branch[]
  turns: Turn[]
  agents: BranchAgent[]
  activeId: string
}

// Which card in the pane is opened up, and which of its turns shows its reply
export type View = { openId: string | null; openTurnId: string | null }

// Where the browser view's server listens; kept so a reload asks for the same port
export type Bridge = { port: number; token: string }

declare module 'claude-code' {
  interface PluginState {
    'convo-tree': { tree: Tree; view: View; bridge: Bridge | null }
  }
}
