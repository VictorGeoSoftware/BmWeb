export const workbookMediaType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
export const workbookFilenameHeader = 'X-Teach-Workbook-Filename';
export const workbookBodyLimit = 5 * 1024 * 1024;

export function validWorkbookFilename(name: string) {
  return /\.[xX][lL][sS][xX]$/.test(name) && validTeachFilename(name) && hasTeachFilenameBase(name, 5);
}

export function validTeachFilename(name: string) {
  return !/[\\/\p{Cc}\p{Bidi_Control}\uFEFF\p{Cs}]/u.test(name) && new TextEncoder().encode(name).length <= 255;
}

export function hasTeachFilenameBase(name: string, extensionLength: number) {
  return /[^\p{White_Space}]/u.test(name.slice(0, -extensionLength));
}

export type TeachAttachment<Kind extends string> = { kind: Kind; filename: string; sizeBytes: number };

export function readTeachReceipt<Kind extends string>(value: unknown, kind: Kind, filename: string, sizeBytes: number): TeachAttachment<Kind> | null {
  if (!value || typeof value !== 'object' || Object.keys(value).length !== 1 || !('attachment' in value)) return null;
  const attachment = value.attachment;
  if (!attachment || typeof attachment !== 'object' || Object.keys(attachment).length !== 3 ||
    !('kind' in attachment) || !('filename' in attachment) || !('sizeBytes' in attachment) ||
    attachment.kind !== kind || attachment.filename !== filename || attachment.sizeBytes !== sizeBytes) return null;
  return { kind, filename, sizeBytes };
}
