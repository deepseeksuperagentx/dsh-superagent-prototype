/** Rotating the orchestrator's own Session when its stored log grew past the limit. */
import type { Context } from '@deepseek-ai/cordis'
import { expect, it, vi } from 'vitest'
import { rotateMasterIfLarge } from '../src/app/master-rotation.ts'

/** A persistence service that reads a stored log of `count` events, whose last compaction summary is `summary`. */
function persistence(count: number, summary?: string) {
  type StoredEvent = { type: string; data: { step?: number; summary?: unknown } }
  const events: StoredEvent[] = Array.from({ length: count }, (_, index) => ({ type: 'step/start', data: { step: index } }))
  if (summary) events.push({ type: 'compaction/summary', data: { summary: [{ type: 'text', text: summary }] } })
  return {
    open: vi.fn(async () => ({
      read: async (offset: number, limit?: number) => ({ events: events.slice(offset, limit ? offset + limit : undefined) }),
      close: async () => {},
      [Symbol.asyncDispose]: async () => {},
    })),
  }
}

/** A context whose services the rotation reads and writes. */
function setup(options: { count: number; summary?: string }) {
  const create = vi.fn(async () => {})
  const prompt = vi.fn(async (_request: { content: { type: string; text: string }[] }) => ({ accepted: true as const }))
  const rename = vi.fn(async () => {})
  const dispose = vi.fn(async () => {})
  const agent = { id: 'orchestrator-master', scope: { dispose } }
  const services: Record<string, unknown> = {
    sessionPersistence: persistence(options.count, options.summary),
    sessionController: { create, prompt, rename, resolveAgent: vi.fn(async () => ({ agent })) },
    workspaceRegistry: { create: async () => ({ id: '/state' }) },
  }
  const ctx = {
    get: (name: string) => services[name],
    agents: { get: () => agent },
    workspaceRegistry: services.workspaceRegistry,
    sessionController: services.sessionController,
    sessionPersistence: services.sessionPersistence,
  } as unknown as Context
  const host = { context: ctx, masterId: 'orchestrator-master', cwd: '/state', title: 'orchestrator', preset: 'dsh-superagent-router' }
  return { host, create, prompt, rename, dispose }
}

it('leaves a Session whose log is within the limit alone', async () => {
  const { host, create, dispose } = setup({ count: 100 })
  expect(await rotateMasterIfLarge(host)).toBeUndefined()
  expect(create).not.toHaveBeenCalled()
  expect(dispose).not.toHaveBeenCalled()
})

it('rotates a Session whose log grew past the limit, and seeds it with the compaction summary', async () => {
  const { host, create, prompt, rename } = setup({ count: 5_000, summary: '## Primary Request and Intent\n- the orchestrator' })
  const fresh = await rotateMasterIfLarge(host)
  expect(fresh).toBeDefined()
  // A fresh Session under a new identity takes the place of the one that grew.
  expect(create).toHaveBeenCalledTimes(1)
  expect(fresh).not.toBe('orchestrator-master')
  // The summary carries the continuity the fresh Session needs.
  expect(prompt).toHaveBeenCalledTimes(1)
  const request = prompt.mock.calls[0]![0]
  expect(request.content[0]!.text).toContain('the orchestrator')
  expect(rename).toHaveBeenCalledTimes(1)
})

it('rotates a Session without a summary, leaving the fresh Session without a seed', async () => {
  const { host, create, prompt } = setup({ count: 5_000 })
  expect(await rotateMasterIfLarge(host)).toBeDefined()
  expect(create).toHaveBeenCalledTimes(1)
  expect(prompt).not.toHaveBeenCalled()
})

it('leaves a Session alone when its log cannot be read', async () => {
  const { host, create } = setup({ count: 5_000 })
  const persistence = host.context.sessionPersistence as unknown as { open: ReturnType<typeof vi.fn> }
  persistence.open.mockRejectedValueOnce(new Error('unreadable'))
  expect(await rotateMasterIfLarge(host)).toBeUndefined()
  expect(create).not.toHaveBeenCalled()
})
