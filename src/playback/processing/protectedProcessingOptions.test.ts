import assert from 'node:assert/strict'
import test from 'node:test'
import { VolumeTransformer } from './VolumeTransformer.ts'
import { protectedProcessingOptions } from './protectedProcessingOptions.ts'
test('Protected ramp is stereo-coherent, completes on time, and is chunk independent',()=>{
 const run=(sizes:number[])=>{
  const v=new VolumeTransformer({volume:0,enableAGC:false,fadeDurationMs:4,fadeCurve:'linear',sampleRate:1000,channels:2,lookaheadMs:0})
  v.setVolume(1)
  const parts=sizes.map(size=>{
   const chunk=Buffer.alloc(size*8)
   for(let i=0;i<chunk.length;i+=4)chunk.writeFloatLE(1,i)
   return v.processFloat32(chunk)
  })
  v.destroy()
  return Buffer.concat(parts)
 }
 const a=run([8]),b=run([1,2,1,4])
 assert.deepEqual(a,b)
 for(let i=0;i<8;i++){
  assert.equal(a.readFloatLE(i*8),a.readFloatLE(i*8+4))
  assert.equal(a.readFloatLE(i*8),Math.min(1,(i+1)/4))
 }
})
test('processing settings retain defaults and bound invalid configuration',()=>{
 assert.deepEqual(protectedProcessingOptions({targetLoudnessLufs:NaN,ceilingDbTP:0,lookaheadMs:Infinity,releaseMs:-1}),protectedProcessingOptions())
 assert.equal(protectedProcessingOptions({targetLoudnessLufs:-18,ceilingDbTP:-3,lookaheadMs:10,releaseMs:150,telemetry:true}).ceilingDbTP,-3)
})
