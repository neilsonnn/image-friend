#!/usr/bin/env node
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const DEFAULT_TIMEOUT_MS = 30_000

function usage() {
  console.log(`CADbuildr Prototype MCP bridge for image-blaster

Usage:
  node .claude/scripts/cadbuildr/prototype-mcp.mjs status
  node .claude/scripts/cadbuildr/prototype-mcp.mjs tools
  node .claude/scripts/cadbuildr/prototype-mcp.mjs call <tool> [json-args]
  node .claude/scripts/cadbuildr/prototype-mcp.mjs open-workspace <path>
  node .claude/scripts/cadbuildr/prototype-mcp.mjs run-python-file <path>
  node .claude/scripts/cadbuildr/prototype-mcp.mjs subagent <prompt-file-or-text> [--timeout-s N]
  node .claude/scripts/cadbuildr/prototype-mcp.mjs chess-demo [--workspace <path>] [--world <slug>] [--dry-run]

Discovery:
  CADBUILDR_PROTOTYPE_MCP_URL=http://127.0.0.1:<port>/mcp
  CADBUILDR_PROTOTYPE_MCP_DISCOVERY=/path/to/prototype-mcp.json

The desktop app writes prototype-mcp.json while it is running. On macOS this is
usually ~/Library/Application Support/com.cadbuildr.prototype/prototype-mcp.json;
on Linux it is usually ~/.local/share/com.cadbuildr.prototype/prototype-mcp.json.`)
}

function repoRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
}

function candidateDiscoveryPaths() {
  const home = os.homedir()
  return [
    process.env.CADBUILDR_PROTOTYPE_MCP_DISCOVERY,
    path.join(home, 'Library/Application Support/com.cadbuildr.prototype/prototype-mcp.json'),
    path.join(home, '.local/share/com.cadbuildr.prototype/prototype-mcp.json'),
    path.join(home, '.config/com.cadbuildr.prototype/prototype-mcp.json'),
    path.join(home, '.local/share/CADbuildr Prototype/prototype-mcp.json'),
  ].filter(Boolean)
}

function readDiscovery() {
  if (process.env.CADBUILDR_PROTOTYPE_MCP_URL) {
    return { url: process.env.CADBUILDR_PROTOTYPE_MCP_URL, source: 'CADBUILDR_PROTOTYPE_MCP_URL' }
  }

  for (const candidate of candidateDiscoveryPaths()) {
    try {
      if (!fs.existsSync(candidate)) continue
      const data = JSON.parse(fs.readFileSync(candidate, 'utf8'))
      const url = data.url ?? data.mcp_url ?? data.base_url
      if (typeof url === 'string' && url.startsWith('http')) {
        return { ...data, url, source: candidate }
      }
    } catch (error) {
      throw new Error(`Failed to read CADBuildr Prototype MCP discovery file ${candidate}: ${error.message}`)
    }
  }

  throw new Error(
    'CADBuildr Prototype MCP endpoint not found. Start the CADBuildr Prototype desktop app, open Settings, or set CADBUILDR_PROTOTYPE_MCP_URL.',
  )
}

function parseSse(text) {
  const blocks = text.split(/\n\n+/)
  for (const block of blocks) {
    const dataLines = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
    if (!dataLines.length) continue
    const data = dataLines.join('\n')
    if (data === '[DONE]') continue
    try {
      return JSON.parse(data)
    } catch {
      // Keep looking. Some transports send comments/heartbeats before JSON.
    }
  }
  throw new Error(`MCP server returned SSE without a JSON data event: ${text.slice(0, 500)}`)
}

