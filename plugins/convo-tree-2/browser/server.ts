// The browser view's bridge, run by the mod with bun: serves the page, relays
// the tree to it over server-sent events, and prints the page's actions on
// stdout for the mod to read.
//
//   bun server.ts <port> <token>      port 0 picks one; token "" makes one
//
// stdout: `READY {"port","token"}` once listening, `ACTION {...}` per click.

const [portArg = '0', tokenArg = ''] = Bun.argv.slice(2)
const token = tokenArg !== '' ? tokenArg : crypto.randomUUID().replaceAll('-', '')
// Read on every load, so an edit to the page shows on refresh
const page = Bun.file(new URL('./index.html', import.meta.url))
const encoder = new TextEncoder()

let tree = 'null'
const clients = new Set<ReadableStreamDefaultController<Uint8Array>>()

const send = (client: ReadableStreamDefaultController<Uint8Array>, chunk: string) => {
  try {
    client.enqueue(encoder.encode(chunk))
  } catch {
    clients.delete(client)
  }
}

const events = () => {
  let self: ReadableStreamDefaultController<Uint8Array> | undefined
  const stream = new ReadableStream<Uint8Array>({
    start(client) {
      self = client
      clients.add(client)
      send(client, `data: ${tree}\n\n`)
    },
    cancel() {
      if (self !== undefined) clients.delete(self)
    },
  })
  return new Response(stream, {
    headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
  })
}

const handle = async (req: Request) => {
  const url = new URL(req.url)
  const isAllowed = url.searchParams.get('t') === token || req.headers.get('x-token') === token
  if (!isAllowed) return new Response('Forbidden', { status: 403 })

  if (req.method === 'GET' && url.pathname === '/') {
    return new Response(await page.text(), { headers: { 'content-type': 'text/html; charset=utf-8' } })
  }
  if (req.method === 'GET' && url.pathname === '/events') return events()
  if (req.method === 'POST' && url.pathname === '/tree') {
    tree = JSON.stringify(await req.json())
    for (const client of clients) send(client, `data: ${tree}\n\n`)
    return new Response('ok')
  }
  if (req.method === 'POST' && url.pathname === '/action') {
    console.log(`ACTION ${JSON.stringify(await req.json())}`)
    return new Response('ok')
  }
  return new Response('Not found', { status: 404 })
}

// The port a reload asks back may still be held by the child it replaced
const listen = async (port: number) => {
  for (let tries = 0; port !== 0 && tries < 20; tries++) {
    try {
      return Bun.serve({ hostname: '127.0.0.1', port, fetch: handle, idleTimeout: 0 })
    } catch {
      await Bun.sleep(150)
    }
  }
  return Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: handle, idleTimeout: 0 })
}

const server = await listen(Number(portArg))
console.log(`READY ${JSON.stringify({ port: server.port, token })}`)

// Keep the event streams open, and leave when the session that started us is gone
const parent = process.ppid
setInterval(() => {
  for (const client of clients) send(client, ': ping\n\n')
  if (process.ppid !== parent) process.exit(0)
}, 15000)
