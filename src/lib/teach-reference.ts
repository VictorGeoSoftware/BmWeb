import { hasTeachFilenameBase, validTeachFilename } from '@/lib/teach-workbook';

export const referenceFilenameHeader = 'X-Teach-Reference-Filename';
export const referenceBodyLimit = 2 * 1024 * 1024;
export const referenceFormats = {
  reference_pdf: { mediaType: 'application/pdf', extension: '.pdf', label: 'Referencia PDF', suffix: /\.[pP][dD][fF]$/ },
  reference_png: { mediaType: 'image/png', extension: '.png', label: 'Referencia PNG', suffix: /\.[pP][nN][gG]$/ },
} as const;
export type ReferenceKind = keyof typeof referenceFormats;

export function referenceKindForMediaType(type: string | undefined): ReferenceKind | undefined {
  return (Object.keys(referenceFormats) as ReferenceKind[]).find((kind) => referenceFormats[kind].mediaType === type?.toLowerCase());
}

export function validReferenceFilename(name: string, kind: ReferenceKind) {
  return referenceFormats[kind].suffix.test(name) && hasTeachFilenameBase(name, 4) && validTeachFilename(name);
}
