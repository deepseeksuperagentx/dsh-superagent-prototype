/**
 * Keeps the orchestrator's own Session within a bounded size, so its event log cannot grow without end.
 *
 * Background: a DeepSeek Harness Session keeps its whole event log in memory (`dsh-session`'s `this.log` is only ever
 * appended to, never truncated), and a resumed Session is seeded with its entire persisted history. The orchestrator's own
 * Session therefore grew with every turn, and every restart loaded that whole history back into the heap. With the worker
 * Sessions released, this log was the one accumulation left that no longer had a bound.
 *
 * The Session's own compaction already keeps the model's context bounded, and its summary carries the continuity the
 * orchestrator needs: its identity, its intent, and the state of its work. The rotation uses that summary: when the stored
 * log grew past a threshold, the orchestrator starts a fresh Session and seeds it with the summary, so it keeps its context
 * and loses the raw event stream that grew without end.
 *
 * The rotation happens at startup, before the orchestrator does any work, and only for a Session whose stored log is larger
 * than the threshold. A Session that stays under it is left alone, so a healthy deployment never rotates.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-session-persistence'

/** How large a stored Session log may grow before the orchestrator's Session is rotated. */
const MASTER_EVENT_LIMIT = 4_000

/** The Session's stored log, read through the persistence service. */
interface StoredLog {
  /** The number of events the Session stored. */
  readonly events: number
  /** The text of the Session's latest compaction summary, which carries its continuity. */
  readonly summary?: string
}

/** What the rotation needs from its host. */
export interface MasterRotationHost {
  /** DSH Cordis context, whose persistence service reads the stored log. */
  readonly context: Context
  /** The orchestrator's own Session. */
  readonly masterId: string
  /** The directory the orchestrator's Session belongs to. */
  readonly cwd: string
  /** The title the orchestrator's Session carries. */
  readonly title: string
  /** The preset the orchestrator's Session runs. */
  readonly preset: string
}

/** Reads the stored log of a Session, and the text of its latest compaction summary. */
async function storedLog(context: Context, sessionId: string): Promise<StoredLog | undefined> {
  const persistence = context.sessionPersistence
  if (!persistence) return undefined
  try {
    await using handle = await persistence.open(sessionId as SessionId, 'read')
    const events: unknown[] = []
    for (let offset = 0; ; ) {
      const { events: page } = await handle.read(offset, 512)
      if (!page.length) break
      events.push(...page)
      offset += page.length
    }
    let summary: string | undefined
    for (let index = events.length - 1; index >= 0; index--) {
      const event = events[index] as { type?: string; data?: { summary?: unknown } }
      if (event?.type !== 'compaction/summary') continue
      const value = event.data?.summary
      // The summary is a list of content blocks; its text is what carries the continuity.
      const text = Array.isArray(value)
        ? value.map(block => (typeof block === 'string' ? block : (block as { text?: string })?.text ?? '')).join('\n')
        : typeof value === 'string' ? value : ''
      if (text) { summary = text; break }
    }
    return { events: events.length, summary }
  } catch {
    // A Session that cannot be read is left alone: the rotation is an optimization, not a requirement.
    return undefined
  }
}

/**
 * Rotates the orchestrator's Session when its stored log grew past the limit, seeding the fresh Session with the
 * compaction summary that carries its continuity.
 *
 * The rotation happens *before* the Session is loaded. A resumed Session is seeded with its whole stored log, so loading a
 * Session whose log grew past the limit would put that log into memory first and only then replace it — which leaves the
 * very memory the rotation was meant to save. Reading the stored log and rotating first keeps the large log out of the
 * heap entirely.
 *
 * The fresh Session gets a new identity: a Session that exists on disk is reused, so the same identity would carry the
 * old log back. The old identity keeps its record, and the orchestrator's identity moves to the fresh Session.
 *
 * @param host - the rotation's host.
 * @returns the fresh Session's identity, or `undefined` when no rotation was needed.
 */
export async function rotateMasterIfLarge(host: MasterRotationHost): Promise<string | undefined> {
  const ctx = host.context
  // The stored log is read before the Session is loaded, so its size is known before it costs memory.
  const stored = await storedLog(ctx, host.masterId)
  if (!stored || stored.events <= MASTER_EVENT_LIMIT) return undefined
  // The fresh Session starts empty, under a new identity, and the summary that carries the continuity is its first message.
  const fresh = `${host.masterId}-r${Date.now().toString(36)}`
  const workspace = await ctx.workspaceRegistry.create(host.cwd)
  await ctx.sessionController.create({ sessionId: fresh as SessionId, workspaceId: workspace.id, agentPreset: host.preset })
  const created = await ctx.sessionController.resolveAgent(fresh as SessionId)
  if ('error' in created) return undefined
  if (stored.summary) {
    // The summary is the Session's continuity: it says who the orchestrator is and what it was doing.
    await ctx.sessionController.prompt({
      sessionId: fresh as SessionId,
      requestId: 'master-rotation-summary' as SessionRequestId,
      mode: 'queue',
      content: [{ type: 'text', text: stored.summary }],
    }, AbortSignal.timeout(30_000)).catch(() => { /* The summary is a courtesy; the Session works without it. */ })
  }
  await ctx.sessionController.rename({ sessionId: fresh as SessionId, title: host.title })
  return fresh
}
