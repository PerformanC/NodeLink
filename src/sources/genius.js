import { makeRequest } from '../utils.js'

async function search(query) {
  const { body: data } = await makeRequest(`https://genius.com/api/search/multi?q=${encodeURIComponent(query)}`, {
    method: 'GET'
  })

  if (data.response.sections[1].hits.length == 0) return null

  return data.response.sections[1].hits[0].result.path
}

async function loadLyrics(decodedTrack, language) {
  const searchResult = await search(`${decodedTrack.title} ${decodedTrack.author}`)

  if (!searchResult) return null

  const { body: data } = await makeRequest(`https://genius.com${searchResult}`, {
    method: 'GET'
  })

  const trackInfo = JSON.parse(data.match(/JSON.parse\('(.*)'\);/)[1].replace(/\\(.)/g, '$1'))

  const lyricsEvents = []
  trackInfo.songPage.lyricsData.body.children[0].children.map((text) => {
    if (typeof text == 'object') {
      if (!text.children) return;

      text.children.forEach((child) => {
        if (typeof child != 'string') return;

        lyricsEvents.push({
          text: child
        })
      })

      return;
    }

    lyricsEvents.push({
      text
    })
  })

  return {
    loadType: 'lyricsSingle',
    data: {
      name: 'original',
      synced: false,
      data: lyricsEvents,
      rtl: false
    }
  }
}

export default {
  loadLyrics
}