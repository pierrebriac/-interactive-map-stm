import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { prepareModelSnapshot } from '../netlify/functions/lib/data.ts'

const start = Date.now()
const args = new Set(process.argv.slice(2))
const snapshotPath = resolve(process.cwd(), 'generated/network-model.json')
const reuseSnapshot = args.has('--if-missing') && existsSync(snapshotPath)

if (reuseSnapshot) {
  console.log(`Reusing existing network snapshot at ${snapshotPath}`)
  process.exit(0)
}

prepareModelSnapshot()
  .then((outputPath) => {
    console.log(`Network snapshot written to ${outputPath} in ${Date.now() - start}ms`)
  })
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
