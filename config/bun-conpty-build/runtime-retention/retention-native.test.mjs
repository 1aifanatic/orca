import {it, expect} from 'bun:test'
import {qualifyRetention} from './retention-native.js'
it('qualifies actual retention against native Windows process identity', async()=>{
 const receipt=await qualifyRetention()
 console.log('RETENTION_NATIVE_PROOF',JSON.stringify(receipt))
 expect(receipt.passed).toBe(true)
},45000)
