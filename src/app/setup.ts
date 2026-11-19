/** Probes repository and account CLIs, configures the worker execution environment and command shims, and tracks setup readiness. */
import type { Context } from '@deepseek-ai/cordis'
import { UserError } from '../core/index.ts'
import { SETUP_FIELDS, resolveDeployment, resolveFeishuBot, workerProbe, type Deployment, type Machine } from '../deployment.ts'
import { agentVariables, applyEnvironment, verifyEnvironment, withoutDirectory, workerBin, writeEnvironment } from '../infra/environment.ts'
import type { Settings, SettingsBlock } from '../policy.ts'
import { SetupError, type SetupProblem } from '../setup.ts'

export interface SetupHost {
  readonly context: Context
  readonly machine: Machine
  readonly lifetime: AbortSignal
  restart(): void
}

type StoredSource = Settings['sources'][string]
/** The Source kind an instance is configured as: the stored `kind`, or the instance ID itself for a kind's default instance. */
const kindOf = (id: string, source: StoredSource): string => source.kind ?? id
/** The enabled instances of `kind`, with their IDs and stored configurations, in settings order. */
const instancesOf = (settings: Settings, kind: string): { id: string; config: Record<string, unknown> }[] =>
  Object.entries(settings.sources).flatMap(([id, source]) => kindOf(id, source) === kind && source.enabled ? [{ id, config: source.config }] : [])
/** Setup-read configuration of every instance of the kinds setup reads, by kind and instance ID: changing any re-runs setup. */
const setupFields = (settings: Settings) => JSON.stringify(Object.keys(SETUP_FIELDS).flatMap(kind => {
  const fields = SETUP_FIELDS[kind]!
  const instances = Object.entries(settings.sources).filter(([id, source]) => kindOf(id, source) === kind)
  // A kind with no stored instance reads its default instance's defaults, so enabling one changes nothing by itself.
  if (!instances.length) return [[kind, kind, fields.map(() => '')]]
  return instances.map(([id, source]) => [kind, id, fields.map(key => source.config[key] ?? '')])
}))
export const setupChanged = (before: Settings, after: Settings): boolean => setupFields(before) !== setupFields(after)

/**
 * Resolves the target repository, GitHub account, and optional Feishu bot by probing CLIs, then writes and applies the isolated git and shim environment used by worker processes.
 * `Runtime` runs it at startup to gate orchestration readiness, while `Settings` uses it to validate account changes, update blocked command shims, and schedule restarts.
 */
export class Setup {
  private resolved?: Deployment
  problem?: SetupProblem
  feishuProblem?: SetupProblem
  /** PATH with the worker shim directory removed so the host's own CLI calls invoke the real binaries. */
  private readonly path: string
  /** Environment variables pointing agent subprocesses at the isolated git config and command shims. */
  private readonly variables: Record<string, string | undefined>
  private restoreEnvironment?: () => void
  constructor(private readonly host: SetupHost) {
    this.path = withoutDirectory(process.env.PATH ?? '', workerBin(host.machine.stateDir))
    this.variables = agentVariables(host.machine.stateDir)
  }
  /** Host command environment with agent git variables applied and the worker shim directory excluded from PATH. */
  get commandEnvironment(): Record<string, string | undefined> { return { ...this.variables, PATH: this.path } }
  get deployment(): Deployment {
    if (!this.resolved) throw new Error(`dsh-superagent is waiting for setup: ${this.problem?.detail ?? 'setup has not run'}`)
    return this.resolved
  }
  configured(): boolean { return this.resolved !== undefined }
  /** Resolve deployment accounts and apply the worker environment, recording `SetupError` failures in `problem`/`feishuProblem` and rethrowing unexpected errors. */
  async run(settings: Settings): Promise<boolean> {
    try { this.resolved = await this.resolve(settings); return true }
    catch (error) {
      if (!(error instanceof SetupError)) throw error
      this.problem = error.problem
      return false
    }
  }
  /** Trigger a restart to re-run setup, refusing if setup and Feishu are already healthy so running assignments are not interrupted. */
  check(): void {
    if (this.configured() && !this.feishuProblem) throw new UserError('setupComplete')
    this.restart()
  }
  /** Defer the restart to the next macrotask so the current HTTP or tool caller receives its response first. */
  restart(): void { setTimeout(this.host.restart, 0) }
  /**
   * Verifies the account CLIs a modified source block needs before saving, ignoring setup errors belonging to other blocks:
   * every enabled GitHub instance must resolve the agent account and its own repository's push access (CONTRACT §六), and the
   * first failure names that instance and repository so the operator fixes the card it belongs to.
   */
  async checkAccounts(block: SettingsBlock, settings: Settings): Promise<void> {
    const { machine } = this.host
    const probe = this.probe()
    if (block === 'source:feishu') {
      await resolveFeishuBot(machine, settings.sources.feishu?.config, probe)
        .catch((error: unknown) => { if (!(error instanceof SetupError) || error.place === 'feishu') throw error })
      return
    }
    for (const { id, config } of instancesOf(settings, 'github')) {
      await resolveDeployment(machine, config, probe).catch((error: unknown) => {
        if (!(error instanceof SetupError)) throw error
        // A kind's default instance keeps the setup message it has always had; only an added instance names itself.
        throw new SetupError(error.code, error.values, id === 'github' ? undefined : id)
      })
    }
  }
  async blockCommands(blocked: readonly string[]): Promise<void> {
    if (this.resolved) await writeEnvironment(this.resolved, blocked)
  }
  restore(): void { this.restoreEnvironment?.(); this.restoreEnvironment = undefined }
  /** Probes CLIs the way worker shells run them, using `stateDir` as `cwd` since it exists even before the repository clone is valid. */
  private probe() {
    const { context, machine, lifetime } = this.host
    return workerProbe(context.subprocess, machine.stateDir, machine.stateDir, lifetime)
  }
  private async resolve(settings: Settings): Promise<Deployment> {
    const { context, machine, lifetime } = this.host
    const probe = this.probe()
    const deployment = await resolveDeployment(machine, settings.sources.github?.config, probe)
    const feishu = await resolveFeishuBot(machine, settings.sources.feishu?.config, probe).catch((error: unknown) => {
      if (!(error instanceof SetupError)) throw error
      this.feishuProblem = error.problem
      context.logger.warn('dsh-superagent leaves Feishu out: %s', error.message)
      return undefined
    })
    const resolved = { ...deployment, ...(feishu ? { feishu } : {}) }
    const machineProblem = (error: unknown): never => {
      if (error instanceof SetupError) throw error
      throw new SetupError('environmentFailed', { output: error instanceof Error ? error.message : String(error) })
    }
    await writeEnvironment(resolved, settings.executor.blockedCommands).catch(machineProblem)
    this.restoreEnvironment = applyEnvironment(this.variables, machine.stateDir, this.path)
    await verifyEnvironment(resolved, context.subprocess, lifetime).catch((error: unknown) => {
      this.restore()
      machineProblem(error)
    })
    return resolved
  }
}
