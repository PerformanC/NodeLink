export type UpdateChannel = 'dev' | 'stable'

export type UpdateProviderType = 'git' | 'http' | 'docker'

export interface UpdateManifest {
  readonly channel: UpdateChannel
  readonly version: string
  readonly commit: string
  readonly url: string
  readonly sha256?: string
  readonly size?: number
  readonly releaseDate?: string
}

export interface QuarantinedCommit {
  readonly failedAt: string
  readonly reason: string
  readonly attempts: number
}

export interface UpdateState {
  readonly version: string
  readonly commit: string
  readonly channel: UpdateChannel
  readonly updatedAt: string
  readonly previousVersion?: string
  readonly previousCommit?: string
  readonly quarantinedCommits?: Record<string, QuarantinedCommit>
  readonly consecutiveCrashCount?: number
  readonly lastBootTimestamp?: number
  readonly justUpdated?: boolean
  readonly lastAcknowledgedCommit?: string
}

export interface UpdateCheckResult {
  readonly available: boolean
  readonly current: UpdateState
  readonly latest?: UpdateManifest
  readonly provider: UpdateProviderType
  readonly reason?: string
}

export interface UpdateDownloadResult {
  readonly path: string
  readonly sha256: string
  readonly size: number
}

export interface WorkerOptions {
  readonly root: string
  readonly targetCommit: string
  readonly targetVersion: string
  readonly channel: UpdateChannel
  readonly parentPid: number
  readonly stagingPath: string
  readonly backupPath: string
}

export interface ExtractResult {
  readonly stagingDir: string
  readonly hasPackageJson: boolean
  readonly hasSourceEntry: boolean
}

export interface UpdateProvider {
  readonly type: UpdateProviderType

  isAvailable(): Promise<boolean>

  getLatest(channel: UpdateChannel): Promise<UpdateManifest | null>

  download(
    manifest: UpdateManifest,
    destination: string
  ): Promise<UpdateDownloadResult>
}
