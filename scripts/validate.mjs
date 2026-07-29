// Validates every poems/*.md file. Runs in CI on each pull request.
//
// Dependency-free on purpose: contributors edit these files through the GitHub
// web UI, and a lockfile plus install step would be pure overhead for a check
// that is a few hundred lines of string handling.
//
// What this cannot check: whether a slug actually exists in PoemDeck. That would
// need database credentials, which do not belong in a public repository. The
// submission endpoint verifies it before opening a pull request, and the sync
// pipeline reports unmatched slugs in its plan.
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const POEMS_DIR = 'poems'

const SECTIONS = {
  正文: 'list',
  拼音: 'list',
  注释: 'pairs',
  译文: 'prose',
  赏析: 'prose',
}

const LIMITS = {
  line: 200,
  prose: 20_000,
  glossTerm: 40,
  gloss: 500,
  lines: 400,
  annotations: 300,
}

// Any link is spam here: corrections are text about a poem, and an accepted
// pull request would otherwise become a permanent backlink.
const URL_PATTERN = /(https?:\/\/|www\.|\b[\w-]+\.(com|net|org|cn|io|xyz|top|shop)\b)/i
const CJK_PATTERN = /[㐀-䶿一-鿿豈-﫿]/
const SLUG_PATTERN = /^[a-z0-9-]+$/

const problems = []

function fail(file, message) {
  problems.push(`${file}: ${message}`)
}

function parse(contents) {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(contents)
  const body = frontmatter ? contents.slice(frontmatter[0].length) : contents
  const meta = {}
  if (frontmatter) {
    for (const line of frontmatter[1].split('\n')) {
      const match = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line.trim())
      if (match) meta[match[1]] = match[2].trim()
    }
  }

  const sections = new Map()
  let current = null
  for (const line of body.split('\n')) {
    const heading = /^##\s+(.+?)\s*$/.exec(line)
    if (heading) {
      current = heading[1]
      if (sections.has(current)) return { meta, sections, duplicate: current }
      sections.set(current, [])
      continue
    }
    if (current) sections.get(current).push(line)
    else if (line.trim()) return { meta, sections, strayText: line.trim() }
  }

  return { meta, sections }
}

const bullets = (lines) =>
  lines.map((line) => /^\s*-\s+(.*)$/.exec(line)?.[1]?.trim() ?? '').filter((item) => item !== '')

function checkText(file, label, value, limit) {
  if (value.length > limit) fail(file, `${label} exceeds ${limit} characters`)
  if (URL_PATTERN.test(value)) fail(file, `${label} contains a link, which is not accepted`)
  if (!CJK_PATTERN.test(value)) fail(file, `${label} contains no Chinese text`)
}

if (!existsSync(POEMS_DIR)) {
  console.log('No poems/ directory; nothing to validate.')
  process.exit(0)
}

const files = readdirSync(POEMS_DIR).filter((name) => name.endsWith('.md')).sort()

for (const name of files) {
  const file = `${POEMS_DIR}/${name}`
  const slug = name.slice(0, -'.md'.length)

  if (!SLUG_PATTERN.test(slug)) {
    fail(file, 'filename must be a slug of lowercase letters, digits and hyphens')
    continue
  }

  const { meta, sections, duplicate, strayText } = parse(readFileSync(file, 'utf8'))

  if (duplicate) fail(file, `section "${duplicate}" appears more than once`)
  if (strayText) fail(file, `text outside any section: "${strayText.slice(0, 40)}"`)
  if (meta.slug && meta.slug !== slug) fail(file, `frontmatter slug "${meta.slug}" does not match the filename`)

  const unknown = [...sections.keys()].filter((heading) => !(heading in SECTIONS))
  if (unknown.length) fail(file, `unknown section(s): ${unknown.join(', ')}. Allowed: ${Object.keys(SECTIONS).join(', ')}`)

  const filled = [...sections.entries()].filter(([, lines]) => lines.some((line) => line.trim()))
  if (!filled.length) fail(file, 'no section has any content; an empty file corrects nothing')

  for (const [heading, lines] of filled) {
    const kind = SECTIONS[heading]
    if (!kind) continue

    if (kind === 'list') {
      const items = bullets(lines)
      if (!items.length) fail(file, `${heading} must use "- " list items`)
      if (items.length > LIMITS.lines) fail(file, `${heading} has more than ${LIMITS.lines} lines`)
      items.forEach((item, index) => {
        if (item.length > LIMITS.line) fail(file, `${heading} line ${index + 1} exceeds ${LIMITS.line} characters`)
        if (URL_PATTERN.test(item)) fail(file, `${heading} line ${index + 1} contains a link`)
      })
      if (heading === '正文' && !items.some((item) => CJK_PATTERN.test(item))) {
        fail(file, '正文 contains no Chinese text')
      }
      continue
    }

    if (kind === 'pairs') {
      const items = bullets(lines)
      if (!items.length) fail(file, '注释 must use "- 词: 解释" list items')
      if (items.length > LIMITS.annotations) fail(file, `注释 has more than ${LIMITS.annotations} entries`)
      for (const item of items) {
        const separator = item.search(/[:：]/)
        if (separator === -1) {
          fail(file, `注释 entry "${item.slice(0, 24)}" is missing a colon`)
          continue
        }
        const term = item.slice(0, separator).trim()
        const gloss = item.slice(separator + 1).trim()
        if (!term || !gloss) fail(file, `注释 entry "${item.slice(0, 24)}" has an empty term or gloss`)
        if (term.length > LIMITS.glossTerm) fail(file, `注释 term "${term.slice(0, 24)}" is too long`)
        if (gloss.length > LIMITS.gloss) fail(file, `注释 gloss for "${term}" exceeds ${LIMITS.gloss} characters`)
        if (URL_PATTERN.test(item)) fail(file, `注释 entry for "${term}" contains a link`)
      }
      continue
    }

    checkText(file, heading, lines.join('\n').trim(), LIMITS.prose)
  }

  // Pinyin is positional: a mismatch would misalign every line after the gap.
  const body = sections.get('正文')
  const pinyin = sections.get('拼音')
  if (body && pinyin) {
    const bodyCount = bullets(body).length
    const pinyinCount = bullets(pinyin).length
    if (bodyCount !== pinyinCount) {
      fail(file, `拼音 has ${pinyinCount} lines but 正文 has ${bodyCount}; they must match`)
    }
  }
}

console.log(`Checked ${files.length} correction file(s).`)

if (problems.length) {
  console.error(`\n${problems.length} problem(s) found:\n`)
  for (const problem of problems) console.error(`  ✗ ${problem}`)
  console.error('\nSee README.md for the expected format.')
  process.exit(1)
}

console.log('All good.')
