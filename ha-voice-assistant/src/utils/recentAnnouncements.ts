/**
 * Tracks the assistant's recent TTS announcements so the mic-recognized text
 * can be filtered when it's just our own speech echoing back through the
 * speakers. Keeps the conversation flow alive (no mic muting) while
 * preventing the assistant from talking to itself.
 */

interface Announcement {
  normalized: string;
  words: string[];
  timestamp: number;
}

const MAX_AGE_MS = 30_000;
const WORD_OVERLAP_THRESHOLD = 0.7; // 70% of words from either side overlap

let recent: Announcement[] = [];

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenize(normalized: string): string[] {
  const seen: Record<string, true> = {};
  const out: string[] = [];
  for (const w of normalized.split(" ")) {
    if (w.length > 1 && !seen[w]) {
      seen[w] = true;
      out.push(w);
    }
  }
  return out;
}

function prune(now: number): void {
  recent = recent.filter((a) => now - a.timestamp <= MAX_AGE_MS);
}

export function noteAnnouncement(text: string): void {
  if (!text) return;
  const now = Date.now();
  prune(now);
  const normalized = normalize(text);
  if (!normalized) return;
  recent.push({
    normalized,
    words: tokenize(normalized),
    timestamp: now,
  });
}

export function isLikelyEcho(text: string): boolean {
  if (!text) return false;
  const now = Date.now();
  prune(now);
  if (recent.length === 0) return false;

  const candidate = normalize(text);
  if (!candidate) return false;
  const candidateWords = tokenize(candidate);
  if (candidateWords.length === 0) return false;

  for (const a of recent) {
    if (candidate === a.normalized) return true;
    if (candidate.includes(a.normalized) || a.normalized.includes(candidate)) {
      return true;
    }
    // Word-overlap fallback for recognizer mangling ("9 PM" → "9 P M", etc.)
    let shared = 0;
    for (const w of candidateWords) {
      if (a.words.indexOf(w) !== -1) shared++;
    }
    const candidateRatio = shared / candidateWords.length;
    const announcementRatio = shared / a.words.length;
    if (
      candidateRatio >= WORD_OVERLAP_THRESHOLD ||
      announcementRatio >= WORD_OVERLAP_THRESHOLD
    ) {
      return true;
    }
  }
  return false;
}
