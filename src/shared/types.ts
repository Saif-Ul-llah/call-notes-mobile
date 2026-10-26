// Types shared with the desktop app (desktop/src/shared/types.ts) — same transcript
// model on both platforms so phase-2 summaries/MOM work on either.

/** "roman" = Roman Urdu/Hindi (with English mixed in), "en" = English only, "auto" = let the model decide. */
export type LanguageMode = 'roman' | 'en' | 'auto'

/** On mobile everything comes from the microphone. */
export type StreamId = 'mic' | 'system'

export type SessionStatus = 'starting' | 'recording' | 'retrying' | 'stopping' | 'saved' | 'interrupted'

export type ModelId = 'apex' | 'swift'

export interface Segment {
  id: string
  sessionId: string
  stream: StreamId
  speaker: string
  startMs: number
  endMs: number
  text: string
  rawText?: string
}

export interface PartialLine {
  sessionId: string
  stream: StreamId
  speaker: string
  startMs: number
  text: string
}

export interface SessionInfo {
  id: string
  title: string
  startedAt: number
  endedAt: number | null
  status: SessionStatus
  language: LanguageMode
  model: string
  platform: 'desktop' | 'android' | 'ios'
  dir: string
  parentId: string | null
  segmentCount?: number
  /** first transcribed line, for list previews */
  snippet?: string
}

/** On-disk transcript.json — the format phase 2 (LLM summaries / MOM) consumes. */
export interface TranscriptDoc {
  version: 1
  session: Omit<SessionInfo, 'dir' | 'segmentCount' | 'snippet'>
  segments: Array<Pick<Segment, 'id' | 'startMs' | 'endMs' | 'speaker' | 'stream' | 'text'>>
}
