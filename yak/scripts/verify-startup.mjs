import fs from 'fs'
import os from 'os'
import path from 'path'
import { execFileSync } from 'child_process'
import { fileURLToPath } from 'url'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const sourceRoot = path.resolve(scriptDir, '../..')
const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'yak-startup-repo-'))
const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yak-startup-home-'))
const configDir = path.join(homeDir, '.config', 'opencode')
fs.mkdirSync(configDir, { recursive: true })
fs.writeFileSync(path.join(configDir, 'opencode.json'), JSON.stringify({ plugin: [] }, null, 2))

function copyRecursive(src, dst) {
  const stat = fs.statSync(src)
  if (stat.isDirectory()) {
    fs.mkdirSync(dst, { recursive: true })
    for (const entry of fs.readdirSync(src)) {
      copyRecursive(path.join(src, entry), path.join(dst, entry))
    }
    return
  }
  fs.mkdirSync(path.dirname(dst), { recursive: true })
  fs.copyFileSync(src, dst)
}

copyRecursive(path.join(sourceRoot, 'plugins', 'yak.js'), path.join(configDir, 'plugins', 'yak.js'))
copyRecursive(path.join(sourceRoot, 'yak'), path.join(configDir, 'yak'))

execFileSync('git', ['init'], { cwd: repoRoot, stdio: 'ignore' })
fs.writeFileSync(path.join(repoRoot, '.gitignore'), '*\n')

const env = {
  ...process.env,
  HOME: homeDir,
  XDG_CONFIG_HOME: path.join(homeDir, '.config'),
  OPENCODE_CONFIG_DIR: configDir,
}

let output = ''
try {
  output = execFileSync('opencode', ['run', 'verify yak startup', '--print-logs', '--log-level', 'WARN'], {
    cwd: repoRoot,
    env,
    encoding: 'utf8',
    timeout: 30000,
  })
} catch (error) {
  output = `${error.stdout || ''}${error.stderr || ''}`
}

const planningRoot = path.join(repoRoot, '.agents', 'yak', 'projects')
const projectDir = fs.existsSync(planningRoot) ? fs.readdirSync(planningRoot).find((entry) => fs.statSync(path.join(planningRoot, entry)).isDirectory()) : null
if (!projectDir || !fs.existsSync(path.join(planningRoot, projectDir, 'project.md'))) {
  throw new Error(`Yak startup probe failed: missing project bootstrap under ${planningRoot}\n${output}`)
}

console.log(`Yak startup probe ok: ${path.join(planningRoot, projectDir, 'project.md')}`)
