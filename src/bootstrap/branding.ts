import process from 'node:process'
import type { NodelinkConfig } from '../typings/config/config.types.ts'
import {
  checkDependencyUpdates,
  getGitInfo,
  getVersion,
  logger
} from '../utils.ts'
import { UpdateStateStore } from './updater/state.ts'
import { UpdateManager } from './updater/updater.ts'

const SHUTDOWN_LOGO = `  \x1b[36m┳┓   ┓  ┓ •  ┓\x1b[0m
  \x1b[36m┃┃┏┓┏┫┏┓┃ ┓┏┓┃┏\x1b[0m
  \x1b[36m┛┗┗┛┗┻┗ ┗┛┗┛┗┛┗\x1b[0m`

const SUPPORT_GUIDELINES = `\x1b[35m
╭──────────────────────────────────────────────────────────────────────────────╮
│                            SUPPORT GUIDELINES                                │
│                                                                              │
│  1. Turn on debugging in config.ts before asking for help.                   │
│  2. Test the 'dev' branch (git checkout dev) to ensure it's not fixed yet.   │
│  3. If providing logs, start copying EXACTLY from this box onwards.          │
│  4. Cut logs or missing Node.js version will result in an ignored ticket.    │
│  5. FAQ and Rules: https://discord.gg/bVz6ppZ3SP                             │
│                    https://discord.gg/z4ayqfeBdB                             │
╰──────────────────────────────────────────────────────────────────────────────╯\x1b[0m
`

function printSupportGuidelines(): void {
  process.stdout.write(SUPPORT_GUIDELINES)
}

function printStartupBanner(version: string, isCluster: boolean): void {
  const modeLabel = isCluster ? 'Cluster Mode' : 'Single Process'
  const displayVersion = version.startsWith('v') ? version : `v${version}`

  const ascii = `
   ▄   ████▄ ██▄   ▄███▄   █    ▄█    ▄   █  █▀
    █  █   █ █  █  █▀   ▀  █    ██     █  █▄█
██   █ █   █ █   █ ██▄▄    █    ██ ██   █ █▀▄   ${modeLabel}
█ █  █ ▀████ █  █  █▄   ▄▀ ███▄ ▐█ █ █  █ █  █  ${displayVersion}
█  █ █       ███▀  ▀███▀       ▀ ▐ █  █ █   █   Powered by PerformanC;
█   ██                             █   ██  ▀    rewritten by 1Lucas1.apk;
                                                maintained by 1Lucas1.apk & ToddyTheNoobDud
`

  process.stdout.write(`\x1b[32m${ascii}\x1b[0m\n`)
}

interface PostUpdateBannerInfo {
  previousVersion?: string
  previousCommit?: string
  currentVersion: string
  currentCommit: string
}

function padAscii(line: string, width = 24): string {
  const trimmed = line.trimEnd()
  return trimmed + ' '.repeat(Math.max(1, width - trimmed.length))
}

function printPostUpdateBanner(info: PostUpdateBannerInfo): void {
  const prevVer = info.previousVersion
    ? info.previousVersion.startsWith('v')
      ? info.previousVersion
      : `v${info.previousVersion}`
    : 'unknown'
  const currVer = info.currentVersion.startsWith('v')
    ? info.currentVersion
    : `v${info.currentVersion}`
  const prevCommit = info.previousCommit?.slice(0, 7) ?? 'unknown'
  const currCommit = info.currentCommit?.slice(0, 7) ?? 'unknown'

  const art = [
    '  _           _',
    ' ___ /\\\\   _/\\\\___',
    '/  //\\ \\\\ (_   _ _))',
    '\\:.\\\\_\\ \\\\ /  |))\\\\',
    ' \\  :.  ///:. ___//',
    '(_   ___))\\_ \\\\',
    '  \\//       \\//'
  ]

  const rightLines = [
    '\x1b[1;34mUpdate Applied\x1b[0m \x1b[3m\x1b[90m(via space shooting star)\x1b[0m',
    `\x1b[34m➜\x1b[0m \x1b[37mBefore  :\x1b[0m \x1b[33m${prevVer}\x1b[0m \x1b[90m(${prevCommit})\x1b[0m`,
    `\x1b[34m➜\x1b[0m \x1b[37mAfter   :\x1b[0m \x1b[1;32m${currVer}\x1b[0m \x1b[90m(${currCommit})\x1b[0m`,
    '\x1b[34m•\x1b[0m \x1b[37mIssues  :\x1b[0m \x1b[36mhttps://github.com/PerformanC/NodeLink/issues\x1b[0m',
    '\x1b[34m•\x1b[0m \x1b[37mDiscord :\x1b[0m \x1b[36mhttps://discord.gg/bVz6ppZ3SP\x1b[0m',
    '            \x1b[36mhttps://discord.gg/z4ayqfeBdB\x1b[0m',
    ''
  ]

  let banner = '\n'
  for (let i = 0; i < art.length; i++) {
    banner += `  \x1b[36m${padAscii(art[i] || '')}\x1b[0m ${rightLines[i] || ''}\n`
  }
  banner += '\n'

  process.stdout.write(banner)
}

