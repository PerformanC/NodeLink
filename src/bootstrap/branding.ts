import process from 'node:process'

import { checkDependencyUpdates, checkForUpdates, logger } from '../utils.ts'

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

function printShutdownMessage(): void {
  const message = [
    '',
    SHUTDOWN_LOGO,
    '',
    '  \x1b[32m💚 Feito com carinho por Brasileiros para todos os usuários do NodeLink!\x1b[0m',
    '',
    '  \x1b[1m\x1b[33m⭐ Enjoying the project? Consider leaving a star on GitHub:\x1b[0m',
    '  \x1b[34m➜\x1b[0m \x1b[36mhttps://github.com/PerformanC/NodeLink\x1b[0m',
    '',
    '  \x1b[37mIssues or suggestions? Report or contribute:\x1b[0m',
    '  \x1b[34m•\x1b[0m \x1b[37mReport issues:\x1b[0m  \x1b[36mhttps://github.com/PerformanC/NodeLink/issues\x1b[0m',
    '  \x1b[34m•\x1b[0m \x1b[37mContribute:\x1b[0m     \x1b[36mhttps://github.com/PerformanC/contributing\x1b[0m',
    '  \x1b[34m•\x1b[0m \x1b[37mDiscord:\x1b[0m        \x1b[36mhttps://discord.gg/fzjksWS65v\x1b[0m',
    '',
    ''
  ].join('\n')

  process.stdout.write(message)
}

async function checkUpdates(): Promise<void> {
  try {
    await checkForUpdates()
  } catch (e) {
    logger('error', 'Git', `Update check failed: ${(e as Error).message}`)
  }

  try {
    await checkDependencyUpdates()
  } catch (e) {
    logger('error', 'Git', `Dependency check failed: ${(e as Error).message}`)
  }
}

export {
  checkUpdates,
  printShutdownMessage,
  printStartupBanner,
  printSupportGuidelines
}
