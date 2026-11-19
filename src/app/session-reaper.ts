/**
 * Releases the DSH Sessions of workers whose ticket ended, so their event logs stop occupying the orchestrator's heap.
 *
 * Background: a DSH `Session` keeps its whole event log in memory (`dsh-session`'s `this.log` is only ever appended to, never
 * truncated), and the orchestrator's worker Sessions live in the same process as the orchestrator itself. A worker that
 * finished its ticket kept its Session — and with it every `assistant/message` it ever produced, including the per-token
 * `stream` trace — resident until the process restarted. With dozens of finished tickets that is the dominant share of the
 * orchestrator's heap, and the reason it could run out of memory under load.
 *
 * The Session's disposer is owned by the handle that created it (`ctx.agents.create()` returns `{ agent, dispose }`), and
 * `sessionController.create()` does not hand it out. This module therefore records the disposer of every Session it observes
 * by intercepting `agent/created`, which the agent factory announces with the Session already entered: the agent's own scope
 * carries the Session's lifetime, so disposing that scope tears the Session down with it.
 *
 * The scope is the agent's Cordis scope (`dsh-scope`'s `createScope(loopCtx, agent)`), whose fiber owns the Session: the
 * agent factory's teardown detaches both the agent and the Session from their stores, which is what releases the Session's
 * event log. The agent's `ctx` is that scope's context, so `agent.ctx.fiber.dispose()` reaches the scope's fiber.
 *
 * Disposal is deliberately conservative:
 * - Only a worker's Session is reaped, never the orchestrator's own (`masterId`).
 * - Only a ticket that ended for good is reaped: a ticket ended *by a person* may be resumed, and a resumed ticket needs
 *   its worker's history, so its Session is kept.
 * - A Session that still runs (a turn, a shell job, a subagent) is left alone; it is reaped later, when it goes idle.
 * - The durable record on disk is kept. Reaping releases the in-memory Session; the persisted log under the DSH home stays
 *   the history a resumed ticket reads back. Disk cleanup is a separate, explicitly configured decision.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { ticketOfSession } from '../executor/dsh.ts'

/** How long a reaped Session's disposal may take before the reaper stops waiting for it. */
const DISPOSE_TIMEOUT_MS = 10_000

/**
 * Releases an Agent's scope, which owns its Session.
 *
 * The scope is the Agent's own Cordis scope (`dsh-scope`'s `createScope(loopCtx, agent)`), whose fiber the agent factory's
 * teardown uses to detach the agent and the Session from their stores — which is what releases the Session's event log.
 *
 * The scope is not on the public `Agent` interface, so it is reached structurally. The Agent's `ctx` cannot be used instead:
 * `ctx.extend()` builds the scope's context from the parent, so `agent.ctx.fiber` resolves to the *parent* fiber, whose
 * disposal leaves the scope untouched.
 *
 * @param agent - the agent whose scope is released.
 */
async function releaseScope(agent: Agent): Promise<void> {
  const scope = (agent as unknown as { scope?: { dispose?: () => Promise<void> } }).scope
  if (!scope?.dispose) {
    // Without a scope the agent has nothing of its own to release; its Session stays as it is.
    return
  }
  await scope.dispose()
}

/** What the reaper needs from its host. */
export interface SessionReaperHost {
  /** DSH Cordis context, whose `agent/created` and `agent/status` events drive the reaper. */
  readonly context: Context
  /** The orchestrator's own Session, which is never reaped. */
  readonly masterId: string
  /** Whether the ticket `ticketId` may still run again, such as one a person ended and may resume. */
  resumable(ticketId: string): boolean
  /**
   * The orchestrator Sessions a rotation superseded, by identity.
   *
   * The list is durable: a rotation happens in one process, but the panel's session history can promote the superseded
   * Session back into memory in a later one, and the Session is only reclaimable while the orchestrator still knows it
   * was superseded.
   */
  superseded(): readonly string[]
  /**
   * Runs `action` once the outermost transaction commits, or right away outside one.
   *
   * The Engine reports `ticket.ended` inside the transaction that ends the ticket, and the Executor cancels the worker's
   * turn in the same transaction's commit. The release therefore waits for the commit, so it sees the worker after its
   * turn was cancelled rather than while it still runs.
   */
  afterCommit(action: () => void): void
}

