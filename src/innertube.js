let playerInfo = {}

import utils from './utils.js'

async function setIntervalNow(func, interval) {
  await func()
  setInterval(func, interval)
}

setIntervalNow(async () => {
  console.log('[NodeLink]: Updating player info...')
  
  const data = await utils.nodelink_makeRequest('https://www.youtube.com/', { method: 'GET' }).catch((err) => {
    console.log(`[NodeLink]: Failed to fetch innertube data: ${err.message}`)
  })
      
  playerInfo.innertube = JSON.parse('{' + data.split('ytcfg.set({')[1].split('});')[0] + '}')
  
  const player = await utils.nodelink_makeRequest(`https://www.youtube.com/s/player/${/\/s\/player\/(\w+)\/player_ias\.vflset\/[^\/]+\/base\.js/.exec(playerInfo.innertube.PLAYER_JS_URL)[1]}/player_ias.vflset/en_US/base.js`).catch((err) => {
    console.log(`[NodeLink]: Failed to fetch player js: ${err.message}`)
  })
  
  playerInfo.signatureTimestamp = /(?<=signatureTimestamp:)[0-9]+/gm.exec(player)[0]
  
  let dFunctionHighLevel = player.split('a.set("alr","yes");c&&(c=')[1].split('(decodeURIC')[0]
  dFunctionHighLevel = ('function decipher(a)' + player.split(`${dFunctionHighLevel}=function(a)`)[1].split(')};')[0] + ')};')
  let decipherLowLevel = player.split('this.audioTracks};')[1]
  let dFunctionNameLL = decipherLowLevel.split('var ')[1].split('=')[0]
  decipherLowLevel = ('{' + (decipherLowLevel.split('={')[1]).split('}};')[0] + '}}').split('').join('')
  
  playerInfo.decipherEval = `let ${dFunctionNameLL} = ${decipherLowLevel};${dFunctionHighLevel}decipher('NODELINK_DECIPHER_URL');`
  
  console.log('[NodeLink]: Updating player info done.')
}, 120000)

export default playerInfo