async function readMcpResponse(response) {
  const contentType = response.headers.get('content-type') ?? ''
  const text = await response.text()
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from MCP server: ${text.slice(0, 1000)}`)
  }
  if (!text.trim()) return null
  if (contentType.includes('text/event-stream')) return parseSse(text)
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new Error(`MCP server returned non-JSON response (${contentType}): ${text.slice(0, 500)} (${error.message})`)
  }
}

class StreamableHttpMcpClient {
  constructor(url) {
    this.url = url
    this.nextId = 1
    this.sessionId = undefined
  }

  async post(payload, timeoutMs = DEFAULT_TIMEOUT_MS) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const headers = {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      }
      if (this.sessionId) headers['mcp-session-id'] = this.sessionId
      const response = await fetch(this.url, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: controller.signal,
      })
      const sessionId = response.headers.get('mcp-session-id')
      if (sessionId) this.sessionId = sessionId
      return await readMcpResponse(response)
    } finally {
      clearTimeout(timer)
    }
  }

  async request(method, params, timeoutMs) {
    const id = this.nextId++
    const response = await this.post({ jsonrpc: '2.0', id, method, params }, timeoutMs)
    if (response?.error) {
      throw new Error(`${method} failed: ${JSON.stringify(response.error)}`)
    }
    return response?.result
  }

  async notify(method, params) {
    await this.post({ jsonrpc: '2.0', method, params })
  }

  async initialize() {
    await this.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'image-blaster-cadbuildr-bridge', version: '0.1.0' },
    })
    await this.notify('notifications/initialized', {})
  }

  async listTools() {
    return this.request('tools/list', {})
  }

  async callTool(name, args = {}, timeoutMs) {
    return this.request('tools/call', { name, arguments: args }, timeoutMs)
  }
}

function parseJsonArg(value) {
  if (!value) return {}
  try {
    return JSON.parse(value)
  } catch (error) {
    throw new Error(`Expected JSON args, got: ${value}\n${error.message}`)
  }
}

function textFromToolResult(result) {
  const content = result?.content
  if (!Array.isArray(content)) return JSON.stringify(result, null, 2)
  return content.map((part) => {
    if (part.type === 'text') return part.text
    if (part.type === 'image') return `[image ${part.mimeType ?? ''} ${part.data?.length ?? 0} base64 chars]`
    return JSON.stringify(part)
  }).join('\n')
}

function promptTextFromFileOrLiteral(value) {
  const resolved = path.resolve(value)
  if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
    return fs.readFileSync(resolved, 'utf8')
  }
  return value
}

function optionValue(argv, flag, fallback) {
  const index = argv.indexOf(flag)
  if (index === -1) return fallback
  return argv[index + 1] ?? fallback
}

async function createChessWorkspace(workspacePath, worldSlug) {
  fs.mkdirSync(workspacePath, { recursive: true })
  const prompt = `Use CADBuildr's chess-piece examples/library to create a small product-shot scene for GitHub Pages.

Goal:
- Create a wooden table and a chair in CADBuildr.
- Place a CADBuildr chess set on top of the table. Use the CADBuildr chess library/examples for the pieces (king, queen, rook, bishop, knight, pawn) rather than hand-waving simple cylinders.
- Export the table, chair, board, and chess pieces as web-friendly assets (prefer GLB where the Prototype supports it).
- Use the image-blaster world \"${worldSlug}\" as the surrounding world, ideally a cool forest-like World Labs environment.
- Produce a static web page that can be hosted on GitHub Pages. It should load the image-blaster world and put the CADBuildr chess scene on the table.

Implementation notes:
- Keep generated CAD source in this workspace.
- Prefer a simple static site under ./site with index.html and local assets.
- If the image-blaster world assets are in ../worlds/${worldSlug}, copy or reference only web-hostable local files.
- Make the result self-contained enough to publish to GitHub Pages from the chess CADBuildr repo.
- After each CAD run, use the Prototype MCP screenshot tool to verify the viewer rather than assuming it worked.
`

  const readme = `# CADBuildr + image-blaster chess-world workspace

This workspace is generated by image-blaster's CADBuildr Prototype MCP bridge.

## Intended flow

1. Start CADBuildr Prototype desktop app and sign in with real model access.
2. Run from image-blaster:

   \`\`\`sh
   node .claude/scripts/cadbuildr/prototype-mcp.mjs chess-demo --workspace ${workspacePath} --world ${worldSlug}
   \`\`\`

3. The bridge opens this folder in Prototype and prompts its MCP \`subagent\` tool with \`PROMPT.md\`.
4. The agent should create CADBuildr files and a GitHub-Pages-ready static site.

## Prompt

See [PROMPT.md](PROMPT.md).
`

  const starter = `from cadbuildr.foundation import *

# Starter file for CADBuildr Prototype.
# The Prototype subagent should replace or extend this into a full scene using
# the CADBuildr chess examples/library plus table/chair geometry, then export
# web-ready assets for the image-blaster viewer/GitHub Pages site.

# Tip for the agent: CADbuildr chess examples live in the monorepo under:
# tsjs/packages/others/data/src/foundation_ex/parts/chess_parts/

show(Part())
`

  fs.writeFileSync(path.join(workspacePath, 'PROMPT.md'), prompt)
  fs.writeFileSync(path.join(workspacePath, 'README.md'), readme)
  fs.writeFileSync(path.join(workspacePath, 'cadbuildr_chess_scene.py'), starter)
  fs.mkdirSync(path.join(workspacePath, 'site', 'assets'), { recursive: true })
  return { workspacePath, promptPath: path.join(workspacePath, 'PROMPT.md') }
}

