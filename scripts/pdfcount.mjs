import { readFileSync } from 'node:fs'
import { PDFDocument } from 'pdf-lib'
const d = await PDFDocument.load(readFileSync(process.argv[2]))
console.log('pages:', d.getPageCount())