/** A worker Session that may be released, and how to release it. */
interface Reapable {
  /** The Session's identity. */
  readonly sessionId: string
  /** The ticket whose worker this Session is. */
  readonly ticketId: string
  /** Releases the Session and everything it holds. */
  readonly dispose: () => Promise<void>
}

/**
 * Releases the worker Sessions of tickets that ended, once their workers went idle.
 *
 * The reaper learns of a Session when it is created, remembers how to release it, and releases it when its ticket ended for
 * good and its worker holds nothing that still runs. A worker that is busy when its ticket ends is released later, on the
 * `agent/status` edge that reports it idle.
 */
export class SessionReaper {
  private readonly reaped = new Map<string, Reapable>()
  /** The Sessions that were already released, so a later event does not release one twice. */
  private readonly released = new Set<string>()
  /** The waits for a busy worker to settle, by Session, so a later event does not start a second wait. */
  private readonly pending = new Map<string, Promise<void>>()
  /** The Sessions whose worker was waited for, so a worker that never settles is released after its wait. */
  private readonly settled = new Set<string>()
  /** The tickets that ended and may be released, by ticket, whether their worker is idle yet. */
  private readonly ended = new Set<string>()
  /** The orchestrator Sessions that a rotation superseded, by identity; they are released once they settle. */
  private readonly superseded = new Set<string>()
  private readonly disposers: (() => void)[] = []
  private readonly timers = new Set<ReturnType<typeof setTimeout>>()

  constructor(private readonly host: SessionReaperHost) {}

  /** Starts watching for the Sessions to release. */
  install(): void {
    const ctx = this.host.context
    // The Sessions a rotation superseded, from an earlier process too, are reclaimed when they are promoted again.
    for (const sessionId of this.host.superseded()) this.superseded.add(sessionId)
    // `agent/created` fires after the Session was entered, so the agent's scope carries the Session's lifetime.
    this.disposers.push(ctx.on('agent/created', ({ agent }) => {
      this.remember(agent)
      this.releaseSuperseded(agent)
      return undefined
    }))
    // A worker's first status change also tells the reaper of its Session, and a worker that was busy when its ticket
    // ended is released when it goes idle.
    this.disposers.push(ctx.on('agent/status', ({ agent, status }) => {
      this.remember(agent)
      this.releaseSuperseded(agent)
      if (status !== 'idle') return
      void this.release(agent)
    }))
  }

  /**
   * Notes that a rotation superseded an orchestrator Session, so it is released once it settles.
   *
   * A rotation gives the orchestrator a fresh Session, and the Session it replaced keeps its record on disk. The panel's
   * session history promotes a stored Session back into memory when a person browses it, so the superseded Session can be
   * loaded again — with its whole event log — after the rotation. Releasing it once it settles keeps that from becoming
   * the next accumulation.
   *
   * @param sessionId - the identity the rotation superseded.
   */
  supersededByRotation(sessionId: string): void {
    if (sessionId === this.host.masterId) return
    this.superseded.add(sessionId)
    const agent = this.host.context.agents.get(sessionId as SessionId)
    if (agent) this.releaseSuperseded(agent)
  }

  /**
   * Releases a superseded orchestrator Session when it holds nothing that still runs.
   *
   * @param agent - the Session's agent.
   */
  private releaseSuperseded(agent: Agent): void {
    if (!this.superseded.has(agent.id)) return
    if (agent.id === this.host.masterId) return
    if (agent.status !== 'idle') return
    // The panel's session history promotes the Session again whenever it is browsed, so the Session stays in the
    // superseded set and is released again after each promotion, rather than kept for the rest of the process's life.
    this.released.delete(agent.id)
    this.released.add(agent.id)
    void releaseScope(agent).catch((error: unknown) => {
      this.host.context.logger.warn('dsh-superagent could not release the superseded Session %s: %s', agent.id, String(error))
    })
  }

