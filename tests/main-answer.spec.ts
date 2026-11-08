/** Main Session answer path: a person's answer reaches a waiting ticket as a human Trigger; a note refuses instead of stalling it. */
import { afterEach, expect, it } from 'vitest'
import { feishu, startRuntime, type Host } from './fixtures/host.ts'

let h: Host | undefined
afterEach(async () => { await h?.stop(); h = undefined })

/** A ticket whose worker reported blocked with a question for the person who opened it. */
async function waiting() {
  h = await startRuntime()
  const { ticket, sessionId } = await h.acceptedTicket(feishu('1', '@bot 修一下回归'))
  await h.runTool(sessionId, 'orchestrator_report', {
    state: 'blocked', summary: '需要你拍板', human_action: '用哪个路由?', question_for_trigger_id: ticket.origin.triggerId,
  })
  expect(h.runtime.store.tickets.get(ticket.id)?.attention?.question).toBe('用哪个路由?')
  return { ticket, sessionId }
}

it('refuses a note while the ticket waits on a person, naming the answer tool instead of stalling it', async () => {
  const { ticket } = await waiting()
  await expect(h!.runTool(h!.runtime.masterId, 'orchestrator_ticket_note', { ticket_id: ticket.id, text: 'B 改了设置' }))
    .rejects.toThrow(/orchestrator_ticket_answer/)
  // The refusal leaves the waiting question in place rather than recording context nobody will read.
  expect(h!.runtime.store.tickets.get(ticket.id)?.attention?.question).toBe('用哪个路由?')
  expect(h!.runtime.store.tickets.get(ticket.id)?.inputs.some(input => input.kind === 'note')).toBe(false)
})

it('offers orchestrator_ticket_answer, which builds a person\'s Trigger on the ticket\'s own conversation', async () => {
  const { ticket } = await waiting()
  expect(h!.tools.get(h!.runtime.masterId)?.has('orchestrator_ticket_answer')).toBe(true)
  // This ticket started on Feishu: the answer belongs on that channel, which the tool names, like the panel route does.
  await expect(h!.runTool(h!.runtime.masterId, 'orchestrator_ticket_answer', { ticket_id: ticket.id, text: '用 A' }))
    .rejects.toThrow(/Webhook/)
})
