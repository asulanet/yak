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

// Regex patterns identifying Question shapes that are NOT phase-gate approvals.
// These take priority over gate detection so (a) new-batch confirmations don't
// get interpreted as phase approvals, and (b) incomplete-task policy prompts
// (abandon/carry/cancel) don't accidentally trigger gates. This defends
// against the gate-regex collision bug where a phase2 approval Question body
// containing the phrase "authorize execution" was mis-routed to the execution
// gate, silently approving execution of a stale task set. See findings.md +
// batch-summary.md entries dated 2026-04-21 for the original incident.
const NON_GATE_QUESTION_PATTERNS = [
  /\bnew\s*-?\s*batch\b/i,             // "new batch" / "new-batch"
  /\bstart\s+batch\s+\d/i,              // "start batch 2" / "Start batch N+1"
  /\bnext\s+batch\b/i,                  // "next batch"
  /\bkeep\s+adding\s+to\s+current/i,    // auto-detect "Keep adding to current batch"
  /\b(abandon|carry|cancel)\b.*\btasks?\b/i, // incomplete-task policy
  /\btasks?\b.*\b(abandon|carry|cancel)\b/i,
]

const PHASE2_GATE_PATTERN = /\b(phase\s*2|task review|task graph|task approval|approve tasks|approve task set|approve dag)\b/i
const PHASE1_GATE_PATTERN = /\b(phase\s*1|workflow approval|design approval|discovery approval|scope approval|approve (the )?(plan|design|scope|workflow))\b/i
const EXECUTION_GATE_PATTERN = /\b(execution|start coding|allow coding|allow implementation|begin implementation|authorize execution|run the approved tasks)\b/i

export function detectGateRequest(candidate, _currentFrontmatter = {}) {
  const headerText = normalizeWhitespace((candidate?.questions || []).map((item) => item.header).filter(Boolean).join(' '))
  const questionText = normalizeWhitespace(candidate?.text)
  const combined = `${headerText} ${questionText}`.trim()

  // Non-gate Questions short-circuit gate detection entirely. This avoids
  // the situation where a Question legitimately about new-batch flow or
  // incomplete-task policy gets routed to a phase gate because it happens to
  // mention one of the gate keywords as prose.
  for (const pattern of NON_GATE_QUESTION_PATTERNS) {
    if (pattern.test(combined)) return null
  }

  // Priority: phase1 > phase2 > execution. The most specific / earliest-in-
  // workflow gate wins when multiple match. Phase1 first protects against a
  // phase1 Question whose body mentions "task graph" from being mis-routed
  // to phase2. Phase2 then wins over execution to defend against the
  // historical bug where phase2-approval Questions mentioning "authorize
  // execution" in description prose got routed to the execution gate,
  // auto-approving execution of a stale task set.
  if (PHASE1_GATE_PATTERN.test(combined)) {
    return { gate: 'phase1', subphase: 'phase1_approval' }
  }
  if (PHASE2_GATE_PATTERN.test(combined)) {
    return { gate: 'phase2', subphase: 'phase2_approval' }
  }
  if (EXECUTION_GATE_PATTERN.test(combined)) {
    return { gate: 'execution', subphase: 'execution_authorization' }
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
