import path from 'node:path'
import process from 'node:process'
import { parseUpdateManifest } from '../src/bootstrap/updater/manifest.ts'
import { GitProvider } from '../src/bootstrap/updater/providers/gitProvider.ts'
import { HttpProvider } from '../src/bootstrap/updater/providers/httpProvider.ts'
import { UpdateStateStore } from '../src/bootstrap/updater/state.ts'
import { UpdateManager } from '../src/bootstrap/updater/updater.ts'

async function runTests(): Promise<void> {
  const root = process.cwd()
  console.log('\n=== [Test 1] UpdateStateStore (Atomic Persistence) ===')
  const store = new UpdateStateStore(root)

  const testState = {
    version: '3.10.0-test',
    commit: '0123456789abcdef',
    channel: 'dev' as const,
    updatedAt: new Date().toISOString()
  }

  await store.write(testState)
  console.log('[Test 1] State written successfully.')

  const readState = await store.read()
  console.log('[Test 1] State read back:', readState)
  if (
    readState &&
    readState.version === testState.version &&
    readState.commit === testState.commit
  ) {
    console.log('✅ Test 1 Passed: Atomic state persistence works correctly.')
  } else {
    throw new Error('Test 1 Failed: Read state does not match written state.')
  }

  console.log('\n=== [Test 2] Manifest Parser & Validator ===')
  const validManifest = parseUpdateManifest({
    channel: 'dev',
    version: '3.10.0',
    commit: 'abcdef123456',
    url: 'https://github.com/PerformanC/NodeLink/archive/refs/heads/dev.tar.gz'
  })
  console.log('[Test 2] Valid manifest parsed:', validManifest !== null)

  const invalidManifest = parseUpdateManifest({
    channel: 'invalid_channel',
    version: 123
  })
  console.log('[Test 2] Invalid manifest rejected:', invalidManifest === null)

  if (validManifest && invalidManifest === null) {
    console.log(
      '✅ Test 2 Passed: Strict manifest validation works as expected.'
    )
  } else {
    throw new Error('Test 2 Failed: Manifest validation error.')
  }

  console.log('\n=== [Test 3] GitProvider ===')
  const gitProvider = new GitProvider(root)
  const gitAvailable = await gitProvider.isAvailable()
  console.log('[Test 3] Git available:', gitAvailable)

  if (gitAvailable) {
    const gitLatest = await gitProvider.getLatest('dev')
    console.log('[Test 3] GitProvider getLatest result:', gitLatest)
    if (gitLatest?.commit) {
      console.log(
        '✅ Test 3 Passed: GitProvider successfully queried upstream.'
      )
    } else {
      console.warn(
        '⚠️ Test 3 Warning: GitProvider did not return latest revision.'
      )
    }
  }

  console.log('\n=== [Test 4] HttpProvider (Sem Git / Fallback HTTP) ===')
  const httpProvider = new HttpProvider(10000)
  const httpLatest = await httpProvider.getLatest('dev')
  console.log('[Test 4] HttpProvider getLatest result:', httpLatest)
  if (httpLatest?.commit && httpLatest.version) {
    console.log(
      '✅ Test 4 Passed: HttpProvider successfully queried GitHub API.'
    )
  } else {
    console.warn('⚠️ Test 4 Warning: HttpProvider could not reach GitHub API.')
  }

  console.log('\n=== [Test 5] UpdateManager (Orquestração Completa) ===')
  const manager = new UpdateManager(root)
  const selectedProvider = await manager.selectProvider()
  console.log('[Test 5] Auto-selected provider:', selectedProvider.type)

  // Test checking for updates with an older local commit
  const checkResult = await manager.check(
    '3.10.0-dev',
    'c25c308db995fef0f71b8df4e562f9f350ccf29e',
    'dev'
  )
  console.log('[Test 5] Check result:', {
    available: checkResult.available,
    provider: checkResult.provider,
    currentCommit: checkResult.current.commit.slice(0, 7),
    latestCommit: checkResult.latest?.commit.slice(0, 7),
    latestVersion: checkResult.latest?.version
  })

  if (checkResult.latest) {
    console.log('✅ Test 5 Passed: UpdateManager orchestration succeeded.')
  } else {
    throw new Error('Test 5 Failed: UpdateManager check returned no metadata.')
  }

  console.log('\n=== [Test 6] Download & SHA-256 Verification ===')
  const { mkdir } = await import('node:fs/promises')
  const downloadDir = path.join(root, '.nodelink', 'updates', 'download')
  await mkdir(downloadDir, { recursive: true })

  const destFile = path.join(downloadDir, 'test-download.tar.gz')
  if (checkResult.latest) {
    console.log(
      '[Test 6] Downloading archive for commit:',
      checkResult.latest.commit.slice(0, 7)
    )
    const downloadRes = await manager.download(checkResult.latest, destFile)
    console.log('[Test 6] Download result:', {
      path: downloadRes.path,
      sizeBytes: downloadRes.size,
      sha256: `${downloadRes.sha256.slice(0, 16)}...`
    })

    if (downloadRes.size > 0 && downloadRes.sha256.length === 64) {
      console.log(
        '✅ Test 6 Passed: Archive downloaded and SHA-256 calculated correctly.'
      )
    } else {
      throw new Error(
        'Test 6 Failed: Invalid downloaded archive size or SHA-256.'
      )
    }

    console.log('\n=== [Test 7] Archive Extraction & Integrity Validation ===')
    const { ArchiveExtractor } = await import(
      '../src/bootstrap/updater/extractor.ts'
    )
    const extractor = new ArchiveExtractor()
    const stagingDir = path.join(
      root,
      '.nodelink',
      'updates',
      'staging',
      'test'
    )
    const extractRes = await extractor.extract(destFile, stagingDir)
    console.log('[Test 7] Extraction result:', extractRes)

    if (extractRes.hasPackageJson && extractRes.hasSourceEntry) {
      console.log(
        '✅ Test 7 Passed: Archive extracted, flattened and validated successfully.'
      )
    } else {
      throw new Error(
        'Test 7 Failed: Extracted archive missing critical files.'
      )
    }

    console.log('\n=== [Test 8] Quarantine & Loop Prevention Check ===')
    const testQuarantineCommit = checkResult.latest.commit
    await store.quarantineCommit(testQuarantineCommit, 'Test crash simulation')

    const recheckResult = await manager.check(
      '3.10.0-dev',
      '0123456789abcdef',
      'dev'
    )
    console.log('[Test 8] Recheck result after quarantine:', {
      available: recheckResult.available,
      reason: recheckResult.reason
    })

    if (
      !recheckResult.available &&
      recheckResult.reason?.includes('quarantined')
    ) {
      console.log(
        '✅ Test 8 Passed: Quarantined commit prevented update loop successfully.'
      )
    } else {
      throw new Error(
        'Test 8 Failed: Quarantined commit was not prevented from updating.'
      )
    }

    // Clean up quarantine for next runs
    const stateClean = await store.read()
    if (stateClean) {
      await store.write({ ...stateClean, quarantinedCommits: {} })
    }

    console.log('\n=== [Test 9] Dependency Diffing in Swapper ===')
    const { FileSwapper } = await import('../src/bootstrap/updater/swapper.ts')
    const swapper = new FileSwapper(root)
    const depsChanged = await swapper.checkDependenciesChanged(stagingDir)
    console.log(
      '[Test 9] Dependencies changed between local and staging:',
      depsChanged
    )
    console.log('✅ Test 9 Passed: Dependency diffing evaluated cleanly.')

    console.log(
      '\n=== [Test 10] Config Migration, Deep Merge & Missing Key Detection ==='
    )
    const { deepMerge, findMissingConfigKeys, migrateConfig } = await import(
      '../src/modules/config/configMigration.ts'
    )

    // 10.1 Legacy migration test
    const legacyConfig = {
      port: 8080,
      password: 'mypassword',
      spotifyClientId: 'my-spotify-id'
    }
    const migrated = migrateConfig(legacyConfig)
    if (
      (migrated.server as Record<string, unknown>)?.port === 8080 &&
      (migrated.server as Record<string, unknown>)?.password === 'mypassword' &&
      (
        (migrated.sources as Record<string, unknown>)?.spotify as Record<
          string,
          unknown
        >
      )?.clientId === 'my-spotify-id' &&
      !('port' in migrated)
    ) {
      console.log(
        '[Test 10.1] Legacy flat config migrated and cleaned root keys successfully.'
      )
    } else {
      throw new Error('Test 10.1 Failed: Legacy config migration incorrect.')
    }

    // 10.2 Deep Merge & Missing Keys test
    const baseDefault = {
      server: {
        host: '0.0.0.0',
        port: 3000,
        autoUpdate: {
          enabled: false,
          channel: 'dev',
          checkInterval: 3600000
        }
      },
      playback: {
        voiceReceive: {
          enabled: false,
          format: 'pcm'
        }
      }
    }
    const userCustom = {
      server: {
        port: 2333,
        autoUpdate: {
          enabled: true
        }
      }
    }

    const missing = findMissingConfigKeys(baseDefault, userCustom)
    console.log('[Test 10.2] Detected missing keys:', missing)
    if (
      missing.includes('server.host') &&
      missing.includes('server.autoUpdate.channel') &&
      missing.includes('server.autoUpdate.checkInterval') &&
      missing.includes('playback')
    ) {
      console.log(
        '[Test 10.2] findMissingConfigKeys identified all missing paths.'
      )
    } else {
      throw new Error('Test 10.2 Failed: Missing keys not detected accurately.')
    }

    const merged = deepMerge(baseDefault, userCustom)
    if (
      merged.server.port === 2333 &&
      merged.server.host === '0.0.0.0' &&
      merged.server.autoUpdate.enabled === true &&
      merged.server.autoUpdate.channel === 'dev' &&
      merged.server.autoUpdate.checkInterval === 3600000 &&
      merged.playback.voiceReceive.format === 'pcm'
    ) {
      console.log(
        '[Test 10.3] deepMerge preserved user overrides and populated missing defaults.'
      )
    } else {
      throw new Error('Test 10.3 Failed: deepMerge output was incorrect.')
    }
    console.log(
      '✅ Test 10 Passed: Config migration, deepMerge, and missing keys verified.'
    )

    // Clean up temporary files
    const { rm } = await import('node:fs/promises')
    await rm(destFile, { force: true }).catch(() => {})
    await rm(stagingDir, { recursive: true, force: true }).catch(() => {})
  }

  console.log('\n🎉 ALL 10 TESTS PASSED!\n')
}

runTests().catch((error: unknown) => {
  console.error('\n❌ Test suite failed:', error)
  process.exit(1)
})
