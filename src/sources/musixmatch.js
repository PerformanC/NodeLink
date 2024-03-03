import crypto from 'node:crypto'

import config from '../../config.js'
import { debugLog, makeRequest } from '../utils.js'

function _getGuid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (character) => {
    const random = 16 * Math.random() | 0
    const value = character === 'x' ? random : 3 & random | 8

    return value.toString(16)
  })
}

let sourceInfo = {
  guid: null
}

function init() {
  sourceInfo.guid = _getGuid()

  debugLog('musixmatch', 5, { message: `New guid: ${sourceInfo.guid}` })
}

function _signUrl(url) {
  const time = new Date
  const year = time.getUTCFullYear()
  let month = time.getUTCMonth() + 1
  month < 10 && (month = '0' + month)
  let day = time.getUTCDate()
  day < 10 && (day = '0' + day)

  let superKey = crypto.createHmac('sha1', config.search.sources.musixmatch.signatureSecret)
  superKey = superKey.update(url + year + month + day)
  superKey = superKey.digest('base64')

  return url + `&signature=${encodeURIComponent(superKey)}&signature_protocol=sha1`
}

function _normalizeLanguage(language) {
  switch (language) {
    case 'ara': return 'ar'
    case 'afr': return 'af'
    case 'ind': return 'id'
    case 'kan': return 'kn'
    case 'kor': return 'ko'
    case 'rkr': return 'rk'
    case 'zho': return 'zh'
    case 'rz0': return 'rz'
    case 'zht': return 'z1'
    case 'ces': return 'cs'
    case 'deu': return 'de'
    case 'nld': return 'nl'
    case 'spa': return 'es'
    case 'dan': return 'da'
    case 'ell': return 'el'
    case 'eng': return 'en'
    case 'fas': return 'fa'
    case 'fin': return 'fi'
    case 'fra': return 'fr'
    case 'heb': return 'he'
    case 'hin': return 'hi'
    case 'ita': return 'it'
    case 'jpn': return 'ja'
    case 'hun': return 'hu'
    case 'rja': return 'rj'
    case 'nor': return 'no'
    case 'pol': return 'pl'
    case 'por': return 'pt'
    case 'pt-br': return 'pt-br'
    case 'rus': return 'ru'
    case 'ron': return 'ro'
    case 'tur': return 'tr'
    case 'lit': return 'lt'
    case 'mas': return 'ms'
    case 'mkd': return 'mk'
    case 'sqi': return 'sq'
    case 'hye': return 'hy'
    case 'aze': return 'az'
    case 'ben': return 'bn'
    case 'bos': return 'bs'
    case 'bul': return 'bg'
    case 'hrv': return 'hr'
    case 'est': return 'et'
    case 'fil': return 'f1'
    case 'kat': return 'ka'
    case 'hat': return 'ht'
    case 'isl': return 'is'
    case 'kaz': return 'kk'
    case 'kir': return 'ky'
    case 'lao': return 'lo'
    case 'lav': return 'lv'
    case 'mon': return 'mn'
    case 'msa': return 'ms'
    case 'nep': return 'ne'
    case 'pan': return 'pa'
    case 'srp': return 'sr'
    case 'slk': return 'sk'
    case 'slv': return 'sl'
    case 'swe': return 'se'
    case 'tha': return 'th'
    case 'ukr': return 'uk'
    case 'uzb': return 'uz'
    case 'vie': return 'vi'
  }
}

async function search(query) {
  init()
  const { body: data } = await makeRequest(_signUrl(`https://www.musixmatch.com/ws/1.1/macro.search?app_id=community-app-v1.0&part=track_artist,track_lyrics_translation_status&guid=${sourceInfo.guid}&format=json&q=${encodeURIComponent(query)}&page_size=1`), {
    method: 'GET'
  })

  return data.message.body.macro_result_list.track_list[0].track
}

async function loadLyrics(decodedTrack, language) {
  const searchResults = await search(`${decodedTrack.title} ${decodedTrack.artist}`)

  if (!searchResults) return null

  const { body: data } = await makeRequest(_signUrl(`https://www.musixmatch.com/ws/1.1/track.lyrics.get?page_size=100&page=1&commontrack_id=${searchResults.commontrack_id}&format=json&app_id=community-app-v1.0&guid=${sourceInfo.guid}`), {
    method: 'GET'
  })

  const lyricsEvents = data.message.body.lyrics.lyrics_body.split('\n').map((text) => {
    return {
      text
    }
  })

  if (language && language !== searchResults.lyrics_language && searchResults.track_lyrics_translation_status.find((status) => _normalizeLanguage(status.to) === language)) {
    const { body: data } = await makeRequest(_signUrl(`https://www.musixmatch.com/ws/1.1/crowd.track.translations.get?page_size=1&selected_language=${language}&track_id=${searchResults.track_id}&format=json&app_id=community-app-v1.0&guid=${sourceInfo.guid}`), {
      method: 'GET'
    })

    lyricsEvents.forEach((text, i) => {
      if (text.text === '') return;

      data.message.body.translations_list.forEach((translation) => {
        if (text.text && text.text.replace(/′/, '\'') === translation.translation.matched_line) {
          lyricsEvents[i].text = translation.translation.description
        }
      })
    })
  } else {
    language = searchResults.lyrics_language
  }

  return {
    loadType: 'lyricsSingle',
    data: {
      name: language,
      synced: false,
      data: lyricsEvents,
      rtl: false
    }
  }
}

export default {
  init,
  loadLyrics
}