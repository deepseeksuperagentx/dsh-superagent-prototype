import { beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import type { Trigger } from '../src/core/index.ts'
import { SettingsSchema, type Settings } from '../src/policy.ts'
import type { SourceKind } from '../src/sources/kind.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import { declaredVariables, environmentOf } from '../src/app/execution-environment.ts'
import { testDeployment } from './fixtures/deployment.ts'

/** Instances whose values were computed, so the tests can tell which instances a kind actually saw. */
let asked: string[] = []
beforeEach(() => { asked = [] })

/** A GitHub-shaped kind whose single value comes from the instance's own configuration. */
const github: SourceKind<{ repository: string }> = {
  kind: 'github', title: { zh: 'GitHub', en: 'GitHub' }, description: { zh: '', en: '' }, health: ['github'],
  schema: z.object({ repository: z.string().default('') }).strict(),
  fields: [{ key: 'repository', type: 'text', label: { zh: '仓库', en: 'Repository' } }],
  environment: {
    variables: [{ key: 'DSH_SUPERAGENT_GITHUB_REPOSITORY', description: { zh: '仓库', en: 'Repository' } }],
    values: input => {
      // The instance ID is passed along, as the GitHub kind counts and looks up its repository by instance.
      asked.push(input.instance ?? '')
      return { DSH_SUPERAGENT_GITHUB_REPOSITORY: input.config.repository }
    },
  },
}
/** A second kind, mounted once, whose values must stay available beside the Trigger's own kind (as with one instance per kind). */
const feishu: SourceKind<Record<string, never>> = {
  kind: 'feishu', title: { zh: '飞书', en: 'Feishu' }, description: { zh: '', en: '' }, health: ['feishu'],
  schema: z.object({}).strict(), fields: [],
  environment: {
    variables: [{ key: 'DSH_SUPERAGENT_FEISHU_CHAT', description: { zh: '群', en: 'Chat' } }],
    values: () => ({ DSH_SUPERAGENT_FEISHU_CHAT: '' }),
  },
}
const settings = (sitesEnabled = true) => SettingsSchema.parse({ sources: {
  feishu: { config: {} },
  github: { config: { repository: 'acme/lab' } },
  'github-sites': { kind: 'github', enabled: sitesEnabled, config: { repository: 'acme/sites' } },
} })
const registry = (settingsValue: Settings): SourceRegistry => {
  const sources = new SourceRegistry(() => settingsValue)
  sources.register(github)
  sources.register(feishu)
  sources.attach('github-sites', 'github')
  return sources
}
const trigger = (source: string): Trigger => ({ id: `t-${source}`, source, threads: [{ source, id: '7' }],
  actor: { source, id: 'alice' }, human: true, at: '', text: '', meta: {} })
const valuesOf = (variables: readonly { key: string; value: string }[], key: string): string[] =>
  variables.filter(variable => variable.key === key).map(variable => variable.value)
const names = (variables: readonly { key: string }[]): string[] => variables.map(variable => variable.key)

describe('execution environment of one kind mounted twice', () => {
  it('takes the values of the instance the Trigger came from, not of the kind\'s default instance', () => {
    const values = settings()
    const environment = environmentOf({ deployment: testDeployment(), sources: registry(values), settings: values,
      ticket: { id: 't1', name: 'fix', directory: '/tmp/dsh-superagent-test/work/fix' }, trigger: trigger('github-sites') })
    expect(valuesOf(environment, 'DSH_SUPERAGENT_GITHUB_REPOSITORY')).toEqual(['acme/sites'])
    // The default instance of the same kind contributes nothing, so its repository cannot overwrite the Trigger's one.
    expect(valuesOf(environment, 'DSH_SUPERAGENT_GITHUB_REPOSITORY')).not.toContain('acme/lab')
    expect(environment.warnings).toEqual([])
    // The Trigger's own instance ID reached the kind, so it can resolve its repository and issue number.
    expect(asked).toEqual(['github-sites'])
  })
  it('keeps the instances of the other kinds, so one instance per kind behaves as before', () => {
    const values = settings()
    const environment = environmentOf({ deployment: testDeployment(), sources: registry(values), settings: values,
      ticket: { id: 't1', name: 'fix', directory: '/tmp/dsh-superagent-test/work/fix' }, trigger: trigger('feishu') })
    // A Feishu ticket still learns the repository of the enabled GitHub instance, and the other GitHub instance stays out.
    expect(valuesOf(environment, 'DSH_SUPERAGENT_GITHUB_REPOSITORY')).toEqual(['acme/lab'])
    expect(names(environment)).toContain('DSH_SUPERAGENT_FEISHU_CHAT')
  })
  it('injects every enabled instance without a Trigger, keeps the first value and warns instead of overwriting it', () => {
    const values = settings()
    const environment = environmentOf({ deployment: testDeployment(), sources: registry(values), settings: values })
    // The default instance is listed before the attached one, so its repository survives and the other is reported.
    expect(valuesOf(environment, 'DSH_SUPERAGENT_GITHUB_REPOSITORY')).toEqual(['acme/lab'])
    expect(environment.warnings).toHaveLength(1)
    expect(environment.warnings[0]).toContain('github-sites')
    expect(environment.warnings[0]).toContain('DSH_SUPERAGENT_GITHUB_REPOSITORY')
    // Both enabled instances of the kind were asked, in instance-ID order.
    expect(asked).toEqual(['github', 'github-sites'])
  })
  it('declares each instance separately and marks a switched-off instance as disabled', () => {
    const values = settings(false)
    expect(declaredVariables(registry(values), values).map(group => [group.owner, group.enabled]))
      .toEqual([['executor', true], ['feishu', true], ['github', true], ['github-sites', false]])
    const on = settings()
    expect(declaredVariables(registry(on), on).map(group => [group.owner, group.enabled]))
      .toEqual([['executor', true], ['feishu', true], ['github', true], ['github-sites', true]])
  })
})
