import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import type { Readable } from 'node:stream'
import { promisify } from 'node:util'
import { printStartupBanner } from '../src/bootstrap/branding.ts'
import { loadBootstrapConfig } from '../src/bootstrap/config.ts'
import SourcesManager, {
  type SourcesManagerContext
} from '../src/managers/sourceManager.ts'
import type { NodelinkConfig } from '../src/typings/config/config.types.ts'
import type {
  SourceInstance,
  SourceResult,
  TrackData,
  TrackInfo
} from '../src/typings/sources/source.types.ts'
import type {
  SourceTestCase,
  SourceTestMatcher,
  SourceTestStreamSpec,
  SourceTestVariantResult,
  SourceVariantHandler
} from '../src/typings/sources/test.types.ts'
import { getVersion, initLogger, logger } from '../src/utils.ts'

const execFileAsync = promisify(execFile)

const colors = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  magenta: '\x1b[35m',
  gray: '\x1b[90m',
  white: '\x1b[37m'
} as const

interface FFprobeStream {
  codec_name?: string
  codec_type?: string
  sample_rate?: string
  channels?: number
  duration?: string
}

interface FFprobeFormat {
  format_name?: string
  duration?: string
  size?: string
  bit_rate?: string
}

interface FFprobeOutput {
  streams?: FFprobeStream[]
  format?: FFprobeFormat
}

interface StreamValidationResult {
  ok: boolean
  httpStatus?: number
  contentLength?: number
  bytesReceived: number
  downloadTimeMs: number
  speedMBs: number
  container: string
  codec: string
  audioValid: boolean
  cleanedUp: boolean
  error?: string
}

interface MatcherEvaluationResult {
  pass: boolean
  details?: string
}

interface TestableSourceConstructor {
  readonly _TESTS?: readonly SourceTestCase[]
}

interface DestroyableStream {
  destroy?: () => void
}

/**
 * Formats a boolean check into a colored status label.
 */
function formatStatus(passed: boolean): string {
  return passed
    ? `${colors.green}Yes${colors.reset}`
    : `${colors.red}No${colors.reset}`
}

/**
 * Evaluates a single declarative matcher against a target value.
 */
function evaluateMatcher(
  matcher: SourceTestMatcher,
  actual: unknown
): MatcherEvaluationResult {
  switch (matcher.op) {
    case 'equals': {
      const pass = actual === matcher.value
      return {
        pass,
        details: pass
          ? undefined
          : `expected "${matcher.value}", got "${actual}"`
      }
    }
    case 'not-equals': {
      const pass = actual !== matcher.value
      return {
        pass,
        details: pass
          ? undefined
          : `expected not "${matcher.value}", got "${actual}"`
      }
    }
    case 'matches': {
      const regex =
        matcher.value instanceof RegExp
          ? matcher.value
          : new RegExp(String(matcher.value), 'i')
      const pass = regex.test(String(actual ?? ''))
      return {
        pass,
        details: pass
          ? undefined
          : `expected to match /${regex.source}/i, got "${actual}"`
      }
    }
    case 'not-matches': {
      const regex =
        matcher.value instanceof RegExp
          ? matcher.value
          : new RegExp(String(matcher.value), 'i')
      const pass = !regex.test(String(actual ?? ''))
      return {
        pass,
        details: pass
          ? undefined
          : `expected not to match /${regex.source}/i, got "${actual}"`
      }
    }
    case 'between': {
      const num = Number(actual)
      const pass =
        Number.isFinite(num) && num >= matcher.min && num <= matcher.max
      return {
        pass,
        details: pass
          ? undefined
          : `expected value between ${matcher.min} and ${matcher.max}, got ${actual}`
      }
    }
    case 'at-least': {
      const num = Number(actual)
      const pass = Number.isFinite(num) && num >= matcher.value
      return {
        pass,
        details: pass
          ? undefined
          : `expected value at least ${matcher.value}, got ${actual}`
      }
    }
    case 'at-most': {
      const num = Number(actual)
      const pass = Number.isFinite(num) && num <= matcher.value
      return {
        pass,
        details: pass
          ? undefined
          : `expected value at most ${matcher.value}, got ${actual}`
      }
    }
    case 'exists': {
      const exists = actual !== undefined && actual !== null && actual !== ''
      const pass = matcher.value ? exists : !exists
      return {
        pass,
        details: pass
          ? undefined
          : `expected exists=${matcher.value}, but exists=${exists} (value: ${actual})`
      }
    }
  }
}

