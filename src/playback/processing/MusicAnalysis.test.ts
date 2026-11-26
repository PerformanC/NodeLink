import assert from 'node:assert/strict'
import test from 'node:test'
import { MusicAnalysis } from './MusicAnalysis.ts'
test('silent output reports coverage without inventing tempo or key',()=>{
 const tap=new MusicAnalysis()
 const audio=Buffer.alloc(3840*200)
 const chunks:Buffer[]=[]
 tap.on('data',chunk=>chunks.push(chunk))
 tap.write(audio.subarray(0,3));tap.end(audio.subarray(3))
 assert.deepEqual(Buffer.concat(chunks),audio)
 const result=tap.snapshot()
 assert.ok(result)
 assert.equal(result.analyzedMs,4000)
 assert.equal(result.silenceRatio,1)
 assert.equal(result.bpm,null)
 assert.equal(result.key,null)
 assert.deepEqual(result.beatPositionsMs,[])
})
test('analysis rolls over bounded windows without resetting the output clock',()=>{
 const tap=new MusicAnalysis()
 tap.resume()
 const frame=Buffer.alloc(3840)
 for(let i=0;i<800;i++)tap.write(frame)
 const result=tap.snapshot()
 assert.equal(result?.outputWindowStartMs,12000)
 assert.equal(result?.outputWindowEndMs,16000)
 assert.equal(result?.analyzedMs,4000)
 tap.destroy()
})
