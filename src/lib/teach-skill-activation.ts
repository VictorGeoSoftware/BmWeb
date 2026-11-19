import { exactTeachObject } from '@/lib/teach-clarification';
import { isQA } from '@/lib/env';
import { isTeachDraftPreviewEnabled, readTeachDraftPreviewResult, TeachPricePreview } from '@/lib/teach-draft-preview';

export const qaPilotPreviewMediaType = 'application/vnd.bm.teach-draft-preview-qa-pilot';
export const activationBodyLimit = 2048;
export const isTeachActivationPilotVisible = () => isQA && isTeachDraftPreviewEnabled() && process.env.NEXT_PUBLIC_TEACH_ACTIVATION_PILOT === 'true';
type Active = { revisionId: string | null; generation: string };
export type PilotPreview = { kind: 'qaPilotPreview'; preview: TeachPricePreview; active: Active; expiresAt: number; receipt: string };
export type ActivationRequest = { revisionId: string; expectedRevisionId: string | null; expectedGeneration: string; receipt: string };

const revision = (value: unknown): value is string => typeof value === 'string' && value.length === 64 && /^[0-9a-f]{64}$/.test(value);
const receipt = (value: unknown): value is string => typeof value === 'string' && value.length <= 1536 &&
  /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}/.exec(value)?.[0] === value;
function validActive(id: unknown, generation: unknown) {
  return typeof generation === 'string' && /^(?:0|[1-9][0-9]{0,18})/.exec(generation)?.[0] === generation &&
    BigInt(generation) <= BigInt('9223372036854775807') && (id === null ? generation === '0' : revision(id) && generation !== '0');
}
function readActive(value: unknown): Active | null {
  return exactTeachObject(value, 'revisionId', 'generation') && validActive(value.revisionId, value.generation) ? value as Active : null;
}

export function readPilotPreview(value: unknown, pins?: ReadonlySet<string>): PilotPreview | null {
  if (!exactTeachObject(value, 'kind', 'preview', 'active', 'expiresAt', 'receipt') || value.kind !== 'qaPilotPreview' ||
      !receipt(value.receipt) || typeof value.expiresAt !== 'number' || !Number.isSafeInteger(value.expiresAt) || value.expiresAt < 0) return null;
  const active = readActive(value.active);
  const preview = readTeachDraftPreviewResult(value.preview, pins);
  return active && preview?.kind === 'preview' ? { kind: 'qaPilotPreview', preview, active, expiresAt: value.expiresAt, receipt: value.receipt } : null;
}

function readActivationRequest(value: unknown): ActivationRequest | null {
  return exactTeachObject(value, 'revisionId', 'expectedRevisionId', 'expectedGeneration', 'receipt') && revision(value.revisionId) &&
    validActive(value.expectedRevisionId, value.expectedGeneration) && receipt(value.receipt) ? value as ActivationRequest : null;
}

/** Preserve key multiplicity when validating that a Pages success matches the streamed request. */
export function parseActivationRequest(text: string): ActivationRequest | null {
  const token = /[ \t\r\n]*("(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"|null|[{}:,]|$)/y;
  const next = () => token.exec(text)?.[1];
  const fields: Record<string, unknown> = Object.create(null);
  if (next() !== '{') return null;
  for (let i = 0; i < 4; i++) {
    if (i > 0 && next() !== ',') return null;
    const raw = next();
    if (!raw?.startsWith('"') || next() !== ':') return null;
    const key: string = JSON.parse(raw);
    const value = next();
    if (Object.hasOwn(fields, key) || (!value?.startsWith('"') && value !== 'null')) return null;
    fields[key] = JSON.parse(value);
  }
  return next() === '}' && next() === '' && token.lastIndex === text.length ? readActivationRequest(fields) : null;
}

export function readActivationResult(value: unknown, request: ActivationRequest) {
  if (!exactTeachObject(value, 'kind', 'active')) return null;
  const active = readActive(value.active);
  if (!active || active.revisionId !== request.revisionId) return null;
  const noop = request.revisionId === request.expectedRevisionId;
  const generation = (BigInt(request.expectedGeneration) + BigInt(noop ? 0 : 1)).toString();
  return value.kind === (noop ? 'alreadyActive' : 'activated') && active.generation === generation ? { kind: value.kind, active } : null;
}
