import { writeFileSync } from 'node:fs'
import { zeroAddress } from 'viem'
import { encodeBlob, guard } from '../src/index.js'
import { S, SEAL, cases } from '../test/cases.js'

export function buildVectors() {
  return {
    vectors: cases.map((c) => {
      const got = guard(c.frames, S, SEAL, c.permit2)
      if (got.code !== c.code || got.at !== c.at) throw new Error(`${c.name}: ts guard ${got.code}@${got.at}, want ${c.code}@${c.at}`)
      return { at: c.at, blob: encodeBlob(c.frames, S), code: c.code, name: c.name, permit2: c.permit2 ?? zeroAddress, seal: SEAL, sender: S }
    }),
  }
}

if (import.meta.main) {
  const out = new URL('../../../vectors/guard.json', import.meta.url)
  writeFileSync(out, JSON.stringify(buildVectors(), null, 1) + '\n')
  console.log(`wrote ${buildVectors().vectors.length} vectors`)
}
