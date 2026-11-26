import type {
  AlignableLyricsLine,
  FlattenedYouTubeWord,
  PendingDeviation,
  SequenceMatch,
  YouTubeLyricsAlignmentData
} from '../typings/modules/lyricsAligner.types.ts'
import { readLyricsTimestamp } from './lyricsTiming.ts'

/**
 * Calculates normalized similarity between two strings.
 * @param s1 - First string.
 * @param s2 - Second string.
 * @returns Similarity score between 0 and 1.
 * @internal
 */
function similarity(s1: string, s2: string): number {
  const longer = s1.length > s2.length ? s1 : s2
  const shorter = s1.length > s2.length ? s2 : s1
  const longerLength = longer.length
  if (longerLength === 0) return 1.0
  return (longerLength - editDistance(longer, shorter)) / Number(longerLength)
}

/**
 * Computes Levenshtein edit distance.
 * @param s1 - First string.
 * @param s2 - Second string.
 * @returns Edit distance between two strings.
 * @internal
 */
function editDistance(s1: string, s2: string): number {
  const left = s1.toLowerCase()
  const right = s2.toLowerCase()
  const costs: number[] = []

  for (let i = 0; i <= left.length; i++) {
    let lastValue = i
    for (let j = 0; j <= right.length; j++) {
      if (i === 0) {
        costs[j] = j
      } else if (j > 0) {
        let newValue = costs[j - 1] ?? 0
        if (left.charAt(i - 1) !== right.charAt(j - 1)) {
          newValue = Math.min(Math.min(newValue, lastValue), costs[j] ?? 0) + 1
        }
        costs[j - 1] = lastValue
        lastValue = newValue
      }
    }
    if (i > 0) costs[right.length] = lastValue
  }

  return costs[right.length] ?? 0
}

/**
 * Normalizes a word for matching.
 * @param text - Input token.
 * @returns Normalized token.
 * @internal
 */
