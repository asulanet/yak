export function parseJsonc(source, filePath = 'jsonc') {
  let out = ''
  let i = 0
  let inString = false
  let quote = ''
  let inLineComment = false
  let inBlockComment = false

  while (i < source.length) {
    const ch = source[i]
    const next = source[i + 1]

    if (inLineComment) {
      if (ch === '\n') {
        inLineComment = false
        out += ch
      }
      i += 1
      continue
    }

    if (inBlockComment) {
      if (ch === '*' && next === '/') {
        inBlockComment = false
        i += 2
      } else {
        i += 1
      }
      continue
    }

    if (inString) {
      out += ch
      if (ch === '\\') {
        out += next || ''
        i += 2
        continue
      }
      if (ch === quote) inString = false
      i += 1
      continue
    }

    if (ch === '"' || ch === "'") {
      inString = true
      quote = ch
      out += ch
      i += 1
      continue
    }

    if (ch === '/' && next === '/') {
      inLineComment = true
      i += 2
      continue
    }

    if (ch === '/' && next === '*') {
      inBlockComment = true
      i += 2
      continue
    }

    out += ch
    i += 1
  }

  const stripped = out.replace(/,([\s\r\n]*[}\]])/g, '$1')
  try {
    return JSON.parse(stripped)
  } catch (error) {
    throw new Error(`Invalid JSONC in ${filePath}: ${error.message}`)
  }
}
