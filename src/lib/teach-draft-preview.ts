import { exactTeachObject, teachFrame } from '@/lib/teach-clarification';
import { isTeachSupplierDraftEnabled } from '@/lib/teach-supplier-draft';
import { workbookBodyLimit } from '@/lib/teach-workbook';

export const isTeachDraftPreviewEnabled = () => isTeachSupplierDraftEnabled() && process.env.NEXT_PUBLIC_TEACH_PREVIEW_LOCAL === 'true';
export const draftPreviewMediaType = 'application/vnd.bm.teach-draft-preview';
export const draftPreviewBodyLimit = 4 + 32 * 1024 + workbookBodyLimit;
export const previewProfile = 'gesternova-20td-sanitized';
const supplier = 'gesternova';
export const profileWorkbookDigest = '45c27cd6d6c646f182c2b1a4bd8f0863a21d5ffeef6c09df40f644d318cd85b6';

const header = (a1: string, label: string) => ({ a1, label });
// Closed wire schema for this single approved profile. Never used to supply prices or proposal names.
export const previewRule = {
  kind: 'fixed_period_prices', sheet: 'Tarifas', candidateRows: [15, 16, 17, 18, 19, 20], fixedRows: [16, 17, 18],
  tariff: '2.0TD', otherTariff: '3.0TD', fixedType: 'Precio por Periodos', excludedTypes: ['Indexado'],
  headers: [header('F14', 'Tarifa'), header('G14', 'Tipo precio'), header('I14', 'Producto')],
  bindings: [
    { term: 'energy', period: 'P1', unit: '€/kWh', header: header('K14', 'TEA_P1 €/kWh') },
    { term: 'power', period: 'P1', unit: '€/kWdia', header: header('S14', 'TP_P1 (€/kWdia)') },
    { term: 'power', period: 'P2', unit: '€/kWdia', header: header('T14', 'TP_P2 (€/kWdia)') },
  ],
  absentHeaders: [header('L14', 'TEA_P2 €/kWh'), header('M14', 'TEA_P3 €/kWh')],
  styleSha256: 'ceabc26839ae8c5285c667366bffa538562f76e219eb4f2f5188626232d96900',
  decimalPolicy: 'unsigned-plain-6i-12f-no-exponent',
} as const;

type Identity = { profileKey: typeof previewProfile; supplierKey: typeof supplier; workbookSha256: string; revisionId: string };
export type DraftSupplierSkillV2 = Identity & { schemaVersion: 2; rule: typeof previewRule };
type Citation = { sheet: 'Tarifas'; a1: string };
type Price = { term: 'energy' | 'power'; period: 'P1' | 'P2'; unit: '€/kWh' | '€/kWdia'; decimal: string; header: Citation; cell: Citation };
type Row = { proposal: string; proposalCell: Citation; tariff: '2.0TD'; tariffCell: Citation; priceType: 'Precio por Periodos'; typeCell: Citation; prices: Price[] };
export type TeachPricePreview = Identity & { kind: 'preview'; rows: Row[] };
type Result = { kind: 'draft'; draft: DraftSupplierSkillV2 } | TeachPricePreview;

const identityKeys = ['profileKey', 'supplierKey', 'workbookSha256', 'revisionId'] as const;
const encoder = new TextEncoder();
const decimal = /^(?:0|[1-9][0-9]{0,5})(?:\.[0-9]{1,12})?$/;
const at = (a1: string, row: number) => a1.replace(/[0-9]+$/, String(row));

function identity(value: Record<string, unknown>, pins: ReadonlySet<string>): value is Identity & Record<string, unknown> {
  return value.profileKey === previewProfile && value.supplierKey === supplier && typeof value.workbookSha256 === 'string' && pins.has(value.workbookSha256) &&
    typeof value.revisionId === 'string' && value.revisionId.length === 64 && /^[a-f0-9]{64}$/.test(value.revisionId);
}

function matchesSchema(value: unknown, expected: unknown): boolean {
  if (Array.isArray(expected)) return Array.isArray(value) && value.length === expected.length && expected.every((item, i) => matchesSchema(value[i], item));
  if (expected !== null && typeof expected === 'object') {
    const entries = Object.entries(expected);
    return exactTeachObject(value, ...entries.map(([key]) => key)) && entries.every(([key, item]) => matchesSchema(value[key], item));
  }
  return value === expected;
}