function cleanWord(text?: string): string {
  if (!text) return ''
  return text
    .replace(/\[.*?\]/g, '')
    .replace(/\(.*?\)/g, '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}]/gu, '')
}

/**
 * Converts YouTube caption payload into flat timed words.
 * @param ytLyrics - YouTube caption payload.
 * @returns Flattened word sequence.
 * @internal
 */
function flattenYouTubeLyrics(
  ytLyrics?: YouTubeLyricsAlignmentData | null
): FlattenedYouTubeWord[] {
  const words: FlattenedYouTubeWord[] = []
  if (!ytLyrics?.lines) return words

  for (const line of ytLyrics.lines) {
    if (line.text && /^\[.*\]$/.test(line.text.trim())) continue

    if (line.words && line.words.length > 0) {
      for (const word of line.words) {
        if (!word.text) continue
        const wordTokens = word.text.trim().split(/\s+/)
        const durationPerWord = (word.duration || 0) / (wordTokens.length || 1)
        const baseTime = readLyricsTimestamp(word.timestamp ?? word.time)
        if (baseTime === undefined) continue

        wordTokens.forEach((token, index) => {
          const clean = cleanWord(token)
          if (clean.length > 0) {
            words.push({
              text: clean,
              time: baseTime + Math.round(index * durationPerWord)
            })
          }
        })
      }
    } else if (line.text) {
      const lineStart = readLyricsTimestamp(line.time)
      if (lineStart === undefined) continue
      const lineText = line.text.trim()
      const lineWords = lineText.split(/\s+/)
      const durationPerWord = (line.duration || 2000) / (lineWords.length || 1)

      lineWords.forEach((word, index) => {
        const clean = cleanWord(word)
        if (clean.length > 0) {
          words.push({
            text: clean,
            time: lineStart + index * durationPerWord
          })
        }
      })
    }
  }

  return words
}

/**
 * Splits a line into normalized words.
 * @param text - Input line text.
 * @returns Normalized non-empty words.
 * @internal
 */
function getLineWords(text?: string): string[] {
  if (!text) return []
  return text
    .split(/\s+/)
    .map(cleanWord)
    .filter((word) => word.length > 0)
}

/**
 * Finds best matching YouTube sequence for target words.
 * @param targetWords - Target words from HQ line.
 * @param ytWords - Flattened YouTube words.
 * @param startIndex - Start index for search.
 * @param searchWindowEnd - Max timestamp allowed for search.
 * @returns Best sequence match or null.
 * @internal
 */
function findBestSequenceMatch(
  targetWords: string[],
  ytWords: FlattenedYouTubeWord[],
  startIndex: number,
  searchWindowEnd: number
): SequenceMatch | null {
  if (targetWords.length === 0) return null
  const keys = targetWords.slice(0, 5)
  if (keys.length === 0) return null

  let bestMatch: SequenceMatch | null = null
  let maxScore = 0

  for (let i = startIndex; i < ytWords.length; i++) {
    const yw = ytWords[i]
    if (!yw) break
    if (yw.time > searchWindowEnd) break

    if (similarity(keys[0] || '', yw.text) > 0.75) {
      let matchCount = 1
      const checkLen = Math.min(keys.length, ytWords.length - i)

      let ytOffset = 0
      for (let k = 1; k < checkLen; k++) {
        const candidate = ytWords[i + k + ytOffset]
        if (candidate && similarity(keys[k] || '', candidate.text) > 0.75) {
          matchCount++
        } else {
          const offsetCandidate = ytWords[i + k + ytOffset + 1]
          if (
            offsetCandidate &&
            similarity(keys[k] || '', offsetCandidate.text) > 0.75
          ) {
            matchCount++
            ytOffset++
          }
        }
      }

      const score = matchCount / keys.length
      if (score > maxScore && score >= 0.7) {
        maxScore = score
        bestMatch = { index: i, time: yw.time, score }
        if (score === 1.0) break
      }
    }
  }

  return bestMatch
}

/**
 * Aligns HQ lyrics lines with YouTube timing reference.
 * @param hqLyrics - High-quality lyrics lines.
 * @param youtubeData - YouTube caption payload.
 * @returns Aligned lyric lines preserving original content.
 * @public
 */
export function alignLyrics(
  hqLyrics: AlignableLyricsLine[],
  youtubeData?: YouTubeLyricsAlignmentData | null
): AlignableLyricsLine[] {
  if (!hqLyrics?.length || !youtubeData?.lines) return hqLyrics

  const ytWords = flattenYouTubeLyrics(youtubeData)
  if (ytWords.length === 0) return hqLyrics

  const alignedLines: AlignableLyricsLine[] = []

  let lastYtIndex = 0
  let currentOffset = 0
  let offsetInitialized = false
  let pendingDeviation: PendingDeviation | null = null

  const MAX_JUMP_MS = 2500
  const SEARCH_LOOKAHEAD = 25000
  const EXTENDED_LOOKAHEAD = 90000

  for (let i = 0; i < hqLyrics.length; i++) {
    const line = hqLyrics[i]
    if (!line) continue
    const words = getLineWords(line.text)
    const predictedYtTime = line.time + currentOffset

    let match = findBestSequenceMatch(
      words,
      ytWords,
      lastYtIndex,
      predictedYtTime + SEARCH_LOOKAHEAD
    )

    if (!match && words.length >= 4) {
      const extendedMatch = findBestSequenceMatch(
        words,
        ytWords,
        lastYtIndex,
        predictedYtTime + EXTENDED_LOOKAHEAD
      )
      if (extendedMatch && extendedMatch.score >= 0.85) {
        match = extendedMatch
      }
    }

    let offsetToUse = currentOffset

    if (match) {
      const instantOffset = match.time - line.time

      if (!offsetInitialized) {
        currentOffset = instantOffset
        offsetToUse = currentOffset
        offsetInitialized = true
      } else {
        const diff = Math.abs(instantOffset - currentOffset)

        if (diff > MAX_JUMP_MS) {
          if (pendingDeviation) {
            if (Math.abs(instantOffset - pendingDeviation.offset) < 1000) {
              currentOffset = instantOffset
              offsetToUse = currentOffset
              pendingDeviation = null
            } else {
              pendingDeviation = { offset: instantOffset, index: i }
              offsetToUse = currentOffset
            }
          } else {
            pendingDeviation = { offset: instantOffset, index: i }
            offsetToUse = currentOffset
          }
        } else {
          pendingDeviation = null
          currentOffset = currentOffset * 0.8 + instantOffset * 0.2
          offsetToUse = currentOffset
        }
      }

      if (match.index > lastYtIndex) {
        lastYtIndex = match.index
      }
    } else {
      offsetToUse = currentOffset
    }

    if (!offsetInitialized) {
      alignedLines.push(line)
      continue
    }
    const newTime = Math.max(0, Math.round(line.time + offsetToUse))
    const delta = newTime - line.time
    const shiftedWords = line.words?.map((word) => {
      const updated = { ...word }
      for (const field of ['timestamp', 'time'] as const) {
        const original = word[field]
        const time = readLyricsTimestamp(original)
        if (time !== undefined) {
          const shifted = Math.max(0, time + delta)
          updated[field] =
            typeof original === 'string' ? String(shifted) : shifted
        }
      }
      return updated
    })

    alignedLines.push({
      ...line,
      time: newTime,
      ...(shiftedWords ? { words: shiftedWords } : {})
    })
  }

  return alignedLines
}
