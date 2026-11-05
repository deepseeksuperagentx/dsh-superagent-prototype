import { expect, it } from 'vitest'
import { answerEvent, answerTrigger } from '../src/app/answers.ts'
import { UserError, type Ticket } from '../src/core/index.ts'

/** A Ticket shaped after what the store holds; only the mandate actor and the first channel matter to the answer. */
const ticket = (source: string, address: Record<string, string>): Ticket => ({
  id: 'abcdef1234567890abcdef1234567890',
  title: 'T',
  decisionId: 'decision',
  mandate: { strength: 'explicit', policyVersion: 'p', basis: {}, actor: { source, id: 'someonehereany' }, scope: 's' },
  channels: [{ source, thread: 'thread', address }],
  assignments: [], inputs: [], undelivered: [],
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
} as unknown as Ticket)

it('answers on the ticket\'s own conversation as the person who authorized it', () => {
  const trigger = answerTrigger(ticket('webhook', { conversation: 'ops', event: 'root-event' }), '同意', new Date('2026-02-02T03:04:05.000Z'))
  expect(trigger.source).toBe('webhook')
  expect(trigger.threads).toEqual([{ source: 'webhook', id: 'ops:root-event' }])
  expect(trigger.channel?.thread).toBe('webhook:ops:root-event')
  expect(trigger.human).toBe(true)
  expect(trigger.addressed).toBe('direct')
  expect(trigger.actor).toEqual({ source: 'webhook', id: 'someonehereany' })
  expect(trigger.text).toBe('同意')
  expect(trigger.at).toBe('2026-02-02T03:04:05.000Z')
  // The Trigger id is the Source's key of conversation and event, so two senders may reuse one event id.
  expect(trigger.id).toMatch(/^[0-9a-f]{32}$/)
})

it('keeps the same event id for the same answer, so a retry cannot push a second Trigger', () => {
  const early = answerEvent(ticket('webhook', { conversation: 'ops', event: 'root-event' }), '同意', new Date(0))
  const late = answerEvent(ticket('webhook', { conversation: 'ops', event: 'root-event' }), '同意', new Date(9_999_999))
  expect(early.id).toBe(late.id)
  expect(early.at).not.toBe(late.at)
  expect(early.id.startsWith('answer-abcdef123456-')).toBe(true)
})

it('refuses a Ticket that did not start on the Webhook Source, naming the channel that can answer it', () => {
  expect(() => answerEvent(ticket('github', { number: '7' }), '同意', new Date(0))).toThrowError(UserError)
  expect(() => answerEvent(ticket('github', { number: '7' }), '同意', new Date(0))).toThrowError(/github/)
})

it('leaves the thread at the origin event even when the conversation names one', () => {
  const withThread = answerEvent(ticket('webhook', { conversation: 'ops', event: 'e-1' }), '补充一句', new Date(0))
  expect(withThread.thread).toBe('e-1')
  expect(withThread.conversation).toBe('ops')
  expect(withThread.meta).toEqual({})
})