/**
 * Downloads audio incrementally to temporary storage and validates integrity with ffmpeg.
 */
async function processAndValidateStream(
  variantResult: SourceTestVariantResult,
  spec: SourceTestStreamSpec
): Promise<StreamValidationResult> {
  const t0 = performance.now()
  let bytesReceived = 0
  const tempPath = path.join(
    os.tmpdir(),
    `nodelink-stream-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`
  )

  const isComplete = spec.download === 'complete'
  const windowMaxMs =
    typeof spec.download === 'object' ? spec.download.maxDurationMs : 0
  const windowMaxBytes =
    typeof spec.download === 'object' ? (spec.download.maxBytes ?? 0) : 0

  const writeStream = fs.createWriteStream(tempPath)
  let validationResult: StreamValidationResult = {
    ok: false,
    httpStatus: variantResult.httpStatus,
    bytesReceived: 0,
    downloadTimeMs: 0,
    speedMBs: 0,
    container: variantResult.container || 'unknown',
    codec: variantResult.codec || 'unknown',
    audioValid: false,
    cleanedUp: false
  }

  try {
    const rawStream = variantResult.stream as
      | (Readable & DestroyableStream)
      | undefined
    if (!rawStream) {
      validationResult = {
        ok: false,
        httpStatus: variantResult.httpStatus,
        bytesReceived: 0,
        downloadTimeMs: 0,
        speedMBs: 0,
        container: variantResult.container || 'unknown',
        codec: variantResult.codec || 'unknown',
        audioValid: false,
        cleanedUp: false,
        error:
          typeof variantResult.error === 'string'
            ? variantResult.error
            : variantResult.error?.message ||
              'No stream provided by variant result'
      }
      return validationResult
    }

    await new Promise<void>((resolve, reject) => {
      let resolved = false
      let windowTimeout: NodeJS.Timeout | null = null

      const finishSuccessfully = (): void => {
        if (resolved) return
        resolved = true
        if (windowTimeout) clearTimeout(windowTimeout)
        writeStream.end(() => resolve())
      }

      if (!isComplete && windowMaxMs > 0) {
        windowTimeout = setTimeout(() => {
          rawStream.destroy?.()
          finishSuccessfully()
        }, windowMaxMs)
      }

      rawStream.on('data', (chunk: Buffer) => {
        bytesReceived += chunk.length
        writeStream.write(chunk)

        const elapsed = Math.max(1, performance.now() - t0)
        const speed = (bytesReceived / 1024 / 1024 / (elapsed / 1000)).toFixed(
          2
        )
        const totalMb = (bytesReceived / 1024 / 1024).toFixed(2)

        if (variantResult.contentLength && isComplete) {
          const expectedMb = (
            variantResult.contentLength /
            1024 /
            1024
          ).toFixed(2)
          const pct = Math.min(
            100,
            Math.round((bytesReceived / variantResult.contentLength) * 100)
          )
          if (process.stdout.isTTY) {
            process.stdout.write(
              `\r  Download      ${pct}%  ${totalMb} MB / ${expectedMb} MB (${speed} MB/s)`
            )
          }
        } else if (process.stdout.isTTY) {
          process.stdout.write(
            `\r  Download      ${totalMb} MB (${speed} MB/s)`
          )
        }

        if (
          !isComplete &&
          windowMaxBytes > 0 &&
          bytesReceived >= windowMaxBytes
        ) {
          rawStream.destroy?.()
          finishSuccessfully()
        }
      })

      rawStream.on('end', () => finishSuccessfully())
      rawStream.on('finishBuffering', () => finishSuccessfully())

      rawStream.on('error', (err: Error) => {
        if (resolved) return
        resolved = true
        if (windowTimeout) clearTimeout(windowTimeout)
        reject(err)
      })

      writeStream.on('error', (err: Error) => {
        if (resolved) return
        resolved = true
        if (windowTimeout) clearTimeout(windowTimeout)
        reject(err)
      })
    })

    const downloadTimeMs = Math.round(performance.now() - t0)
    const speedMBs = Number(
      (
        bytesReceived /
        1024 /
        1024 /
        (Math.max(1, downloadTimeMs) / 1000)
      ).toFixed(2)
    )

    if (process.stdout.isTTY) {
      process.stdout.write('\r\x1b[K')
    }

    if (spec.minBytes && bytesReceived < spec.minBytes) {
      validationResult = {
        ok: false,
        httpStatus: variantResult.httpStatus,
        contentLength: variantResult.contentLength,
        bytesReceived,
        downloadTimeMs,
        speedMBs,
        container: variantResult.container || 'unknown',
        codec: variantResult.codec || 'unknown',
        audioValid: false,
        cleanedUp: false,
        error: `Received ${bytesReceived} bytes, below required minimum of ${spec.minBytes}`
      }
      return validationResult
    }

    if (
      isComplete &&
      variantResult.contentLength &&
      variantResult.contentLength > 0 &&
      bytesReceived !== variantResult.contentLength
    ) {
      validationResult = {
        ok: false,
        httpStatus: variantResult.httpStatus,
        contentLength: variantResult.contentLength,
        bytesReceived,
        downloadTimeMs,
        speedMBs,
        container: variantResult.container || 'unknown',
        codec: variantResult.codec || 'unknown',
        audioValid: false,
        cleanedUp: false,
        error: `Stream interrupted: received ${bytesReceived} bytes, expected Content-Length ${variantResult.contentLength}`
      }
      return validationResult
    }

    const { stdout: probeStdout } = await execFileAsync('ffprobe', [
      '-v',
      'error',
      '-show_format',
      '-show_streams',
      '-print_format',
      'json',
      tempPath
    ])

    const probeInfo = JSON.parse(probeStdout) as FFprobeOutput
    const audioStream =
      probeInfo.streams?.find((s) => s.codec_type === 'audio') ??
      probeInfo.streams?.[0]

    let identifiedContainer = variantResult.container || 'unknown'
    let identifiedCodec =
      audioStream?.codec_name || variantResult.codec || 'unknown'

    const formatName = probeInfo.format?.format_name ?? ''
    if (formatName.includes('webm') || formatName.includes('matroska')) {
      identifiedContainer = 'WebM'
    } else if (
      formatName.includes('mp4') ||
      formatName.includes('m4a') ||
      formatName.includes('mov')
    ) {
      identifiedContainer = 'MP4'
    } else if (formatName.includes('ogg')) {
      identifiedContainer = 'Ogg'
    }

    if (identifiedCodec === 'opus') {
      identifiedCodec = 'Opus'
    } else if (identifiedCodec === 'aac') {
      identifiedCodec = 'AAC'
    }

    const { stderr: ffmpegStderr } = await execFileAsync('ffmpeg', [
      '-v',
      'error',
      '-i',
      tempPath,
      '-f',
      'null',
      '-'
    ])

    const audioValid = ffmpegStderr.trim().length === 0

    if (spec.validFormats && spec.validFormats.length > 0) {
      const matchesFormat = spec.validFormats.some(
        (fmt) =>
          fmt.container.toLowerCase() === identifiedContainer.toLowerCase() &&
          fmt.codec.toLowerCase() === identifiedCodec.toLowerCase()
      )

      if (!matchesFormat) {
        validationResult = {
          ok: false,
          httpStatus: variantResult.httpStatus,
          contentLength: variantResult.contentLength,
          bytesReceived,
          downloadTimeMs,
          speedMBs,
          container: identifiedContainer,
          codec: identifiedCodec,
          audioValid,
          cleanedUp: false,
          error: `Identified format ${identifiedContainer}/${identifiedCodec} is not in allowed combinations: ${spec.validFormats.map((f) => `${f.container}/${f.codec}`).join(', ')}`
        }
        return validationResult
      }
    }

    validationResult = {
      ok: audioValid,
      httpStatus: variantResult.httpStatus ?? 200,
      contentLength: variantResult.contentLength,
      bytesReceived,
      downloadTimeMs,
      speedMBs,
      container: identifiedContainer,
      codec: identifiedCodec,
      audioValid,
      cleanedUp: false
    }
    return validationResult
  } catch (err) {
    validationResult = {
      ok: false,
      httpStatus: variantResult.httpStatus,
      bytesReceived,
      downloadTimeMs: Math.round(performance.now() - t0),
      speedMBs: 0,
      container: variantResult.container || 'unknown',
      codec: variantResult.codec || 'unknown',
      audioValid: false,
      cleanedUp: false,
      error: err instanceof Error ? err.message : String(err)
    }
    return validationResult
  } finally {
    try {
      if (fs.existsSync(tempPath)) {
        await fs.promises.unlink(tempPath)
      }
      validationResult.cleanedUp = !fs.existsSync(tempPath)
    } catch {
      validationResult.cleanedUp = false
    }
  }
}

