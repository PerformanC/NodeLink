import assert from 'node:assert/strict'
import test from 'node:test'
import { autoMixTrackKey,trailingSilenceStart,safeAutoMixEnd } from './autoMixSafety.ts'
import type { TrackPreAnalysisProfile } from './MusicalAnalyzer.ts'
const key=(sourceName:string,audioTrackId?:string)=>autoMixTrackKey({info:{sourceName,identifier:'123',length:100000},audioTrackId})
test('cache keys distinguish providers and audio renditions',()=>{
 assert.notEqual(key('tidal'),key('deezer'))
 assert.notEqual(key('youtube','a'),key('youtube','b'))
 assert.equal(key('tidal'),key('tidal'))
})
const point=(timestampMs:number,isSilence:boolean)=>({timestampMs,isSilence,rms:isSilence?0:0.5,peak:0.5,bands:{low:0,mid:0,high:0},onset:false,beat:false,vocalActivity:0,confidence:1})
test('short or discontinuous silence and silent-only windows are not endings',()=>{
 const points=Array.from({length:100},(_,i)=>point(i*20,i>=50))
 assert.equal(trailingSilenceStart(points),1000)
 assert.equal(trailingSilenceStart(points.slice(50)),null)
 assert.equal(trailingSilenceStart([point(0,false),point(1000,true),point(3000,true)]),null)
 assert.equal(trailingSilenceStart([point(0,false),point(20,true),point(40,false)]),null)
})
test('only a verified near-end silent tail may shorten an untrimmed track',()=>{
 const profile={analysisVersion:3,outroProfile:{naturalOutroPointMs:98000,analyzedWindowStartMs:90000,analyzedWindowEndMs:100000,analysisConfidence:0.85,sourceEndRms:0.001}} as TrackPreAnalysisProfile
 assert.equal(safeAutoMixEnd(100000,profile,false),98000)
 assert.equal(safeAutoMixEnd(100000,profile,true),100000)
 assert.equal(safeAutoMixEnd(100000,{...profile,analysisVersion:2},false),100000)
 const outro=profile.outroProfile
 assert.ok(outro)
 assert.equal(safeAutoMixEnd(100000,{...profile,outroProfile:{...outro,analyzedWindowEndMs:95000}},false),100000)
 assert.equal(safeAutoMixEnd(100000,{...profile,outroProfile:{...outro,naturalOutroPointMs:50000}},false),100000)
})
