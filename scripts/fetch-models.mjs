#!/usr/bin/env node
// Downloads the whisper.cpp models that get bundled into the app (assets/models).
// Usage: node scripts/fetch-models.mjs   (Swift model + Silero VAD into assets/models)
import { createWriteStream, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export const MODELS = {
  apex: {
    file: 'ggml-hinglish-apex-q5_0.bin',
    url: 'https://huggingface.co/Marquestra/Whisper-Hindi2Hinglish-Apex-GGML/resolve/main/ggml-apex-hinglish-q5_0.bin',
    size: 574041195,
  },
  swift: {
    file: 'ggml-hinglish-swift-q5_1.bin',
    url: 'https://huggingface.co/rohitag13/whisper-hindi2hinglish-swift-GGUF/resolve/main/ggml-hinglish-swift-q5_1.bin',
    size: 59707625,
  },
  vad: {
    file: 'ggml-silero-v5.1.2.bin',
    url: 'https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v5.1.2.bin',
  },
}

async function download(model, dest, attempt = 1) {
  const target = join(dest, model.file)
  if (existsSync(target) && (!model.size || statSync(target).size === model.size)) {
    console.log(`✓ ${model.file} already present`)
    return
  }
  const part = `${target}.part`
  const start = existsSync(part) ? statSync(part).size : 0
  console.log(`↓ ${model.file}${start ? ` (resuming at ${(start / 1e6).toFixed(1)} MB)` : ''}`)
  try {
    const res = await fetch(model.url, { headers: start ? { Range: `bytes=${start}-` } : {} })
    if (!res.ok && res.status !== 206) throw new Error(`HTTP ${res.status}`)
    const append = start > 0 && res.status === 206
    const total = Number(res.headers.get('content-length') || 0) + (append ? start : 0)
    let done = append ? start : 0
    let lastLog = 0
    const body = Readable.fromWeb(res.body)
    body.on('data', (chunk) => {
      done += chunk.length
      if (Date.now() - lastLog > 2000) {
        lastLog = Date.now()
        process.stdout.write(`  ${(done / 1e6).toFixed(1)} / ${(total / 1e6).toFixed(1)} MB\n`)
      }
    })
    await pipeline(body, createWriteStream(part, { flags: append ? 'a' : 'w' }))
    if (model.size && statSync(part).size !== model.size) {
      unlinkSync(part)
      throw new Error(`size mismatch for ${model.file}`)
    }
    renameSync(part, target)
    console.log(`✓ ${model.file}`)
  } catch (err) {
    if (attempt >= 5) throw err
    const wait = 2000 * 2 ** (attempt - 1)
    console.warn(`! ${model.file}: ${err.message}, retrying in ${wait / 1000}s`)
    await new Promise((r) => setTimeout(r, wait))
    return download(model, dest, attempt + 1)
  }
}

const args = process.argv.slice(2)
const argValue = (name) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}
const only = argValue('--only')?.split(',') ?? ['swift', 'vad']
const dest = resolve(ROOT, argValue('--dest') ?? 'assets/models')
mkdirSync(dest, { recursive: true })
for (const key of only) {
  if (!MODELS[key]) throw new Error(`unknown model "${key}" (choose from ${Object.keys(MODELS).join(', ')})`)
  await download(MODELS[key], dest)
}
