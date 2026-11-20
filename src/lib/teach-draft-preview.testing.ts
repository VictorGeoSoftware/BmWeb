import { DraftSupplierSkillV2, profileWorkbookDigest, previewProfile, previewRule } from '@/lib/teach-draft-preview';

export const previewRevisionVector = 'ee7d23208739560cff841d036cb0b80939d3b37dac8ee74fd4a179b8d3d7429f';
const identity = { profileKey: previewProfile, supplierKey: 'gesternova', workbookSha256: profileWorkbookDigest, revisionId: previewRevisionVector } as const;
export const previewDraftFixture = { kind: 'draft', draft: { schemaVersion: 2, ...identity, rule: previewRule } satisfies DraftSupplierSkillV2 };
export function pricePreviewFixture() {
  const cite = (a1: string) => ({ a1, sheet: 'Tarifas' });
  return { kind: 'preview', ...identity, rows: [
    ['Oferta sintética A', '0.12125', '0.07123', '0.02456'],
    ['Oferta sintética B', '0', '0.06432', '0.02234'],
    ['Oferta sintética C', '0.14321', '0.06987', '0.02109'],
  ].map(([proposal, energy, power1, power2], i) => {
    const row = i + 16;
    return { proposal, proposalCell: cite(`I${row}`), tariff: '2.0TD', tariffCell: cite(`F${row}`),
      priceType: 'Precio por Periodos', typeCell: cite(`G${row}`), prices: [
        { term: 'energy', period: 'P1', unit: '€/kWh', decimal: energy, header: cite('K14'), cell: cite(`K${row}`) },
        { term: 'power', period: 'P1', unit: '€/kWdia', decimal: power1, header: cite('S14'), cell: cite(`S${row}`) },
        { term: 'power', period: 'P2', unit: '€/kWdia', decimal: power2, header: cite('T14'), cell: cite(`T${row}`) },
      ] };
  }) };
}
