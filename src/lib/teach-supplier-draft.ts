import { exactTeachObject, isTeachClarificationEnabled, readClarificationResult, teachFrame, validClarificationAnswer } from '@/lib/teach-clarification';
import { workbookBodyLimit } from '@/lib/teach-workbook';

export const isTeachSupplierDraftEnabled = () => isTeachClarificationEnabled() && process.env.NEXT_PUBLIC_TEACH_DRAFT_LOCAL === 'true';
export const supplierDraftMediaType = 'application/vnd.bm.teach-supplier-draft';
export const supplierDraftBodyLimit = 4 + 32 * 1024 + workbookBodyLimit;
export const demoSupplier = 'demo-electricidad';
export const demoWorkbookName = 'ensename-demo.xlsx';
const ruleKind = 'fixed_price_column';
type Header = { sheet: 'Tarifas'; a1: 'B2' | 'C2' };
type Answer = 'La columna B' | 'La columna C';

export type SupplierDraftQuestion = { kind: 'question'; workbookSha256: string; candidates: [Header, Header] };
export type DraftSupplierSkillV1 = {
  schemaVersion: 1;
  supplierKey: typeof demoSupplier;
  workbookSha256: string;
  rule: { kind: typeof ruleKind; header: Header };
  revisionId: string;
};
type SupplierDraftResult = SupplierDraftQuestion | { kind: 'not_applicable' } | { kind: 'draft'; draft: DraftSupplierSkillV1 };

function digest(value: unknown): value is string {
  return typeof value === 'string' && value.length === 64 && /^[0-9a-f]{64}$/.test(value);
}

function header(value: unknown): value is Header {
  return exactTeachObject(value, 'sheet', 'a1') && value.sheet === 'Tarifas' && (value.a1 === 'B2' || value.a1 === 'C2');
}

export function readSupplierDraftResult(value: unknown): SupplierDraftResult | null {
  if (exactTeachObject(value, 'kind', 'draft') && value.kind === 'draft') {
    const data = value.draft;
    if (!exactTeachObject(data, 'schemaVersion', 'supplierKey', 'workbookSha256', 'rule', 'revisionId') || data.schemaVersion !== 1 ||
        data.supplierKey !== demoSupplier || !digest(data.workbookSha256) || !digest(data.revisionId) ||
        !exactTeachObject(data.rule, 'kind', 'header') || data.rule.kind !== ruleKind || !header(data.rule.header)) return null;
    return { kind: 'draft', draft: { schemaVersion: 1, supplierKey: demoSupplier, workbookSha256: data.workbookSha256,
      rule: { kind: ruleKind, header: data.rule.header }, revisionId: data.revisionId } };
  }
  const question = readClarificationResult(value);
  if (question?.kind === 'not_applicable') return question;
  if (question?.kind !== 'question') return null;
  const [a, b] = question.candidates;
  return header(a) && header(b) ? { ...question, candidates: [a, b] } : null;
}

export function supplierDraftRevisionFields(draft: DraftSupplierSkillV1) {
  return ['bm.teach.supplier-draft/v1', draft.supplierKey, draft.workbookSha256, draft.rule.kind, draft.rule.header.sheet, draft.rule.header.a1].join('\n');
}

export function supplierDraftAnswer(value: string): { answer: Answer; a1: Header['a1'] } | null {
  if (!validClarificationAnswer(value)) return null;
  const answer = value.replace(/^ +| +$/g, '');
  return answer === 'La columna B' ? { answer, a1: 'B2' } : answer === 'La columna C' ? { answer, a1: 'C2' } : null;
}

export function supplierDraftFrame(workbook: File, selection?: { question: SupplierDraftQuestion; supplierKey: typeof demoSupplier; answer: string; prior?: DraftSupplierSkillV1 }) {
  const start = [1, selection ? (selection.prior ? 'revise' : 'draft') : 'ask', workbook.size];
  const tuple = !selection ? start : [...start, selection.question.workbookSha256, selection.supplierKey,
    ...(selection.prior ? [selection.prior.revisionId] : []), selection.answer];
  return teachFrame(supplierDraftMediaType, tuple, [workbook]);
}
