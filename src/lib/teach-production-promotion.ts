import { exactTeachObject } from '@/lib/teach-clarification';
import { isTeachValidationEnabled, validImportId, validImportInstant } from '@/lib/teach-proposal-import';

export const promotionPath = '/api/teach-me/production-promotion';
export const promotionRefHeader = 'X-Teach-Promotion-Ref';
export const promotionResponseLimit = 2048;
export const isTeachPromotionEnabled = () => isTeachValidationEnabled() && process.env.NEXT_PUBLIC_TEACH_PROMOTION_PILOT === 'true';

const fields = ['kind', 'importId', 'revisionId', 'generation', 'validatedAt'];

export function readPromotionResult(value: unknown, status: number, write: boolean) {
  const opened = Boolean(exactTeachObject(value, ...fields, 'url', 'openedAt'));
  if (!exactTeachObject(value, ...(opened ? [...fields, 'url', 'openedAt'] : fields)) || !validImportId(value.importId) || !validImportId(value.generation) ||
      typeof value.revisionId !== 'string' || value.revisionId.length !== 64 || !/^[0-9a-f]{64}$/.test(value.revisionId) ||
      !validImportInstant(value.validatedAt)) return null;
  const base = { importId: value.importId, revisionId: value.revisionId, generation: value.generation, validatedAt: value.validatedAt };
  if (opened) {
    if (value.kind !== 'opened' || (status !== 200 && !(write && status === 201)) || !validImportInstant(value.openedAt) ||
        typeof value.url !== 'string') return null;
    const match = /^https:\/\/pr-pilot\.invalid\/bm-pilot\/skills-fixture\/pull\/([1-9][0-9]{0,18})$/.exec(value.url);
    if (match?.[0] !== value.url || !validImportId(match[1])) return null;
    return { kind: 'opened' as const, ...base, url: value.url, openedAt: value.openedAt };
  }
  if (value.kind === 'pending' && status === (write ? 202 : 200)) return { kind: 'pending' as const, ...base };
  if (value.kind === 'notRequested' && !write && status === 200) return { kind: 'notRequested' as const, ...base };
  return null;
}