/**
 * Runs a single declarative test case against a source instance.
 */
async function runTestCase(
  sourceName: string,
  sourceInstance: SourceInstance,
  testCase: SourceTestCase
): Promise<{ passed: boolean; error?: string }> {
  console.log(
    `\n${colors.cyan}${sourceName}${colors.reset} / ${colors.bold}${testCase.name}${colors.reset}`
  )

  if (testCase.skip) {
    console.log(
      `  ${colors.yellow}Skipped: ${testCase.skip.reason}${colors.reset}`
    )
    return { passed: true }
  }

  const tStart = performance.now()
  let result: SourceResult | null = null
  let opError: Error | null = null

  try {
    if (testCase.input.type === 'search') {
      const searchType = testCase.input.searchType || 'ytsearch'
      result = (await sourceInstance.search?.(
        testCase.input.value,
        searchType
      )) as SourceResult
    } else {
      result = (await sourceInstance.resolve?.(
        testCase.input.value
      )) as SourceResult
    }
  } catch (e) {
    opError = e instanceof Error ? e : new Error(String(e))
  }

  const opMs = Math.round(performance.now() - tStart)

  if (opError) {
    console.log(
      `  Operation   ${formatStatus(false)}   ${colors.gray}${opMs}ms${colors.reset} -> ${opError.message}`
    )
    return { passed: false, error: opError.message }
  }

  const actualType = result?.loadType
  if (actualType !== testCase.expect.result.type) {
    console.log(
      `  Operation   ${formatStatus(false)}   expected type "${testCase.expect.result.type}", got "${actualType}"`
    )
    return {
      passed: false,
      error: `Result type mismatch: expected ${testCase.expect.result.type}, got ${actualType}`
    }
  }

  if (testCase.forbid?.resultTypes?.includes(actualType)) {
    console.log(
      `  Operation   ${formatStatus(false)}   result type "${actualType}" is strictly forbidden`
    )
    return {
      passed: false,
      error: `Forbidden result type returned: ${actualType}`
    }
  }

  let primaryTrack: TrackInfo | null = null
  let collectionItems: TrackData[] = []

  if (actualType === 'track') {
    primaryTrack = (result as { data: TrackData }).data?.info ?? null
  } else if (actualType === 'playlist') {
    const plData = (
      result as {
        data: { tracks: TrackData[]; info?: { selectedTrack?: number } }
      }
    ).data
    collectionItems = plData?.tracks ?? []
    const selectedIdx = plData?.info?.selectedTrack
    if (
      typeof selectedIdx === 'number' &&
      selectedIdx >= 0 &&
      collectionItems[selectedIdx]
    ) {
      primaryTrack = collectionItems[selectedIdx]?.info ?? null
    } else {
      primaryTrack = collectionItems[0]?.info ?? null
    }
  } else if (actualType === 'search') {
    collectionItems = (result as { data: TrackData[] }).data ?? []
    primaryTrack = collectionItems[0]?.info ?? null
  }

  if (testCase.expect.collection) {
    const colSpec = testCase.expect.collection
    if (
      colSpec.minItems !== undefined &&
      collectionItems.length < colSpec.minItems
    ) {
      console.log(
        `  Collection  ${formatStatus(false)}   items count ${collectionItems.length} is below minItems ${colSpec.minItems}`
      )
      return {
        passed: false,
        error: `Collection items ${collectionItems.length} < minItems ${colSpec.minItems}`
      }
    }

    if (
      colSpec.maxItems !== undefined &&
      collectionItems.length > colSpec.maxItems
    ) {
      console.log(
        `  Collection  ${formatStatus(false)}   items count ${collectionItems.length} exceeds maxItems ${colSpec.maxItems}`
      )
      return {
        passed: false,
        error: `Collection items ${collectionItems.length} > maxItems ${colSpec.maxItems}`
      }
    }

    if (colSpec.expectedSelectedTrack !== undefined) {
      const plData = (
        result as {
          data: { info?: { selectedTrack?: number } }
        }
      ).data
      const actualSelected = plData?.info?.selectedTrack
      const matcher: SourceTestMatcher =
        typeof colSpec.expectedSelectedTrack === 'number'
          ? { op: 'equals', value: colSpec.expectedSelectedTrack }
          : colSpec.expectedSelectedTrack
      const { pass, details } = evaluateMatcher(matcher, actualSelected)
      if (!pass) {
        console.log(
          `  SelectedTrack ${formatStatus(false)}   ${details}`
        )
        return {
          passed: false,
          error: `SelectedTrack: ${details}`
        }
      }
    }

    if (colSpec.selectTrackForStream === 'last' && collectionItems.length > 0) {
      primaryTrack = collectionItems[collectionItems.length - 1]?.info ?? null
    } else if (typeof colSpec.selectTrackForStream === 'number') {
      primaryTrack = collectionItems[colSpec.selectTrackForStream]?.info ?? null
    }
  }

  if (testCase.expect.metadata && primaryTrack) {
    for (const [key, matcher] of Object.entries(testCase.expect.metadata) as [
      keyof TrackInfo,
      SourceTestMatcher
    ][]) {
      const actualVal = primaryTrack[key]
      const { pass, details } = evaluateMatcher(matcher, actualVal)
      if (!pass) {
        console.log(
          `  Metadata    ${formatStatus(false)}   key "${key}": ${details}`
        )
        return {
          passed: false,
          error: `Metadata assertion failed on "${key}": ${details}`
        }
      }
    }
  }

  if (testCase.forbid?.metadata && primaryTrack) {
    for (const [key, matcher] of Object.entries(testCase.forbid.metadata) as [
      keyof TrackInfo,
      SourceTestMatcher
    ][]) {
      const actualVal = primaryTrack[key]
      const { pass } = evaluateMatcher(matcher, actualVal)
      if (pass) {
        console.log(
          `  Forbid      ${formatStatus(false)}   key "${key}" matched forbidden condition: value is "${actualVal}"`
        )
        return {
          passed: false,
          error: `Forbidden metadata condition met on "${key}": ${actualVal}`
        }
      }
    }
  }

  const variants = testCase.matrix?.variants
  let allVariantsPassed = true

  if (variants && variants.length > 0) {
    const handler = sourceInstance as unknown as SourceVariantHandler

    if (!primaryTrack) {
      console.log(
        `  ${colors.red}Error: No track available to test variants matrix${colors.reset}`
      )
      return { passed: false, error: 'No track available for variant testing' }
    }

    for (const variant of variants) {
      console.log(`\n  [${colors.magenta}${variant.id}${colors.reset}]`)

      if (variant.skip) {
        console.log(
          `  ${colors.yellow}Skipped: ${variant.skip.reason}${colors.reset}`
        )
        continue
      }

      let variantRes: SourceTestVariantResult
      let varMs = 0
      try {
        const tVar0 = performance.now()
        variantRes = await handler.executeVariant(
          variant,
          primaryTrack,
          testCase.expect.stream
        )
        varMs = Math.round(performance.now() - tVar0)
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err)
        console.log(`  Resolve       ${formatStatus(false)}   -> ${errMsg}`)
        allVariantsPassed = false
        continue
      }

      if (variantRes.skipped) {
        console.log(
          `  ${colors.yellow}Skipped: ${variantRes.skipReason || 'Skipped'}${colors.reset}`
        )
        continue
      }

      if (!variantRes.resolved) {
        const errMsg =
          typeof variantRes.error === 'string'
            ? variantRes.error
            : variantRes.error?.message || 'Resolution failed'
        console.log(
          `  Resolve       ${formatStatus(false)}   ${colors.gray}${varMs}ms${colors.reset} -> ${errMsg}`
        )
        allVariantsPassed = false
        continue
      }

      console.log(
        `  Resolve       ${formatStatus(variantRes.resolved)}  ${colors.gray}${varMs}ms${colors.reset}`
      )
      console.log(
        `  Track         ${formatStatus(primaryTrack !== null)}  ${colors.white}${primaryTrack.title}${colors.reset}`
      )
      console.log(
        `  Identifier          ${colors.gray}${primaryTrack.identifier}${colors.reset}`
      )

      if (testCase.expect.stream?.required) {
        if (!variantRes.stream) {
          const errMsg =
            typeof variantRes.error === 'string'
              ? variantRes.error
              : variantRes.error?.message || 'Variant returned no stream'
          console.log(`  Stream        ${formatStatus(false)}   ${errMsg}`)
          console.log(`  Cleanup       ${formatStatus(true)}`)
          allVariantsPassed = false
          continue
        }

        const streamVal = await processAndValidateStream(
          variantRes,
          testCase.expect.stream
        )

        if (!streamVal.ok) {
          const statusStr = streamVal.httpStatus
            ? `HTTP ${streamVal.httpStatus}`
            : ''
          console.log(
            `  Stream        ${formatStatus(false)}   ${statusStr} -> ${streamVal.error || 'Validation failed'}`
          )
          console.log(`  Cleanup       ${formatStatus(streamVal.cleanedUp)}`)
          allVariantsPassed = false
          continue
        }

        const totalMb = (streamVal.bytesReceived / 1024 / 1024).toFixed(2)
        const expectedMb = streamVal.contentLength
          ? (streamVal.contentLength / 1024 / 1024).toFixed(2)
          : totalMb
        const pct = streamVal.contentLength
          ? `${Math.min(100, Math.round((streamVal.bytesReceived / streamVal.contentLength) * 100))}%`
          : '100%'

        console.log(
          `  Stream        ${formatStatus(streamVal.ok)}  HTTP ${streamVal.httpStatus || 200}`
        )
        console.log(`  Download      ${pct}  ${totalMb} MB / ${expectedMb} MB`)
        console.log(`  Speed               ${streamVal.speedMBs} MB/s`)
        console.log(`  Container           ${streamVal.container}`)
        console.log(`  Codec               ${streamVal.codec}`)
        console.log(`  Audio Validation ${formatStatus(streamVal.audioValid)}`)
        console.log(`  Cleanup       ${formatStatus(streamVal.cleanedUp)}`)
      }
    }
  } else {
    if (actualType === 'playlist') {
      const plData = result as {
        data: { info: { name: string; selectedTrack?: number } }
      }
      console.log(
        `  Playlist      ${formatStatus(opError === null)}  ${colors.white}${plData.data.info.name}${colors.reset} (${collectionItems.length} tracks, selected: ${plData.data.info.selectedTrack ?? 0})`
      )
      if (primaryTrack) {
        console.log(
          `  Selected      ${formatStatus(true)}  ${colors.white}${primaryTrack.title}${colors.reset} [${colors.gray}${primaryTrack.identifier}${colors.reset}]`
        )
      }
    } else if (primaryTrack) {
      console.log(
        `  Resolve       ${formatStatus(opError === null)}  ${colors.gray}${opMs}ms${colors.reset}`
      )
      console.log(
        `  Track         ${formatStatus(primaryTrack !== null)}  ${colors.white}${primaryTrack.title}${colors.reset}`
      )
      console.log(
        `  Identifier          ${colors.gray}${primaryTrack.identifier}${colors.reset}`
      )
    } else if (actualType === 'search') {
      console.log(
        `  Search        ${formatStatus(collectionItems.length > 0)}  Found ${collectionItems.length} items`
      )
    } else if (actualType === 'error') {
      const errData = result as {
        exception?: { message?: string; cause?: string }
      }
      console.log(
        `  Error         ${formatStatus(opError === null)}  ${errData.exception?.cause || 'Exception'}: ${errData.exception?.message}`
      )
    }
  }

  return { passed: allVariantsPassed }
}