function citation(value: unknown, a1: string): value is Citation {
  return exactTeachObject(value, 'sheet', 'a1') && value.sheet === previewRule.sheet && value.a1 === a1;
}

function price(value: unknown, row: number, binding: typeof previewRule.bindings[number]): value is Price {
  return exactTeachObject(value, 'term', 'period', 'unit', 'decimal', 'header', 'cell') && value.term === binding.term &&
    value.period === binding.period && value.unit === binding.unit && typeof value.decimal === 'string' &&
    decimal.exec(value.decimal)?.[0] === value.decimal && citation(value.header, binding.header.a1) && citation(value.cell, at(binding.header.a1, row));
}

function row(value: unknown, number: number): value is Row {
  const [tariff, type, proposal] = previewRule.headers;
  return exactTeachObject(value, 'proposal', 'proposalCell', 'tariff', 'tariffCell', 'priceType', 'typeCell', 'prices') &&
    typeof value.proposal === 'string' && /\P{White_Space}/u.test(value.proposal) && encoder.encode(value.proposal).length <= 96 &&
    !/[\p{Cc}\p{Cs}\p{Bidi_Control}\uFEFF]/u.test(value.proposal) && citation(value.proposalCell, at(proposal.a1, number)) &&
    value.tariff === previewRule.tariff && citation(value.tariffCell, at(tariff.a1, number)) &&
    value.priceType === previewRule.fixedType && citation(value.typeCell, at(type.a1, number)) &&
    Array.isArray(value.prices) && value.prices.length === previewRule.bindings.length &&
    value.prices.every((entry, i) => price(entry, number, previewRule.bindings[i]));
}

export function readTeachPriceRows(value: unknown): Row[] | null {
  if (!Array.isArray(value) || value.length !== previewRule.fixedRows.length ||
      !value.every((entry, i): entry is Row => row(entry, previewRule.fixedRows[i])) ||
      new Set(value.map((entry) => entry.proposal)).size !== value.length) return null;
  return value;
}

const canonicalPins: ReadonlySet<string> = new Set([profileWorkbookDigest]);

export function readTeachDraftPreviewResult(value: unknown, pins = canonicalPins): Result | null {
  if (exactTeachObject(value, 'kind', 'draft') && value.kind === 'draft') {
    const { draft } = value;
    if (!exactTeachObject(draft, ...identityKeys, 'schemaVersion', 'rule') || !identity(draft, canonicalPins) || draft.schemaVersion !== 2 ||
        !matchesSchema(draft.rule, previewRule)) return null;
    return { kind: 'draft', draft: { ...draft, schemaVersion: 2, rule: previewRule } };
  }
  if (!exactTeachObject(value, 'kind', ...identityKeys, 'rows') || value.kind !== 'preview' || !identity(value, pins) || !Array.isArray(value.rows)) return null;
  const rows = readTeachPriceRows(value.rows);
  if (!rows) return null;
  return { ...value, kind: 'preview', rows };
}

export function draftPreviewRevisionFields(selection: Identity, rule = previewRule) {
  const fields = ['bm.teach.supplier-draft/v2', '2', selection.profileKey, selection.supplierKey, selection.workbookSha256, rule.kind, rule.sheet];
  const push = (values: readonly (string | number)[]) => fields.push(String(values.length), ...values.map(String));
  const headers = (items: readonly { a1: string; label: string }[]) => {
    fields.push(String(items.length));
    for (const { a1, label } of items) fields.push(a1, label);
  };
  push(rule.candidateRows);
  push(rule.fixedRows);
  fields.push(rule.tariff, rule.otherTariff, rule.fixedType);
  push(rule.excludedTypes);
  headers(rule.headers);
  fields.push(String(rule.bindings.length));
  for (const item of rule.bindings) fields.push(item.term, item.period, item.unit, item.header.a1, item.header.label);
  headers(rule.absentHeaders);
  fields.push(rule.styleSha256, rule.decimalPolicy);
  return fields.map((field) => `${encoder.encode(field).length}:${field}`).join('');
}

export const samePreviewRevision = (left: Identity, right: Identity) => identityKeys.every((key) => left[key] === right[key]);

export function draftPreviewFrame(workbook: File, selection?: DraftSupplierSkillV2) {
  return teachFrame(draftPreviewMediaType, selection
    ? [1, 'preview', workbook.size, selection.profileKey, selection.supplierKey, selection.workbookSha256, selection.revisionId]
    : [1, 'prepare', workbook.size, previewProfile], [workbook]);
}
