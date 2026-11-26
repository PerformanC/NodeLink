import assert from 'node:assert/strict'
import test from 'node:test'
import { buildPlaybackLyrics, activeLyricsIndices } from './playbackLyrics.ts'
test('event payload retains independent voices and alternates',()=>{
 const lines=buildPlaybackLyrics({synced:true,lines:[{text:'Lead',time:1000,duration:2000,agent:'a',alternatives:[{kind:'translation',text:'Hola'}]},{text:'Echo',time:1500,duration:1000,agent:'b',isBackground:true}]})
 assert.deepEqual(activeLyricsIndices(lines,1600),[0,1])
 assert.deepEqual(activeLyricsIndices(lines,2700),[0])
 assert.deepEqual(activeLyricsIndices(lines,3000),[])
 assert.equal(lines[1]?.plugin.agent,'b')
 assert.deepEqual(lines[0]?.plugin.alternatives,[{kind:'translation',text:'Hola'}])
})
test('preserves unknown duration and avoids inventing timing for unsynced text',()=>{
 const lines=buildPlaybackLyrics({synced:false,lines:[{text:'First',time:2000,duration:0},{text:'Second',time:1000,duration:0}]})
 assert.equal(lines[0]?.line,'First')
 assert.equal(lines[0]?.duration,0)
})
