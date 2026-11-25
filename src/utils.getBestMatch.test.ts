import assert from 'node:assert/strict'
import test from 'node:test'

import type {
  BestMatchCandidate,
  BestMatchTrackInfo
} from './typings/utils.types.ts'
import { getBestMatch } from './utils.ts'

type MatchCase = {
  name: string
  original: BestMatchTrackInfo
  candidates: BestMatchCandidate[]
  expected: string
}

const cases: MatchCase[] = [
  {
    name: 'prefers studio audio over an unknown-language live version',
    original: {
      title: 'Anjos',
      author: 'Venere Vai Venus',
      length: 200_000,
      uri: 'spotify:track:1'
    },
    candidates: [
      {
        info: {
          title: 'Anjos (Ao Vivo no Festival 2026)',
          author: 'Venere Vai Venus',
          length: 245_000
        }
      },
      {
        info: {
          title: 'Anjos',
          author: 'Venere Vai Venus - Topic',
          length: 200_000
        }
      }
    ],
    expected: 'Anjos'
  },
  {
    name: 'penalizes leftover brackets in any language',
    original: {
      title: 'Anjos',
      author: 'Venere Vai Venus',
      length: 200_000,
      uri: 'spotify:track:1'
    },
    candidates: [
      {
        info: {
          title: 'Anjos (ライブ 2026)',
          author: 'Venere Vai Venus',
          length: 240_000
        }
      },
      {
        info: {
          title: 'Anjos (En Direct)',
          author: 'Venere Vai Venus',
          length: 238_000
        }
      },
      {
        info: {
          title: 'Anjos (Official Audio)',
          author: 'Venere Vai Venus',
          length: 200_000
        }
      }
    ],
    expected: 'Anjos (Official Audio)'
  },
  {
    name: 'does not penalize standard upload tags',
    original: {
      title: 'Bohemian Rhapsody',
      author: 'Queen',
      length: 354_000,
      uri: 'spotify:track:2'
    },
    candidates: [
      {
        info: {
          title: 'Bohemian Rhapsody (Live at Wembley)',
          author: 'Queen',
          length: 400_000
        }
      },
      {
        info: {
          title: 'Queen - Bohemian Rhapsody (Official Video Remastered 2011)',
          author: 'Queen',
          length: 354_000
        }
      }
    ],
    expected: 'Queen - Bohemian Rhapsody (Official Video Remastered 2011)'
  },
  {
    name: 'ignores artist brackets and CJK version tags still count',
    original: {
      title: 'アンタに言ってんの！',
      author: '重音テト',
      length: 180_000,
      uri: 'spotify:track:3'
    },
    candidates: [
      {
        info: {
          title: '【重音テト】アンタに言ってんの！【ライブ】',
          author: '重音テト',
          length: 210_000
        }
      },
      {
        info: {
          title: '【重音テト】アンタに言ってんの！【MV】',
          author: '重音テト',
          length: 180_000
        }
      }
    ],
    expected: '【重音テト】アンタに言ってんの！【MV】'
  },
  {
    name: 'spec keywords use word boundaries',
    original: {
      title: 'Alive',
      author: 'X',
      length: 200_000,
      uri: 'spotify:track:4'
    },
    candidates: [
      {
        info: { title: 'Alive (Live)', author: 'X', length: 230_000 }
      },
      {
        info: { title: 'Alive', author: 'X - Topic', length: 200_000 }
      }
    ],
    expected: 'Alive'
  }
]

for (const matchCase of cases) {
  test(matchCase.name, () => {
    const best = getBestMatch(matchCase.candidates, matchCase.original)
    assert.equal(best?.info.title, matchCase.expected)
  })
}
