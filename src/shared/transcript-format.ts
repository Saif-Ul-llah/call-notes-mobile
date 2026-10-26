// Transcript exporters: Markdown, plain text, SRT subtitles and the JSON document
// used by phase 2 (LLM summaries / MOM).

import type { Segment, SessionInfo, TranscriptDoc } from './types'

export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const mm = String(m).padStart(2, '0')
  const ss = String(s).padStart(2, '0')
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`
}

function srtTime(ms: number): string {
  const total = Math.max(0, Math.floor(ms))
  const h = String(Math.floor(total / 3600000)).padStart(2, '0')
  const m = String(Math.floor((total % 3600000) / 60000)).padStart(2, '0')
  const s = String(Math.floor((total % 60000) / 1000)).padStart(2, '0')
  const milli = String(total % 1000).padStart(3, '0')
  return `${h}:${m}:${s},${milli}`
}

function sorted(segments: Segment[]): Segment[] {
  return [...segments].sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs)
}

/** Merge consecutive segments from the same speaker into paragraphs for reading. */
export function toParagraphs(segments: Segment[], maxGapMs = 4000): Array<{ speaker: string; startMs: number; text: string }> {
  const out: Array<{ speaker: string; startMs: number; endMs: number; text: string }> = []
  for (const seg of sorted(segments)) {
    const last = out[out.length - 1]
    if (last && last.speaker === seg.speaker && seg.startMs - last.endMs <= maxGapMs) {
      last.text += ' ' + seg.text
      last.endMs = seg.endMs
    } else {
      out.push({ speaker: seg.speaker, startMs: seg.startMs, endMs: seg.endMs, text: seg.text })
    }
  }
  return out
}

export function toMarkdown(session: SessionInfo, segments: Segment[]): string {
  const started = new Date(session.startedAt)
  const duration = session.endedAt ? formatClock(session.endedAt - session.startedAt) : 'in progress'
  const lines = [
    `# ${session.title}`,
    '',
    `- **Date:** ${started.toLocaleString()}`,
    `- **Duration:** ${duration}`,
    `- **Language:** ${session.language}`,
    `- **Model:** ${session.model}`,
    '',
    '## Transcript',
    '',
  ]
  for (const p of toParagraphs(segments)) {
    lines.push(`**[${formatClock(p.startMs)}] ${p.speaker}:** ${p.text}`, '')
  }
  return lines.join('\n')
}

export function toText(session: SessionInfo, segments: Segment[]): string {
  const header = `${session.title}\n${new Date(session.startedAt).toLocaleString()}\n\n`
  return header + toParagraphs(segments).map((p) => `[${formatClock(p.startMs)}] ${p.speaker}: ${p.text}`).join('\n')
}

export function toSrt(segments: Segment[]): string {
  return sorted(segments)
    .map((s, i) => `${i + 1}\n${srtTime(s.startMs)} --> ${srtTime(Math.max(s.endMs, s.startMs + 500))}\n${s.speaker}: ${s.text}\n`)
    .join('\n')
}

export function toTranscriptDoc(session: SessionInfo, segments: Segment[]): TranscriptDoc {
  const { dir: _dir, segmentCount: _count, ...meta } = session
  return {
    version: 1,
    session: meta,
    segments: sorted(segments).map(({ id, startMs, endMs, speaker, stream, text }) => ({ id, startMs, endMs, speaker, stream, text })),
  }
}

export function sessionTitle(date: Date): string {
  const day = date.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })
  const time = date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  return `Call ${day}, ${time}`
}
