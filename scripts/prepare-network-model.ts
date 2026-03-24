import { prepareModelSnapshot } from '../netlify/functions/lib/data.ts'

const start = Date.now()

prepareModelSnapshot()
  .then((outputPath) => {
    console.log(`Network snapshot written to ${outputPath} in ${Date.now() - start}ms`)
  })
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