async function main() {
  const [command, ...argv] = process.argv.slice(2)
  if (!command || command === '-h' || command === '--help') {
    usage()
    return
  }

  if (command === 'chess-demo' && argv.includes('--dry-run')) {
    const workspace = path.resolve(optionValue(argv, '--workspace', path.join(repoRoot(), 'cadbuildr-chess-world-workspace')))
    const world = optionValue(argv, '--world', 'forest-chess-world')
    const created = await createChessWorkspace(workspace, world)
    console.log(JSON.stringify({ dryRun: true, ...created }, null, 2))
    return
  }

  const discovery = readDiscovery()
  const client = new StreamableHttpMcpClient(discovery.url)
  await client.initialize()

  if (command === 'status') {
    const result = await client.callTool('get_workspace_status')
    console.log(JSON.stringify({ endpoint: discovery, result }, null, 2))
    return
  }

  if (command === 'tools') {
    console.log(JSON.stringify(await client.listTools(), null, 2))
    return
  }

  if (command === 'call') {
    const [toolName, jsonArgs] = argv
    if (!toolName) throw new Error('call requires a tool name')
    const result = await client.callTool(toolName, parseJsonArg(jsonArgs), Number(optionValue(argv, '--timeout-ms', DEFAULT_TIMEOUT_MS)))
    console.log(JSON.stringify(result, null, 2))
    return
  }

  if (command === 'open-workspace') {
    const workspace = argv[0]
    if (!workspace) throw new Error('open-workspace requires a path')
    const result = await client.callTool('open_workspace', { path: path.resolve(workspace) }, 70_000)
    console.log(textFromToolResult(result))
    return
  }

  if (command === 'run-python-file') {
    const file = argv[0]
    if (!file) throw new Error('run-python-file requires a Python path')
    const result = await client.callTool('run_python_file', {
      file_path: path.resolve(file),
    }, 130_000)
    console.log(textFromToolResult(result))
    return
  }

  if (command === 'subagent') {
    const promptArg = argv[0]
    if (!promptArg) throw new Error('subagent requires a prompt file or prompt text')
    const timeoutS = Number(optionValue(argv, '--timeout-s', 1800))
    const result = await client.callTool('subagent', {
      prompt: promptTextFromFileOrLiteral(promptArg),
      timeout_seconds: timeoutS,
    }, (timeoutS + 30) * 1000)
    console.log(textFromToolResult(result))
    return
  }

  if (command === 'chess-demo') {
    const workspace = path.resolve(optionValue(argv, '--workspace', path.join(repoRoot(), 'cadbuildr-chess-world-workspace')))
    const world = optionValue(argv, '--world', 'forest-chess-world')
    const created = await createChessWorkspace(workspace, world)
    console.error(`Created workspace: ${created.workspacePath}`)
    console.error('Opening workspace in CADBuildr Prototype...')
    console.log(textFromToolResult(await client.callTool('open_workspace', { path: created.workspacePath }, 70_000)))
    console.error('Prompting CADBuildr Prototype subagent...')
    const result = await client.callTool('subagent', {
      prompt: fs.readFileSync(created.promptPath, 'utf8'),
      timeout_seconds: 1800,
    }, 1830_000)
    console.log(textFromToolResult(result))
    return
  }

  throw new Error(`Unknown command: ${command}`)
}

main().catch((error) => {
  console.error(error.message)
  process.exit(1)
})
