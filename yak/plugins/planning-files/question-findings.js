const LOW_VALUE_PATTERNS = [
  /\bprefer\b.*\b(bullets|numbers|numbering|emoji|wording|phrasing|tone|style)\b/i,
  /\bfor this one response\b/i,
  /\bhow should i format this response\b/i,
]

const MANDATORY_PATTERNS = [
  /\brequirements?\b/i,
  /\bscope\b/i,
  /\bconstraint\b/i,
  /\bproject state\b/i,
  /\bworkflow\b/i,
  /\bapproval\b/i,
  /\bpolicy\b/i,
  /\brule\b/i,
  /\bmust\b/i,
  /\balways\b/i,
  /\bnever\b/i,
  /\bfindings?\b/i,
  /\bcontext\b/i,
  /\bdocs?\b/i,
  /\btimeout\b/i,
  /\bconfig\b/i,
  /\btask\b/i,
  /\bpath\b/i,
  /\bfile\b/i,
  /\bproject\b/i,
  /\breuse\b/i,
  /\bclarification\b/i,
  /\bcorrection\b/i,
  /\bwrong assumption\b/i,
]

const CONTEXT_PATTERNS = [
  /\bworkflow\b/i,
  /\bapproval\b/i,
  /\bpolicy\b/i,
  /\brule\b/i,
  /\bconstraint\b/i,
  /\bmust\b/i,
  /\balways\b/i,
  /\bnever\b/i,
  /\bconfig\b/i,
  /\btimeout\b/i,
  /\bpath\b/i,
  /\bfile\b/i,
  /\bproject\b/i,
  /\bcontext\b/i,
]

function normalizeWhitespace(value) {
  return String(value || '').replace(/\s+/g, ' ').trim()
}

export function extractTextFromParts(parts = []) {
  return normalizeWhitespace(parts.map((part) => {
    if (!part || typeof part !== 'object') return ''
    if (typeof part.text === 'string') return part.text
    if (typeof part.content === 'string') return part.content
    return ''
  }).filter(Boolean).join(' '))
}

export function flattenQuestionAnswers(answers = []) {
  return answers
    .flatMap((answer) => Array.isArray(answer) ? answer : [answer])
    .map((answer) => normalizeWhitespace(answer))
    .filter(Boolean)
    .join('; ')
}

export function buildQuestionCandidate(request = {}) {
  const questions = Array.isArray(request.questions) ? request.questions : []
  const text = questions
    .map((item) => normalizeWhitespace(item?.question))
    .filter(Boolean)
    .join(' / ')

  if (!text) return null

  return {
    requestID: request.id || request.requestID || null,
    sessionID: request.sessionID || null,
    questions: questions.map((item) => ({
      header: normalizeWhitespace(item?.header),
      question: normalizeWhitespace(item?.question),
    })),
    text,
    shortText: text.length > 160 ? `${text.slice(0, 157)}...` : text,
  }
}

function matchesAny(patterns, value) {
  return patterns.some((pattern) => pattern.test(value))
}

function chooseSection(combinedText) {
  if (/\b(issue|problem|bug|timeout|stale|missing|wrong assumption|correction)\b/i.test(combinedText)) return 'Issues Encountered'
  if (/\b(decision|rule|policy|workflow|approval|constraint|must|always|never)\b/i.test(combinedText)) return 'Technical Decisions'
  return 'Requirements'
}

function isAffirmativeApproval(answerText) {
  return /\b(approve|approved|yes|start|proceed|allow|ok|okay)\b/i.test(answerText)
}

export function detectGateRequest(candidate, _currentFrontmatter = {}) {
  const headerText = normalizeWhitespace((candidate?.questions || []).map((item) => item.header).filter(Boolean).join(' '))
  const questionText = normalizeWhitespace(candidate?.text)
  const combined = `${headerText} ${questionText}`.trim()

  if (/\b(execution|start coding|allow coding|allow implementation|begin implementation|authorize execution|run the approved tasks)\b/i.test(combined)) {
    return { gate: 'execution', subphase: 'execution_authorization' }
  }

  if (/\b(phase\s*2|task review|task graph|task approval|approve tasks|approve task set|approve dag)\b/i.test(combined)) {
    return { gate: 'phase2', subphase: 'phase2_approval' }
  }

  if (/\b(phase\s*1|workflow approval|design approval|discovery approval|scope approval|approve (the )?(plan|design|scope|workflow))\b/i.test(combined)) {
    return { gate: 'phase1', subphase: 'phase1_approval' }
  }

  return null
}

export function detectGateApproval(candidate, answers = [], currentFrontmatter = {}) {
  const request = detectGateRequest(candidate, currentFrontmatter)
  const answerText = flattenQuestionAnswers(answers)
  if (!request || !isAffirmativeApproval(answerText)) return null
  return { ...request, answerText }
}

export function classifyQuestionResolution(candidate, answers = []) {
  const answerText = flattenQuestionAnswers(answers)
  const questionText = normalizeWhitespace(candidate?.text)
  const combinedText = `${questionText} ${answerText}`.trim()
  if (!combinedText) return { capture: false, answerText: '' }

  const lowValue = matchesAny(LOW_VALUE_PATTERNS, combinedText)
  const mandatory = matchesAny(MANDATORY_PATTERNS, combinedText)
  if (lowValue && !mandatory) return { capture: false, answerText, questionText }

  return {
    capture: true,
    questionText,
    answerText,
    section: chooseSection(combinedText),
    contextRelevant: matchesAny(CONTEXT_PATTERNS, combinedText),
    reason: mandatory ? 'mandatory-technical-clarification' : 'reusable-clarification',
  }
}

export function looksLikeFreeformQuestion(text) {
  const normalized = normalizeWhitespace(text)
  if (!normalized) return false
  if (!/\?$/.test(normalized) && !/\?\s*$/.test(normalized.split(/\n/).filter(Boolean).at(-1) || '')) return false
  return /\b(what|which|should|do|does|did|can|could|would|will|where|when|why|how|is|are)\b/i.test(normalized)
}
