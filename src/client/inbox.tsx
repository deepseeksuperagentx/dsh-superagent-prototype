/**
 * Inbox page: open Tickets that wait for a person — a question from the worker, a result to review, a blocked or failed
 * run to decide, or a delivery to retry — each with the summary behind it and one box that answers it.
 *
 * The answer is a person's Trigger on the Ticket's own conversation, so the engine hands it to that Ticket's worker and
 * stops withholding automatic Inputs; the main Session sees the follow-up as it sees any other.
 */
import { useState } from 'react'
import { usePoll, type TicketRow } from './api.ts'
import { Button } from './controls.tsx'
import { ticketMark } from './marks.ts'
import { useAction, usePanel } from './provider.tsx'
import { ClampText, Hint, LoadState, MarkdownLite, SessionButton, StageMark, When } from './widgets.tsx'

/** One answer box; a Ticket whose Title is long still keeps the box visible above the fold. */
function AnswerBox({ ticket, onAnswered }: { ticket: TicketRow; onAnswered: () => Promise<unknown> }) {
  const { t, call } = usePanel()
  const [text, setText] = useState('')
  const send = useAction((value: string) => call('POST tickets/:id/answer', { id: ticket.id, body: { text: value } }),
    { reload: async () => { setText(''); await onAnswered() } })
  const ready = text.trim().length > 0
  return <div className="dt-inbox-answer">
    <textarea className="dt-textarea" rows={2} maxLength={20000} value={text} disabled={send.busy}
      placeholder={t('inboxReplyPlaceholder')} aria-label={t('inboxReplyLabel', { title: ticket.title })}
      onChange={event => setText(event.target.value)} />
    <div className="dt-row-buttons">
      <Button variant="primary" size="sm" disabled={send.busy || !ready}
        onClick={() => { if (ready) void send.run(text.trim()) }}>{t('inboxSend')}</Button>
    </div>
  </div>
}

function InboxLine({ ticket, onAnswered }: { ticket: TicketRow; onAnswered: () => Promise<unknown> }) {
  const { t, navigate } = usePanel()
  const mark = ticketMark(t, ticket)
  const question = ticket.stage === 'person' && ticket.action === 'answer' ? ticket.attention?.question : undefined
  return <li className="dt-row dt-ticket dt-inbox" data-state={mark.dot}>
    <div className="dt-ticket-stage"><StageMark state={mark.dot} icon={mark.icon} label={mark.label} /></div>
    <div className="dt-ticket-body">
      <div className="dt-row-title"><button type="button" className="dt-open" onClick={() => navigate({ page: 'execution',
        id: ticket.id })}>{ticket.title}</button></div>
      <div className="dt-row-meta dt-ticket-meta">
        <When at={ticket.updatedAt} />
        {ticket.sessionId && <SessionButton variant="outline" sessionId={ticket.sessionId} />}
      </div>
      {question && <div className="dt-row-quote"><MarkdownLite text={question} /></div>}
      {ticket.summary && <ClampText text={ticket.summary} />}
      <AnswerBox ticket={ticket} onAnswered={onAnswered} />
    </div>
  </li>
}

export function InboxPage() {
  const { t, call } = usePanel()
  const { data, error, reload } = usePoll(() => call('GET tickets', { query: { state: 'person', limit: 50 } }), [])
  if (!data) return <LoadState error={error} loading />
  return <>
    {error && <LoadState error={error} loading={false} />}
    <Hint>{t('inboxIntro')}</Hint>
    {data.items.length
      ? <ul className="dt-list dt-cards">{data.items.map(ticket => <InboxLine key={ticket.id} ticket={ticket}
        onAnswered={reload} />)}</ul>
      : <Hint>{t('inboxNone')}</Hint>}
  </>
}
