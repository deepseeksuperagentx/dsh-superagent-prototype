/** Releasing the worker Session of a Ticket that ended, so its event log stops occupying the orchestrator's heap. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { expect, it, vi } from 'vitest'
import { SessionReaper } from '../src/app/session-reaper.ts'

/** A worker agent whose scope carries a disposer, as DSH's agent scope does. */
function worker(id: string, status = 'idle') {
  const dispose = vi.fn(async () => {})
  const agent = {
    id,
    status,
    scope: { dispose },
    whenIdle: vi.fn(async () => {}),
  } as unknown as Agent & { status: string; scope: { dispose: ReturnType<typeof vi.fn> } }
  return { agent, dispose }
}

/** A context that delivers DSH's `agent/created` and `agent/status` events to the reaper. */
function setup(options: { resumable?: (ticketId: string) => boolean; superseded?: string[] } = {}) {
  const listeners = new Map<string, ((payload: unknown) => unknown)[]>()
  const agents = new Map<string, Agent>()
  const ctx = {
    agents: { get: (id: string) => agents.get(id) },
    logger: { warn: vi.fn() },
    on: (name: string, listener: (payload: unknown) => unknown) => {
      const list = listeners.get(name) ?? []
      list.push(listener)
      listeners.set(name, list)
      return () => { listeners.set(name, (listeners.get(name) ?? []).filter(item => item !== listener)) }
    },
  } as unknown as Context
  const reaper = new SessionReaper({ context: ctx, masterId: 'orchestrator-master', resumable: options.resumable ?? (() => false),
    superseded: () => options.superseded ?? [], afterCommit: action => action() })
  reaper.install()
  const emit = async (name: string, payload: unknown) => {
    for (const listener of listeners.get(name) ?? []) await listener(payload)
  }
  return { reaper, ctx, emit, agents, listeners }
}

it('releases the worker Session of a Ticket that ended once the worker went idle', async () => {
  const { reaper, emit, agents } = setup()
  const { agent, dispose } = worker('worker-t1')
  agents.set(agent.id, agent)
  await emit('agent/created', { agent })
  reaper.ticketEnded('t1')
  await vi.waitFor(() => { expect(dispose).toHaveBeenCalledTimes(1) })
})

it('keeps the worker Session of a Ticket that is still live', async () => {
  const { reaper, emit, agents } = setup()
  const { agent, dispose } = worker('worker-t1')
  agents.set(agent.id, agent)
  await emit('agent/created', { agent })
  expect(dispose).not.toHaveBeenCalled()
})

it('keeps the worker Session of a Ticket a person ended, which may be resumed', async () => {
  const { reaper, emit, agents } = setup({ resumable: (ticketId: string) => ticketId === 't1' })
  const { agent, dispose } = worker('worker-t1')
  agents.set(agent.id, agent)
  await emit('agent/created', { agent })
  reaper.ticketEnded('t1')
  expect(dispose).not.toHaveBeenCalled()
})

it('releases a busy worker Session once it settled, not while it still runs', async () => {
  const { reaper, emit, agents } = setup()
  const { agent, dispose } = worker('worker-t1', 'running')
  // A worker that still runs does not settle on its own.
  ;(agent as unknown as { whenIdle: () => Promise<void> }).whenIdle = vi.fn(() => new Promise<void>(() => {}))
  agents.set(agent.id, agent)
  await emit('agent/created', { agent })
  reaper.ticketEnded('t1')
  // A worker that still runs keeps its Session.
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(dispose).not.toHaveBeenCalled()
  // It is released when it goes idle, which DSH announces.
  ;(agent as { status: string }).status = 'idle'
  await emit('agent/status', { agent, status: 'idle' })
  await vi.waitFor(() => { expect(dispose).toHaveBeenCalledTimes(1) })
})

it('never releases the orchestrator\'s own Session', async () => {
  const { reaper, emit, agents } = setup()
  const { agent, dispose } = worker('orchestrator-master')
  agents.set(agent.id, agent)
  await emit('agent/created', { agent })
  reaper.ticketEnded('t1')
  expect(dispose).not.toHaveBeenCalled()
})

it('releases a Session once, not again on a later event', async () => {
  const { reaper, emit, agents } = setup()
  const { agent, dispose } = worker('worker-t1')
  agents.set(agent.id, agent)
  await emit('agent/created', { agent })
  reaper.ticketEnded('t1')
  await vi.waitFor(() => { expect(dispose).toHaveBeenCalledTimes(1) })
  await emit('agent/status', { agent, status: 'idle' })
  reaper.ticketEnded('t1')
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(dispose).toHaveBeenCalledTimes(1)
})

it('releases a Session whose Ticket ended before the Session was announced', async () => {
  const { reaper, emit, agents } = setup()
  // The Ticket ended while its worker was still being created.
  reaper.ticketEnded('t1')
  const { agent, dispose } = worker('worker-t1')
  agents.set(agent.id, agent)
  await emit('agent/created', { agent })
  expect(dispose).toHaveBeenCalledTimes(1)
})

it('reports a failed release without failing the reaper', async () => {
  const { reaper, emit, agents, ctx } = setup()
  const { agent } = worker('worker-t1')
  ;(agent.scope.dispose as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('busy'))
  agents.set(agent.id, agent)
  await emit('agent/created', { agent })
  reaper.ticketEnded('t1')
  await new Promise(resolve => setTimeout(resolve, 0))
  expect((ctx.logger.warn as unknown as ReturnType<typeof vi.fn>)).toHaveBeenCalled()
})

it('releases an orchestrator Session a rotation superseded', async () => {
  const { reaper, emit, agents } = setup()
  const { agent, dispose } = worker('orchestrator-old')
  agents.set(agent.id, agent)
  await emit('agent/created', { agent })
  // The panel's session history can promote the superseded Session back into memory.
  reaper.supersededByRotation('orchestrator-old')
  await vi.waitFor(() => { expect(dispose).toHaveBeenCalledTimes(1) })
})

it('keeps the orchestrator\'s current Session even when a rotation is announced for it', async () => {
  const { reaper, emit, agents } = setup()
  const { agent, dispose } = worker('orchestrator-master')
  agents.set(agent.id, agent)
  await emit('agent/created', { agent })
  reaper.supersededByRotation('orchestrator-master')
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(dispose).not.toHaveBeenCalled()
})

it('reclaims a Session an earlier process superseded', async () => {
  // The superseded list is durable, so a later process knows the Session it may reclaim.
  const { reaper, emit, agents } = setup({ superseded: ['orchestrator-old'] })
  const { agent, dispose } = worker('orchestrator-old')
  agents.set(agent.id, agent)
  await emit('agent/created', { agent })
  await vi.waitFor(() => { expect(dispose).toHaveBeenCalledTimes(1) })
})

it('reclaims a superseded Session again when the panel promotes it once more', async () => {
  const { reaper, emit, agents } = setup({ superseded: ['orchestrator-old'] })
  const { agent, dispose } = worker('orchestrator-old')
  agents.set(agent.id, agent)
  await emit('agent/created', { agent })
  await vi.waitFor(() => { expect(dispose).toHaveBeenCalledTimes(1) })
  // The panel's session history promotes it again whenever it is browsed.
  await emit('agent/status', { agent, status: 'idle' })
  await vi.waitFor(() => { expect(dispose).toHaveBeenCalledTimes(2) })
})
