import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { SETUP_FIELDS } from '../src/deployment.ts'
import { SettingsSchema } from '../src/policy.ts'
import type { Health } from '../src/sources/host.ts'
import type { Localized, SourceKind } from '../src/sources/kind.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import type { Store } from '../src/app/store.ts'
import { sourceHealth } from '../src/app/views/sources.ts'
import { settingsView } from '../src/app/views/settings.ts'
import { testDeployment } from './fixtures/deployment.ts'

/** A GitHub-shaped kind: `facts(deployment)` describes the shared account, while repository and CLI come from each instance. */
const github: SourceKind<{ repository: string; cli: string }> = {
  kind: 'github', title: { zh: 'GitHub', en: 'GitHub' }, description: { zh: '仓库来源', en: 'Repository Source' },
  schema: z.object({ repository: z.string().default(''), cli: z.string().default('') }).strict(),
  fields: [{ key: 'repository', type: 'text', label: { zh: '仓库', en: 'Repository' } },
    { key: 'cli', type: 'text', label: { zh: 'CLI', en: 'CLI' } }],
  health: ['github'],
  facts: (deployment): Record<string, Localized | string> => deployment ? { cli: `Current account @${deployment.github.login}` } : {},
  environment: {
    variables: [{ key: 'DSH_SUPERAGENT_GITHUB_REPOSITORY', description: { zh: '仓库', en: 'Repository' } }],
    values: ({ config }) => ({ DSH_SUPERAGENT_GITHUB_REPOSITORY: config.repository }),
  },
}
const settings = (sitesEnabled = true) => SettingsSchema.parse({ sources: {
  github: { config: { repository: 'acme/lab', cli: '/bin/gh' } },
  'github-sites': { kind: 'github', enabled: sitesEnabled, config: { repository: 'acme/sites', cli: '/bin/gh' } },
} })
const revisions: Record<string, number> = { 'source:github': 3, 'source:github-sites': 7 }
const store = (value: ReturnType<typeof settings>, revision = revisions): Store => ({ settings: () => value,
  blockRevision: (block: string) => revision[block] ?? 0, get: () => undefined }) as unknown as Store
const health: Record<string, Health> = { github: { state: 'ready', detail: 'watching lab' },
  'github-sites': { state: 'ready', detail: 'watching sites' } }
function mount(value = settings()) {
  const sources = new SourceRegistry(() => value)
  sources.register(github)
  sources.attach('github-sites', 'github')
  return sources
}
function view(value = settings(), healthValue = health, revision = revisions) {
  const sources = mount(value)
  const shown = settingsView(store(value, revision), sources, healthValue, { deployment: testDeployment() },
    '/tmp/dsh-superagent-test')
  return { sources, cards: shown.sources, environment: shown.environment.variables }
}

describe('settings view of two Source instances of one kind', () => {
  it('renders two independent cards, each with its own config, revision, facts and title', () => {
    const { cards } = view()
    expect(cards.map(card => [card.id, card.value.config.repository, card.revision, card.value.enabled]))
      .toEqual([['github', 'acme/lab', 3, true], ['github-sites', 'acme/sites', 7, true]])
    // The default instance keeps the kind's title; a second instance names itself after its ID.
    expect(cards.map(card => card.title)).toEqual([{ zh: 'GitHub', en: 'GitHub' },
      { zh: 'GitHub · github-sites', en: 'GitHub · github-sites' }])
    // Facts describe the shared account plus the repository each card's own instance watches: the default instance reports the
    // deployment's canonical repository, while the second instance reports its own configuration.
    expect(cards.map(card => [card.facts.cli, card.facts.repository]))
      .toEqual([['Current account @agent-bot', 'acme/widgets'], ['Current account @agent-bot', 'acme/sites']])
  })
  it('looks each card\'s restart-sensitive fields up by kind name, and declares one environment group per instance', () => {
    const { cards } = view()
    // `SETUP_FIELDS` is keyed by kind, so both instances of `github` restart on the same account/repository fields.
    expect(cards.map(card => card.restarts)).toEqual([SETUP_FIELDS.github, SETUP_FIELDS.github])
    expect(cards[1]!.restarts).toContain('repository')
    // The execution environment lists one group per mounted instance, each switchable on its own.
    expect(view().environment.map(group => [group.owner, group.enabled]))
      .toEqual([['executor', true], ['github', true], ['github-sites', true]])
    // Switching one instance off disables only its own declared variables.
    const off = view(settings(false))
    expect(off.cards[1]!.value.enabled).toBe(false)
    expect(off.cards[1]!.restarts).toEqual(SETUP_FIELDS.github)
    expect(off.environment.map(group => [group.owner, group.enabled]))
      .toEqual([['executor', true], ['github', true], ['github-sites', false]])
  })
  it('reads health per instance ID: the attached instance has its own entry, not the kind\'s default one', () => {
    const { cards, sources } = view()
    expect(cards.map(card => card.id)).toEqual(['github', 'github-sites'])
    const parts = sources.instances().map(instance => sourceHealth(sources, instance, health))
    expect(parts.map(part => part.id)).toEqual(['github', 'github-sites'])
    expect(parts.map(part => part.health.map(entry => entry.name))).toEqual([['github'], ['github-sites']])
    expect(parts[1]!.health[0]).toMatchObject({ state: 'ready', detail: 'watching sites' })
  })
  it('does not give a stored instance whose kind is not mounted another instance\'s health or config', () => {
    const stored = SettingsSchema.parse({ sources: {
      github: { config: { repository: 'acme/lab', cli: '/bin/gh' } },
      legacy: { kind: 'github', config: { repository: 'acme/old', cli: '/bin/gh' } },
    } })
    const { cards, sources } = view(stored, { github: { state: 'ready', detail: 'watching lab' } })
    const legacy = cards.find(card => card.id === 'legacy')!
    expect(legacy.installed).toBe(false)
    expect(legacy.title).toEqual({ zh: 'GitHub · legacy', en: 'GitHub · legacy' })
    expect(legacy.value.config.repository).toBe('acme/old')
    expect(legacy.facts.repository).toBe('acme/old')
    // It claims no health entry: the mounted default instance owns the kind's `github` entry.
    const legacyHealth = sourceHealth(sources, sources.instances().find(instance => instance.id === 'legacy')!, {})
    expect(legacyHealth.health).toEqual([])
    expect(sourceHealth(sources, sources.instances().find(instance => instance.id === 'github')!, health)
      .health.map(entry => entry.name)).toEqual(['github'])
  })
})
