import { isQA } from '@/lib/env';

export const isTeachClarificationEnabled = () => isQA && process.env.NEXT_PUBLIC_TEACH_CLARIFY_LOCAL === 'true';
export const clarificationMediaType = 'application/vnd.bm.teach-clarification';
export const clarificationBodyLimit = 9 * 1024 * 1024 + 32 * 1024 + 4;
export const clarificationResponseLimit = 4096;
const digest = /^[a-f0-9]{64}$/;
const encoder = new TextEncoder();

type Citation = { sheet: string; a1: string };
export type ClarificationQuestion = { kind: 'question'; workbookSha256: string; candidates: [Citation, Citation] };
type ClarificationResult = ClarificationQuestion | { kind: 'not_applicable' } | { kind: 'acknowledged' };

export function exactTeachObject(value: unknown, ...keys: string[]): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function citation(value: unknown): value is Citation {
  if (!exactTeachObject(value, 'sheet', 'a1') || typeof value.sheet !== 'string' || typeof value.a1 !== 'string') return false;
  if (!value.sheet || /^\p{White_Space}+$/u.test(value.sheet) || [...value.sheet].length > 31 ||
      encoder.encode(value.sheet).length > 124 || /[:\\/?*\[\]\p{Cc}\p{Cs}\p{Bidi_Control}\uFEFF]/u.test(value.sheet)) return false;
  const match = /^([A-Z]{1,3})([1-9][0-9]{0,6})$/.exec(value.a1);
  if (!match || match[0] !== value.a1) return false;
  const column = [...match[1]].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0);
  return column <= 16_384 && Number(match[2]) <= 1_048_576;
}

export function readClarificationResult(value: unknown): ClarificationResult | null {
  if (exactTeachObject(value, 'kind') && (value.kind === 'not_applicable' || value.kind === 'acknowledged')) return { kind: value.kind };
  if (!exactTeachObject(value, 'kind', 'workbookSha256', 'candidates') || value.kind !== 'question' ||
      typeof value.workbookSha256 !== 'string' || value.workbookSha256.length !== 64 || !digest.test(value.workbookSha256) ||
      !Array.isArray(value.candidates) || value.candidates.length !== 2) return null;
  const [a, b] = value.candidates;
  if (!citation(a) || !citation(b)) return null;
  if (a.sheet.toLowerCase() === b.sheet.toLowerCase() && (a.sheet !== b.sheet || a.a1 === b.a1)) return null;
  return { kind: 'question', workbookSha256: value.workbookSha256, candidates: [a, b] };
}

export function validClarificationAnswer(answer: string) {
  return /\P{White_Space}/u.test(answer) && !/\p{Cs}/u.test(answer) && encoder.encode(answer).length <= 4096;
}

export function clarificationFrame(workbook: File, reply?: { digest: string; answer: string; pdf?: File; png?: File }) {
  const tuple = reply
    ? [1, 'reply', workbook.size, reply.pdf?.size ?? 0, reply.png?.size ?? 0, reply.digest, reply.answer]
    : [1, 'ask', workbook.size];
  return teachFrame(clarificationMediaType, tuple, [workbook, ...(reply?.pdf ? [reply.pdf] : []), ...(reply?.png ? [reply.png] : [])]);
}

export function teachFrame(mediaType: string, tuple: (string | number)[], parts: File[]) {
  const manifest = encoder.encode(JSON.stringify(tuple));
  const prefix = new Uint8Array(4);
  new DataView(prefix.buffer).setUint32(0, manifest.length);
  return new Blob([prefix, manifest, ...parts], { type: mediaType });
}
