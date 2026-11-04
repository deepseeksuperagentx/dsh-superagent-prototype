#!/usr/bin/env node
/**
 * Emit one event to the webhook Source's inbox, the way any sender must write it: to a temporary file in the inbox
 * itself, then renamed into `pending/` so the Source never reads a half-written event. It doubles as the smoke test of
 * the Source, being the only program here that speaks the sender's side of the contract.
 *
 *   scripts/superagent-event.mjs --inbox /path/to/inbox --conversation ops --text 'Nightly check found 3 broken pages'
 *
 * The Source moves each event it reads to `<inbox>/seen/`, or to `<inbox>/bad/` when it cannot read it, so a sender can
 * tell an event that was taken in from one that was rejected without asking the engine.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'

const usage = `Usage: superagent-event.mjs --inbox <absolute directory> --conversation <id> --text <event>
  [--stdin to read the event instead of --text] [--id <event id>] [--thread <event this one answers>] [--at <timestamp>]
  [--sender <id>] [--name <display name>] [--human] [--addressed mention|direct]
  [--url <link to the event>] [--callback <URL replies POST to>] [--meta key=value ...]`
const fail = (message) => { console.error(`${message}\n${usage}`); process.exit(1) }

const argv = process.argv.slice(2)
/** The option's next word, or undefined when the option is absent; the fields are those `EventSchema` accepts. */
const value = (name) => { const at = argv.indexOf(name); return at < 0 ? undefined : argv.at(at + 1) }
const inbox = value('--inbox')
const conversation = value('--conversation')
const text = argv.includes('--stdin') ? readFileSync(0, 'utf8').trim() : value('--text')
const sender = value('--sender')
if (!inbox?.startsWith('/')) fail('Missing --inbox: an absolute directory')
if (!conversation) fail('Missing --conversation')
if (!text) fail('Missing --text (or --stdin to read the event from standard input)')
/** Each `--meta key=value` becomes one entry of `event.meta`, which the Source keeps apart from its own fields. */
const pairs = argv.flatMap((arg, at) => arg === '--meta' ? [argv.at(at + 1) ?? ''] : []).filter(pair => pair.includes('='))
const event = {
  id: value('--id') ?? randomUUID(), conversation, text,
  at: value('--at') ?? new Date().toISOString(),
  ...(value('--thread') ? { thread: value('--thread') } : {}),
  ...(sender ? { sender: { id: sender, bot: !argv.includes('--human'), ...(value('--name') ? { name: value('--name') } : {}) } } : {}),
  ...(value('--addressed') ? { addressed: value('--addressed') } : {}),
  ...(value('--url') ? { url: value('--url') } : {}),
  ...(value('--callback') ? { callback: value('--callback') } : {}),
  ...(pairs.length ? { meta: Object.fromEntries(pairs.map(pair => [pair.slice(0, pair.indexOf('=')), pair.slice(pair.indexOf('=') + 1)])) } : {}),
}
mkdirSync(join(inbox, 'pending'), { recursive: true })
const file = join(inbox, 'pending', `${event.id}.json`)
if (existsSync(file)) fail(`The event ${event.id} is already in the inbox`)
// A rename is atomic within a directory, so the Source sees either nothing or the whole event.
writeFileSync(`${file}.part`, `${JSON.stringify(event, undefined, 2)}\n`)
renameSync(`${file}.part`, file)
console.log(file)
