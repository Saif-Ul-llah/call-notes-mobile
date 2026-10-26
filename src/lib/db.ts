// Local index of sessions and segments (expo-sqlite, WAL mode).

import { openDatabaseSync } from 'expo-sqlite'
import type { LanguageMode, Segment, SessionInfo, SessionStatus } from '../shared/types'

const db = openDatabaseSync('callnotes.db')

db.execSync(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    ended_at INTEGER,
    status TEXT NOT NULL,
    language TEXT NOT NULL,
    model TEXT NOT NULL,
    platform TEXT NOT NULL,
    dir TEXT NOT NULL,
    parent_id TEXT,
    audio_path TEXT,
    keep_audio INTEGER NOT NULL DEFAULT 1
  );
  CREATE TABLE IF NOT EXISTS segments (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    stream TEXT NOT NULL,
    speaker TEXT NOT NULL,
    start_ms INTEGER NOT NULL,
    end_ms INTEGER NOT NULL,
    text TEXT NOT NULL,
    raw_text TEXT
  );
  CREATE INDEX IF NOT EXISTS segments_session ON segments(session_id, start_ms);
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`)

type Row = Record<string, unknown>

export interface StoredSession extends SessionInfo {
  audioPath: string | null
  keepAudio: boolean
}

const toSession = (r: Row): StoredSession => ({
  id: r.id as string,
  title: r.title as string,
  startedAt: r.started_at as number,
  endedAt: (r.ended_at as number | null) ?? null,
  status: r.status as SessionStatus,
  language: r.language as LanguageMode,
  model: r.model as string,
  platform: r.platform as SessionInfo['platform'],
  dir: r.dir as string,
  parentId: (r.parent_id as string | null) ?? null,
  segmentCount: (r.segment_count as number | undefined) ?? undefined,
  snippet: (r.snippet as string | null | undefined) ?? undefined,
  audioPath: (r.audio_path as string | null) ?? null,
  keepAudio: r.keep_audio === 1,
})

const toSegment = (r: Row): Segment => ({
  id: r.id as string,
  sessionId: r.session_id as string,
  stream: r.stream as Segment['stream'],
  speaker: r.speaker as string,
  startMs: r.start_ms as number,
  endMs: r.end_ms as number,
  text: r.text as string,
  rawText: (r.raw_text as string | null) ?? undefined,
})

export function createSession(s: StoredSession): void {
  db.runSync(
    `INSERT INTO sessions (id, title, started_at, ended_at, status, language, model, platform, dir, parent_id, audio_path, keep_audio)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [s.id, s.title, s.startedAt, s.endedAt, s.status, s.language, s.model, s.platform, s.dir, s.parentId, s.audioPath, s.keepAudio ? 1 : 0],
  )
}

export function updateSession(
  id: string,
  patch: Partial<Pick<StoredSession, 'title' | 'status' | 'endedAt' | 'audioPath'>>,
): void {
  const cols: string[] = []
  const vals: Array<string | number | null> = []
  if (patch.title !== undefined) { cols.push('title = ?'); vals.push(patch.title) }
  if (patch.status !== undefined) { cols.push('status = ?'); vals.push(patch.status) }
  if (patch.endedAt !== undefined) { cols.push('ended_at = ?'); vals.push(patch.endedAt) }
  if (patch.audioPath !== undefined) { cols.push('audio_path = ?'); vals.push(patch.audioPath) }
  if (cols.length) db.runSync(`UPDATE sessions SET ${cols.join(', ')} WHERE id = ?`, [...vals, id])
}

export function getSession(id: string): StoredSession | null {
  const r = db.getFirstSync<Row>('SELECT * FROM sessions WHERE id = ?', [id])
  return r ? toSession(r) : null
}

export function listSessions(query = ''): StoredSession[] {
  const q = query.trim()
  const base = `SELECT s.*,
    (SELECT COUNT(*) FROM segments g WHERE g.session_id = s.id AND g.speaker != 'Notice') AS segment_count,
    (SELECT g.text FROM segments g WHERE g.session_id = s.id AND g.speaker != 'Notice' ORDER BY g.start_ms LIMIT 1) AS snippet
    FROM sessions s`
  if (!q) return db.getAllSync<Row>(`${base} ORDER BY s.started_at DESC LIMIT 300`).map(toSession)
  const like = `%${q.replace(/[%_\\]/g, (m) => '\\' + m)}%`
  return db
    .getAllSync<Row>(
      `${base} WHERE s.title LIKE ? ESCAPE '\\' OR EXISTS (SELECT 1 FROM segments g WHERE g.session_id = s.id AND g.text LIKE ? ESCAPE '\\')
       ORDER BY s.started_at DESC LIMIT 300`,
      [like, like],
    )
    .map(toSession)
}

export function sessionsWithStatus(statuses: readonly SessionStatus[]): StoredSession[] {
  return db
    .getAllSync<Row>(`SELECT * FROM sessions WHERE status IN (${statuses.map(() => '?').join(',')})`, [...statuses])
    .map(toSession)
}

export function deleteSession(id: string): void {
  db.runSync('DELETE FROM sessions WHERE id = ?', [id])
}

export function addSegment(seg: Segment): void {
  db.runSync(
    `INSERT OR REPLACE INTO segments (id, session_id, stream, speaker, start_ms, end_ms, text, raw_text) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [seg.id, seg.sessionId, seg.stream, seg.speaker, seg.startMs, seg.endMs, seg.text, seg.rawText ?? null],
  )
}

export function segments(sessionId: string): Segment[] {
  return db.getAllSync<Row>('SELECT * FROM segments WHERE session_id = ? ORDER BY start_ms, end_ms', [sessionId]).map(toSegment)
}

export function lastSegmentEnd(sessionId: string): number | null {
  const r = db.getFirstSync<{ m: number | null }>('SELECT MAX(end_ms) AS m FROM segments WHERE session_id = ?', [sessionId])
  return r?.m ?? null
}

// ---- settings

export interface MobileSettings {
  language: LanguageMode
  keepAudio: boolean
  showPartials: boolean
}

const DEFAULT_SETTINGS: MobileSettings = { language: 'roman', keepAudio: true, showPartials: true }

export function getSettings(): MobileSettings {
  const rows = db.getAllSync<{ key: string; value: string }>('SELECT key, value FROM settings')
  const stored = Object.fromEntries(rows.map((r) => [r.key, JSON.parse(r.value)]))
  return { ...DEFAULT_SETTINGS, ...stored }
}

export function setSettings(patch: Partial<MobileSettings>): MobileSettings {
  for (const [key, value] of Object.entries(patch)) {
    db.runSync('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [key, JSON.stringify(value)])
  }
  return getSettings()
}
