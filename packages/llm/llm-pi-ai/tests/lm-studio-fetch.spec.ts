import { createServer } from 'node:http'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { Agent, getGlobalDispatcher, setGlobalDispatcher } from 'undici'
import { expect, it } from 'vitest'
import { fetchLmStudioStream } from '../src/lm-studio-fetch.ts'

it('survives an idle SSE body until the caller deadline and still honors cancellation', async () => {
  const previous = getGlobalDispatcher()
  const agent = new Agent({ bodyTimeout: 50 })
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    res.flushHeaders()
    const timer = setTimeout(() => res.end('data: OK\n\n'), 1800)
    res.on('close', () => { clearTimeout(timer) })
  })
  try {
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    setGlobalDispatcher(agent)
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`
    const control = await fetch(url)
    await expect(control.text()).rejects.toMatchObject({ cause: { code: 'UND_ERR_BODY_TIMEOUT' } })
    expect(await (await fetchLmStudioStream(url)).text()).toBe('data: OK\n\n')
    const controller = new AbortController()
    const response = await fetchLmStudioStream(url, { signal: controller.signal })
    controller.abort()
    await expect(response.text()).rejects.toMatchObject({ name: 'AbortError' })
  } finally {
    setGlobalDispatcher(previous)
    server.closeAllConnections()
    server.close()
    await agent.close()
  }
})