/**
 * Universal entry point: discovers and executes declarative tests through SourcesManager.
 */
async function main(): Promise<void> {
  const version = String(getVersion())
  printStartupBanner(version, false)

  const { config: configObj } = await loadBootstrapConfig()
  const targetArg = process.argv[2]?.toLowerCase()
  const filterArg = process.argv[3]?.toLowerCase()

  const rawSources = configObj.sources ?? {}
  const filteredSources: Record<string, unknown> = {}

  for (const [key, val] of Object.entries(rawSources)) {
    if (targetArg) {
      filteredSources[key] =
        key.toLowerCase() === targetArg ? val : { enabled: false }
    } else {
      filteredSources[key] = val
    }
  }

  const scopedConfig: NodelinkConfig = {
    ...configObj,
    sources: filteredSources as NodelinkConfig['sources']
  }

  initLogger({
    logging: {
      level: 'info',
      debug: { all: false }
    }
  })

  const logSource = (message: string): void => {
    logger('sources', 'Sources', message)
  }

  const managerContext: SourcesManagerContext = {
    options: scopedConfig,
    credentialManager: {
      get: <T = unknown>(_key: string): T | null => null,
      set: (_key: string, _value: unknown): void => {}
    }
  }

  const sourcesManager = new SourcesManager(managerContext)
  await sourcesManager.loadFolder()

  const candidateEntries = targetArg
    ? Array.from(sourcesManager.sources.entries()).filter(
        ([name]) => name.toLowerCase() === targetArg
      )
    : Array.from(sourcesManager.sources.entries())

  if (targetArg && candidateEntries.length === 0) {
    logSource(`Target source "${targetArg}" was not loaded or does not exist`)
    process.exit(1)
  }

  let totalTests = 0
  let passedTests = 0
  let failedTests = 0
  const tGlobal0 = performance.now()

  for (const [sourceName, instance] of candidateEntries) {
    const sourceCtor =
      instance.constructor as unknown as TestableSourceConstructor
    const tests = sourceCtor._TESTS

    if (!tests || tests.length === 0) {
      if (targetArg) {
        logSource(`Source "${sourceName}" does not define any _TESTS cases`)
      }
      continue
    }

    const activeTests = filterArg
      ? tests.filter(
          (t) =>
            t.id.toLowerCase().includes(filterArg) ||
            t.name.toLowerCase().includes(filterArg)
        )
      : tests

    logSource(
      `Running ${activeTests.length} declarative test cases for "${sourceName}"...`
    )

    for (const testCase of activeTests) {
      totalTests++
      const result = await runTestCase(sourceName, instance, testCase)
      if (result.passed) {
        passedTests++
      } else {
        failedTests++
      }
    }
  }

  const elapsedTotal = Math.round(performance.now() - tGlobal0)
  console.log('')
  logSource(
    `Test finished: ${passedTests} passed, ${failedTests} failed across ${totalTests} tests (${elapsedTotal}ms)`
  )

  if (failedTests > 0) {
    process.exit(1)
  }
}

main().catch((err: unknown) => {
  console.error('\nFatal test execution error:', err)
  process.exit(1)
})
