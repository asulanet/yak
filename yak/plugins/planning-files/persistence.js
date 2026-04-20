import fs from 'fs'
import crypto from 'crypto'

import { appendProgress, getProjectFilePath, writeMarkdown } from './session-store.js'
import { buildQuestionCandidate, classifyQuestionResolution } from './question-findings.js'

function ensureTrailingNewline(value) {
  return value.endsWith('\n') ? value : `${value}\n`
}

function formatTimestamp(now = Date.now()) {
  return new Date(now).toISOString()
}

function readText(filePath) {
  return fs.readFileSync(filePath, 'utf8')
}

function insertBulletIntoSection(content, heading, entry) {
  const headingLine = `## ${heading}`
  const lines = content.split(/\r?\n/)
  const headingIndex = lines.findIndex((line) => line.trim() === headingLine)

  if (headingIndex === -1) {
    while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop()
    lines.push('', headingLine, '', entry, '')
    return ensureTrailingNewline(lines.join('\n'))
  }

  let sectionEnd = lines.length
  for (let index = headingIndex + 1; index < lines.length; index += 1) {
    if (/^##\s+/.test(lines[index])) {
      sectionEnd = index
      break
    }
  }

  while (sectionEnd > headingIndex + 1 && lines[sectionEnd - 1].trim() === '') sectionEnd -= 1
  lines.splice(sectionEnd, 0, entry, '')
  return ensureTrailingNewline(lines.join('\n'))
}

function appendSectionBullet(filePath, heading, bulletText, dedupeKey) {
  const marker = `<!-- yak:${dedupeKey} -->`
  const current = readText(filePath)
  if (current.includes(marker)) return false
  const next = insertBulletIntoSection(current, heading, `- ${bulletText} ${marker}`)
  writeMarkdown(filePath, next)
  return true
}

export function rememberQuestionRequest(runtimeSession, request) {
  const candidate = buildQuestionCandidate(request)
  if (!candidate?.requestID) return null
  runtimeSession.pending_questions.set(candidate.requestID, candidate)
  return candidate
}

export function clearQuestionRequest(runtimeSession, requestID) {
  if (!runtimeSession?.pending_questions || !requestID) return
  runtimeSession.pending_questions.delete(requestID)
}

export function recordQuestionResolution({ projectDir, candidate, answers, now = Date.now() }) {
  const classification = classifyQuestionResolution(candidate, answers)
  if (!classification.capture) return { captured: false, reason: 'skipped-low-value' }

  const timestamp = formatTimestamp(now)
  const findingsPath = getProjectFilePath(projectDir, 'findings.md')
  const contextPath = getProjectFilePath(projectDir, 'context.md')
  const progressPath = getProjectFilePath(projectDir, 'progress.md')
  const dedupeHash = crypto.createHash('sha1').update(`${classification.questionText}\n${classification.answerText}`).digest('hex')
  const dedupeKey = `question:${dedupeHash}`
  const findingText = `${timestamp} — Question: "${classification.questionText}" Answer: "${classification.answerText}". Reason: ${classification.reason}.`
  const appended = appendSectionBullet(findingsPath, classification.section, findingText, dedupeKey)
  if (!appended) return { captured: false, reason: 'duplicate' }

  if (classification.contextRelevant) {
    appendSectionBullet(
      contextPath,
      'Clarifications',
      `${timestamp} — ${classification.answerText} (from: "${candidate.shortText}")`,
      `${dedupeKey}:context`,
    )
  }

  appendProgress(progressPath, [`- ${timestamp} Captured question resolution: ${candidate.shortText} -> ${classification.answerText}`])
  return { captured: true, section: classification.section, answerText: classification.answerText }
}
