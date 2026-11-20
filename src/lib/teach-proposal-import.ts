import { isQA } from '@/lib/env';
import { exactTeachObject } from '@/lib/teach-clarification';
import { readTeachPriceRows } from '@/lib/teach-draft-preview';

export const isTeachImportEnabled = () => isQA && process.env.NEXT_PUBLIC_TEACH_IMPORT_PILOT === 'true';
export const isTeachValidationEnabled = () => isTeachImportEnabled() && process.env.NEXT_PUBLIC_TEACH_VALIDATION_PILOT === 'true';
export const importAttemptHeader = 'X-Teach-Import-Attempt';
export const importPath = '/api/teach-me/proposal-import';
export const importsPath = '/api/teach-me/proposal-imports';
export const validationPath = '/api/teach-me/proposal-validation';
export const validationBodyLimit = 1024;
export const validationResponseLimit = 2048;
export const importListResponseLimit = 16 * 1024;

export function importsQuery(cursor: string | null, enriched: boolean) {
  return enriched ? '?validation=1' + (cursor ? '&cursor=' + cursor : '') : cursor ? '?cursor=' + cursor : '';
}
export const importListPage = '/dashboard/price-proposals?view=excel';

export const validImportAttempt = (value: string) => value.length === 32 && /^[0-9a-f]{32}$/.test(value);
export const validImportId = (value: unknown): value is string => typeof value === 'string' &&
  /^[1-9][0-9]{0,18}$/.exec(value)?.[0] === value && (value.length < 19 || value <= '9223372036854775807');
const revision = (value: unknown): value is string => typeof value === 'string' && value.length === 64 && /^[0-9a-f]{64}$/.test(value);
const numericLess = (a: string, b: string) => a.length === b.length ? a < b : a.length < b.length;

export function readImportReceipt(value: unknown, status: number) {
  const kind = status === 201 ? 'stored' : status === 200 ? 'alreadyStored' : null;
  if (!kind || !exactTeachObject(value, 'kind', 'importId', 'revisionId', 'generation', 'proposalCount') || value.kind !== kind ||
    !validImportId(value.importId) || !revision(value.revisionId) || !validImportId(value.generation) || value.proposalCount !== 3) return null;
  return { kind, importId: value.importId, revisionId: value.revisionId, generation: value.generation, proposalCount: 3 };
}

export function validImportInstant(value: unknown): value is string {
  if (typeof value !== 'string' || /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{3}(?:[0-9]{3})?)?Z$/.exec(value)?.[0] !== value) return false;
  const date = new Date(value);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 19) === value.slice(0, 19);
}

export const validValidationRef = (value: unknown): value is string => typeof value === 'string' && value.length === 36 &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);

export function readValidationResult(value: unknown, status: number) {
  const kind = status === 201 ? 'validated' : status === 200 ? 'alreadyValidated' : null;
  if (!kind || !exactTeachObject(value, 'kind', 'importId', 'revisionId', 'generation', 'validatedAt') || value.kind !== kind ||
      !validImportId(value.importId) || !revision(value.revisionId) || !validImportId(value.generation) || !validImportInstant(value.validatedAt)) return null;
  return { kind, importId: value.importId, revisionId: value.revisionId, generation: value.generation, validatedAt: value.validatedAt };
}

function readBatch(value: unknown) {
  if (!exactTeachObject(value, 'importId', 'supplierKey', 'revisionId', 'generation', 'importedAt', 'proposals') ||
      !validImportId(value.importId) || value.supplierKey !== 'gesternova' || !revision(value.revisionId) ||
      !validImportId(value.generation) || !validImportInstant(value.importedAt)) return null;
  const proposals = readTeachPriceRows(value.proposals);
  if (!proposals || proposals.some(row => row.prices.some(price => /\.\d*0$/.test(price.decimal)))) return null;
  return { importId: value.importId, supplierKey: value.supplierKey, revisionId: value.revisionId,
    generation: value.generation, importedAt: value.importedAt, proposals };
}

type Batch = NonNullable<ReturnType<typeof readBatch>>;
type Evidence = { kind: 'validated'; validatedAt: string };
export type ValidatableImportBatch = Batch & { validationRef: string; validation: Evidence | null };

function readValidatedBatch(value: unknown): ValidatableImportBatch | null {
  if (!exactTeachObject(value, 'importId', 'supplierKey', 'revisionId', 'generation', 'importedAt', 'proposals', 'validationRef', 'validation')) return null;
  const { validationRef, validation, ...rest } = value;
  const batch = readBatch(rest);
  if (!batch || !validValidationRef(validationRef)) return null;
  if (validation === null) return { ...batch, validationRef, validation };
  if (!exactTeachObject(validation, 'kind', 'validatedAt') || validation.kind !== 'validated' || !validImportInstant(validation.validatedAt)) return null;
  return { ...batch, validationRef, validation: { kind: 'validated', validatedAt: validation.validatedAt } };
}

export function readImportPage(value: unknown, cursor: string | null, enriched = false) {
  if (!exactTeachObject(value, 'kind', 'batches', 'nextCursor') || value.kind !== 'imports' ||
      !Array.isArray(value.batches) || value.batches.length > 4) return null;
  const batches: (Batch | ValidatableImportBatch)[] = [];
  const refs = new Set<string>();
  let prev = cursor;
  for (const raw of value.batches) {
    const batch = enriched ? readValidatedBatch(raw) : readBatch(raw);
    if (!batch || (prev && !numericLess(batch.importId, prev))) return null;
    if ('validationRef' in batch && typeof batch.validationRef === 'string') {
      if (refs.has(batch.validationRef)) return null;
      refs.add(batch.validationRef);
    }
    prev = batch.importId;
    batches.push(batch);
  }
  const nextCursor = value.nextCursor;
  if (nextCursor !== null && (!validImportId(nextCursor) || batches.length !== 4 || nextCursor !== prev)) return null;
  return { kind: 'imports', batches, nextCursor };
}

export type ImportReceipt = NonNullable<ReturnType<typeof readImportReceipt>>;
export type ImportPage = NonNullable<ReturnType<typeof readImportPage>>;

export const teachJsonType = /^application\/json(?:\s*;\s*charset=(?:utf-8|"utf-8"))?$/i;

/** Fail-closed on framing/size/invalid UTF-8 before parsing an untrusted JSON response. */
export async function readBoundedTeachJson(response: Response, limit: number) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Missing response body');
  const bytes = new Uint8Array(limit);
  let length = 0;
  try {
    if (!teachJsonType.test(response.headers.get('Content-Type') ?? '')) throw new Error('Invalid response media type');
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value.byteLength > limit - length) throw new Error('Oversized response');
      bytes.set(value, length);
      length += value.byteLength;
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, length))) as unknown;
  } finally {
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export const importConflicts = ['unknown_supplier', 'ambiguous_supplier', 'conflicting_supplier', 'invalid_supplier_evidence',
  'no_active_skill', 'incompatible_workbook', 'attempt_mismatch'] as const;
