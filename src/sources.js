import utils from './utils.js'

function setIntervalNow(func, interval) {
  func()
  return setInterval(func, interval)
}

function innertubeStart(func) {
  let playerInfo = {}

  const interval = setIntervalNow(async () => {
    console.log('[NodeLink]: Fetching YouTube embed page...')
  
    const data = await utils.nodelink_makeRequest('https://www.youtube.com/embed', { method: 'GET' }).catch((err) => {
      console.log(`[NodeLink]: Failed to fetch innertube data: ${err.message}`)
    })
      
    const innertube = JSON.parse('{' + data.split('ytcfg.set({')[1].split('});')[0] + '}')
    playerInfo.innertube = innertube.INNERTUBE_CONTEXT
    playerInfo.innertube.client.clientName = 'WEB',
    playerInfo.innertube.client.clientVersion = '2.20230316.00.00'
    playerInfo.innertube.client.originalUrl = 'https://www.youtube.com/'

    console.log('[NodeLink]: Sucessfully extracted InnerTube Context. Fetching player.js...')

    const player = await utils.nodelink_makeRequest(`https://www.youtube.com${innertube.WEB_PLAYER_CONTEXT_CONFIGS.WEB_PLAYER_CONTEXT_CONFIG_ID_EMBEDDED_PLAYER.jsUrl}`, { method: 'GET' }).catch((err) => {
      console.log(`[NodeLink]: Failed to fetch player js: ${err.message}`)
    })

    console.log('[NodeLink]: Fetch player.js from YouTube.')
  
    playerInfo.signatureTimestamp = /(?<=signatureTimestamp:)[0-9]+/gm.exec(player)[0]
  
    let dFunctionHighLevel = player.split('a.set("alr","yes");c&&(c=')[1].split('(decodeURIC')[0]
    dFunctionHighLevel = ('function decipher(a)' + player.split(`${dFunctionHighLevel}=function(a)`)[1].split(')};')[0] + ')};')
    let decipherLowLevel = player.split('this.audioTracks};')[1].split(')};var ')[1].split(')}};')[0]

    playerInfo.decipherEval = `const ${decipherLowLevel})}};${dFunctionHighLevel}decipher('NODELINK_DECIPHER_URL');`

    func(playerInfo)

    console.log('[NodeLink]: Successfully processed information for next loadtracks and play.')
  }, 120000)

  return interval
}

export default { innertubeStart }