  /**
   * Remembers a Session that may be released later, and releases it right away when its ticket already ended.
   *
   * @param agent - the Session's agent.
   */
  private remember(agent: Agent): void {
    // A Session that was already released is not learned again: the agent outlives its release until the host stops.
    if (this.reaped.has(agent.id) || this.released.has(agent.id)) return
    const ticketId = ticketOfSession(agent.id)
    // The orchestrator's own Session and any Session that is not a worker's are not the reaper's business.
    if (ticketId === undefined || agent.id === this.host.masterId) return
    const sessionId = agent.id
    this.reaped.set(sessionId, {
      sessionId,
      ticketId,
      // The agent's scope owns the Session: disposing it unwinds the Session's registrations with it.
      dispose: async () => { await releaseScope(agent) }
    })
    void this.release(agent)
  }

  /**
   * Notes that a ticket ended, and releases its worker's Session when the worker holds nothing that still runs.
   *
   * @param ticketId - the ticket that ended.
   */
  ticketEnded(ticketId: string): void {
    // A ticket a person ended may be resumed, and a resumed ticket reads its worker's history back.
    if (this.host.resumable(ticketId)) return
    this.ended.add(ticketId)
    // The Engine reports the end inside the transaction, and the Executor cancels the worker's turn in the commit. The
    // release waits for that commit, so it sees the worker after its turn was cancelled.
    this.host.afterCommit(() => {
      const agent = this.host.context.agents.get(`worker-${ticketId}` as SessionId)
      // The worker may have been announced before the reaper saw it; remembering it here covers that case.
      if (agent) this.remember(agent)
      if (agent) void this.release(agent)
    })
  }

  /**
   * Releases a worker's Session when its ticket ended for good and the worker holds nothing that still runs.
   *
   * A worker that is still busy keeps its Session until it settles: the Executor cancels the turn of a ticket that ended,
   * and the agent reaches quiescence then. The release waits for that, so a worker that still holds a shell job or a
   * subagent is not cut off mid-work.
   *
   * @param agent - the worker's agent.
   */
  private async release(agent: Agent): Promise<void> {
    const entry = this.reaped.get(agent.id)
    if (!entry) return
    if (!this.ended.has(entry.ticketId)) return
    // A worker that still runs keeps its Session until it settles: the Executor stops the ticket's work when the ticket
    // ends, so a worker that holds nothing settles on its own. The wait is bounded, and a worker that never settles is
    // released anyway: its ticket ended, so its work is done and its Session only holds history.
    if (agent.status !== 'idle' && !this.settled.has(entry.sessionId)) {
      this.settled.add(entry.sessionId)
      this.pending.set(entry.sessionId, this.settledWait(agent).then(() => {
        this.pending.delete(entry.sessionId)
        this.release(agent)
      }))
      return
    }
    // The Session is released once; a second call finds nothing to do.
    this.reaped.delete(entry.sessionId)
    this.released.add(entry.sessionId)
    this.pending.delete(entry.sessionId)
    try {
      await Promise.race([
        entry.dispose(),
        new Promise<void>(resolve => {
          const timer = setTimeout(resolve, DISPOSE_TIMEOUT_MS)
          this.timers.add(timer)
        })
      ])
    } catch (error) {
      this.host.context.logger.warn('dsh-superagent could not release the Session of ended ticket %s: %s',
        entry.ticketId, String(error))
    } finally {
      for (const timer of this.timers) clearTimeout(timer)
      this.timers.clear()
    }
  }

  /**
   * Waits for an agent to reach quiescence, but no longer than the release budget.
   *
   * @param agent - the agent that settles.
   */
  private async settledWait(agent: Agent): Promise<void> {
    if (agent.status === 'idle') return
    await Promise.race([
      agent.whenIdle().catch(() => {}),
      new Promise<void>(resolve => {
        const timer = setTimeout(resolve, DISPOSE_TIMEOUT_MS)
        this.timers.add(timer)
      })
    ])
  }

  /** Stops watching and releases the timers it holds. */
  dispose(): void {
    for (const dispose of this.disposers.splice(0)) dispose()
    for (const timer of this.timers) clearTimeout(timer)
    this.timers.clear()
    this.reaped.clear()
    this.released.clear()
    this.pending.clear()
    this.settled.clear()
    this.ended.clear()
  }
}
