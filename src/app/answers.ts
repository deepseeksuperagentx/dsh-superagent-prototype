/**
 * A person's answer from the management panel, back on the ticket's own conversation.
 *
 * The engine only accepts a person's message as a Trigger on the thread it came from, and the panel has no other write
 * path for answers. The Webhook Source is the one channel where a person can be the sender, so the answer is written the
 * way that Source reads its events: same conversation, the event that started the ticket as its thread, `sender.bot`
 * false and `addressed: direct`, which makes it a human Trigger the engine admits as an explicit request and stops
 * withholding automatic Inputs for the ticket.
 */
import { createHash } from 'node:crypto'
import { UserError } from '../core/errors.ts'
import type { Ticket } from '../core/model.ts'
import { webhookTrigger, type WebhookEvent } from '../sources/webhook.ts'

/** The event a panel answer becomes, or a `UserError` when the ticket started on a Source the panel cannot answer. */
export function answerEvent(ticket: Ticket, text: string, at: Date): WebhookEvent {
  const channel = ticket.channels.find(ref => ref.source === 'webhook')
  const conversation = channel?.address.conversation
  const root = channel?.address.event
  if (!conversation || !root) {
    throw new UserError('answerChannel', { channels: ticket.channels.map(ref => ref.source).join(', ') || 'none' })
  }
  // The same answer twice is the same event, so a retry cannot push a second Trigger at the ticket.
  const digest = createHash('sha1').update(text).digest('hex').slice(0, 12)
  return {
    id: `answer-${ticket.id.slice(0, 12)}-${digest}`,
    conversation,
    // The event that started the ticket, which keeps the answer on that ticket's own thread.
    thread: root,
    // The person who authorized the ticket answers it: their identity is already in its mandate, so no setting names it.
    sender: { id: ticket.mandate.actor.id, name: ticket.mandate.actor.id, bot: false },
    addressed: 'direct',
    text,
    at: at.toISOString(),
    meta: {},
  }
}

/** The Trigger a panel answer becomes; see `answerEvent` for the fields and their meaning. */
export function answerTrigger(ticket: Ticket, text: string, at = new Date()) {
  return webhookTrigger(answerEvent(ticket, text, at))
}
