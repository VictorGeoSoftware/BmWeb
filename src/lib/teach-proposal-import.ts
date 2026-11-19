import { isQA } from '@/lib/env';
import { exactTeachObject } from '@/lib/teach-clarification';
import { readTeachPriceRows } from '@/lib/teach-draft-preview';

export const isTeachImportEnabled = () => isQA && process.env.NEXT_PUBLIC_TEACH_IMPORT_PILOT === 'true';
export const importAttemptHeader = 'X-Teach-Import-Attempt';
export const importPath = '/api/teach-me/proposal-import';
export const importsPath = '/api/teach-me/proposal-imports';
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

function validImportInstant(value: unknown): value is string {
  if (typeof value !== 'string' || /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{3}(?:[0-9]{3})?)?Z$/.exec(value)?.[0] !== value) return false;
  const date = new Date(value);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 19) === value.slice(0, 19);
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

export function readImportPage(value: unknown, cursor: string | null) {
  if (!exactTeachObject(value, 'kind', 'batches', 'nextCursor') || value.kind !== 'imports' ||
      !Array.isArray(value.batches) || value.batches.length > 4) return null;
  const batches: NonNullable<ReturnType<typeof readBatch>>[] = [];
  let prev = cursor;
  for (const raw of value.batches) {
    const batch = readBatch(raw);
    if (!batch || (prev && !numericLess(batch.importId, prev))) return null;
    prev = batch.importId;
    batches.push(batch);
  }
  const nextCursor = value.nextCursor;
  if (nextCursor !== null && (!validImportId(nextCursor) || batches.length !== 4 || nextCursor !== prev)) return null;
  return { kind: 'imports', batches, nextCursor };
}

export type ImportReceipt = NonNullable<ReturnType<typeof readImportReceipt>>;
export type ImportPage = NonNullable<ReturnType<typeof readImportPage>>;

export const importConflicts = ['unknown_supplier', 'ambiguous_supplier', 'conflicting_supplier', 'invalid_supplier_evidence',
  'no_active_skill', 'incompatible_workbook', 'attempt_mismatch'] as const;