async function checkPostUpdateNotice(): Promise<void> {
  try {
    const store = new UpdateStateStore(process.cwd())
    const state = await store.read()
    const currentVersion = String(getVersion())
    const gitInfo = getGitInfo()
    const currentCommit =
      gitInfo.commit !== 'unknown'
        ? gitInfo.commit
        : (state?.commit ?? 'unknown')

    if (!state) {
      await store.recordBoot(currentVersion, currentCommit)
      return
    }

    const wasAutoUpdated = Boolean(state.justUpdated)
    const commitChanged = Boolean(
      state.commit &&
        state.commit !== 'unknown' &&
        currentCommit !== 'unknown' &&
        state.commit !== currentCommit
    )
    const pendingNotice = Boolean(
      state.previousCommit && state.lastAcknowledgedCommit !== state.commit
    )

    if (wasAutoUpdated || commitChanged || pendingNotice) {
      const prevVersion =
        state.previousVersion ?? (commitChanged ? state.version : undefined)
      const prevCommit =
        state.previousCommit ?? (commitChanged ? state.commit : undefined)

      printPostUpdateBanner({
        previousVersion: prevVersion,
        previousCommit: prevCommit,
        currentVersion,
        currentCommit
      })

      logger(
        'info',
        'Updater',
        `Server updated by space shooting star from ${prevVersion ?? 'previous'} (${prevCommit?.slice(0, 7) ?? 'unknown'}) to ${currentVersion} (${currentCommit.slice(0, 7)})`
      )

      await store.write({
        ...state,
        version: currentVersion,
        commit: currentCommit,
        justUpdated: false,
        lastAcknowledgedCommit: currentCommit,
        lastBootTimestamp: Date.now(),
        consecutiveCrashCount: 0
      })
    } else {
      await store.recordBoot(currentVersion, currentCommit)
    }
  } catch (error) {
    logger(
      'warn',
      'Branding',
      `Failed to check post-update status: ${error instanceof Error ? error.message : String(error)}`
    )
  }
}

const SHUTDOWN_MOTTOES = [
  '💚 Nascido no Brasil, moldado em código e feito para ir além.',
  '💚 Feito no Brasil, entre ideias, código e muita vontade de criar.',
  '💚 De uma ideia a muitas linhas de código — feito no Brasil.',
  '💚 Onde ideias encontram código. Feito no Brasil. 💚',
  '💚 Feito por quem acredita que código também pode ser uma forma de criar.',
  '💚 Um pouco de código, um pouco de caos e muita vontade de construir.',
  '💚 Criado no Brasil, escrito em código e levado adiante por ideias.',
  '💚 Da nossa ideia para o mundo. Feito no Brasil.'
]

function printShutdownMessage(): void {
  const motto =
    SHUTDOWN_MOTTOES[Math.floor(Math.random() * SHUTDOWN_MOTTOES.length)]

  const message = [
    '',
    SHUTDOWN_LOGO,
    '',
    `  \x1b[1;32m${motto}\x1b[0m`,
    '',
    '  \x1b[1m\x1b[33m⭐ Enjoying the project? Consider leaving a star on GitHub:\x1b[0m',
    '  \x1b[34m➜\x1b[0m \x1b[36mhttps://github.com/PerformanC/NodeLink\x1b[0m',
    '',
    '  \x1b[37mIssues or suggestions? Report or contribute:\x1b[0m',
    '  \x1b[34m•\x1b[0m \x1b[37mReport issues:\x1b[0m  \x1b[36mhttps://github.com/PerformanC/NodeLink/issues\x1b[0m',
    '  \x1b[34m•\x1b[0m \x1b[37mContribute:\x1b[0m     \x1b[36mhttps://github.com/PerformanC/contributing\x1b[0m',
    '  \x1b[34m•\x1b[0m \x1b[37mDiscord:\x1b[0m        \x1b[36mhttps://discord.gg/bVz6ppZ3SP\x1b[0m',
    '                    \x1b[36mhttps://discord.gg/z4ayqfeBdB\x1b[0m',
    '',
    '  \x1b[3m\x1b[90maut viam inveniam aut faciam\x1b[0m',
    '',
    ''
  ].join('\n')

  process.stdout.write(message)
}

async function checkUpdates(config?: NodelinkConfig): Promise<void> {
  try {
    const updater = new UpdateManager(process.cwd())
    const gitInfo = getGitInfo()
    const currentVersion = String(getVersion())
    const channel = config?.server?.autoUpdate?.channel ?? 'dev'

    const result = await updater.check(currentVersion, gitInfo.commit, channel)

    if (result.available && result.latest) {
      const isAutoUpdateEnabled = Boolean(config?.server?.autoUpdate?.enabled)

      if (isAutoUpdateEnabled) {
        logger(
          'info',
          'Updater',
          `Update available (${result.current.version} -> ${result.latest.version} @ ${result.latest.commit.slice(0, 7)}). Applying update...`
        )
        const success = await updater.applyUpdate(result.latest)
        if (success) {
          return
        }
      } else {
        logger(
          'warn',
          'Updater',
          `A new version of NodeLink is available: ${result.current.version} -> ${result.latest.version} (${result.latest.commit.slice(0, 7)})`
        )
        logger(
          'warn',
          'Updater',
          'To enable automatic updates, set server.autoUpdate.enabled: true in config.ts'
        )
      }
    } else if (result.reason) {
      logger('debug', 'Updater', `Update check: ${result.reason}`)
    } else {
      logger('info', 'Updater', 'NodeLink is up to date.')
    }
  } catch (error) {
    logger(
      'error',
      'Updater',
      `Server update check failed: ${error instanceof Error ? error.message : String(error)}`
    )
  }

  try {
    await checkDependencyUpdates()
  } catch (e) {
    logger(
      'error',
      'Server',
      `Dependency check failed: ${(e as Error).message}`
    )
  }
}

export {
  checkPostUpdateNotice,
  checkUpdates,
  printPostUpdateBanner,
  printShutdownMessage,
  printStartupBanner,
  printSupportGuidelines
}
