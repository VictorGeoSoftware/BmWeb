export const workbookMediaType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
export const workbookFilenameHeader = 'X-Teach-Workbook-Filename';
export const workbookBodyLimit = 5 * 1024 * 1024;

export function validWorkbookFilename(name: string) {
  return name.length > 5 && /\.[xX][lL][sS][xX]$/.test(name) &&
    /[^\p{White_Space}]/u.test(name.slice(0, -5)) &&
    !/[\\/\p{Cc}\p{Bidi_Control}\uFEFF\p{Cs}]/u.test(name) && new TextEncoder().encode(name).length <= 255;
}

export type WorkbookAttachment = { kind: 'workbook'; filename: string; sizeBytes: number };

export function readWorkbookReceipt(value: unknown, filename: string, sizeBytes: number): WorkbookAttachment | null {
  if (!value || typeof value !== 'object' || Object.keys(value).length !== 1 || !('attachment' in value)) return null;
  const attachment = value.attachment;
  if (!attachment || typeof attachment !== 'object' || Object.keys(attachment).length !== 3 ||
    !('kind' in attachment) || !('filename' in attachment) || !('sizeBytes' in attachment) ||
    attachment.kind !== 'workbook' || attachment.filename !== filename || attachment.sizeBytes !== sizeBytes) return null;
  return { kind: 'workbook', filename, sizeBytes };
}
