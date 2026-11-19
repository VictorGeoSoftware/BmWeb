import { createHash } from 'node:crypto';
import { isQA } from '@/lib/env';
import { clarificationBodyLimit, clarificationMediaType, clarificationResponseLimit, isTeachClarificationEnabled, readClarificationResult } from '@/lib/teach-clarification';
import { referenceBodyLimit, referenceFilenameHeader, referenceFormats, referenceKindForMediaType, validReferenceFilename } from '@/lib/teach-reference';
import { readTeachReceipt, validTeachFilename, validWorkbookFilename, workbookBodyLimit, workbookFilenameHeader, workbookMediaType } from '@/lib/teach-workbook';
import { isTeachSupplierDraftEnabled, readSupplierDraftResult, supplierDraftBodyLimit, supplierDraftMediaType, supplierDraftRevisionFields } from '@/lib/teach-supplier-draft';
import { draftPreviewBodyLimit, draftPreviewMediaType, draftPreviewRevisionFields, isTeachDraftPreviewEnabled, previewProfile, profileWorkbookDigest, readTeachDraftPreviewResult } from '@/lib/teach-draft-preview';
import { activationBodyLimit, qaPilotPreviewMediaType, parseActivationRequest, readActivationResult, readPilotPreview } from '@/lib/teach-skill-activation';
import { importAttemptHeader, importConflicts, importListResponseLimit, importsQuery, readImportPage, readImportReceipt, readValidationResult,
  validationBodyLimit, validationResponseLimit, validImportAttempt, validImportId } from '@/lib/teach-proposal-import';
import { exactTeachObject } from '@/lib/teach-clarification';

const headers = { 'Cache-Control': 'no-store' };
type UploadPath = 'messages' | 'references' | 'clarifications' | 'activation';
const errors: Record<number, string> = { 400: 'invalid_message', 413: 'upload_too_large' };
let active = 0;

function filenameFromHeader(wire: string | null) {
  if (!wire || !/^[A-Za-z0-9_-]{1,340}$/.test(wire)) return null;
  try {
    const bytes = Buffer.from(wire, 'base64url');
    if (bytes.length > 255 || bytes.toString('base64url') !== wire) return null;
    const name = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    return validTeachFilename(name) ? name : null;
  } catch { return null; }
}

async function boundedJson(response: Response, strictBOM: boolean, limit = clarificationResponseLimit) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Missing receipt');
  const bytes = new Uint8Array(limit);
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value.byteLength > bytes.length - length) throw new Error('Oversized receipt');
      bytes.set(value, length);
      length += value.byteLength;
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: strictBOM }).decode(bytes.subarray(0, length))) as unknown;
  } finally {
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

const importOverrides = new Set(['env', 'environment', 'supplier', 'supplierkey', 'profile', 'profilekey',
  'revision', 'revisionid', 'generation', 'hash', 'sha256', 'workbookhash', 'workbooksha256', 'storeid', 'manifest', 'actor', 'uid']);
const validationOverrides = new Set(['workbookfilename', 'importattempt', 'validationref', 'importid', 'batchid',
  'confirmexpectedprices', 'result', 'receipt', 'digest', 'prices', 'httpmethodoverride', 'methodoverride', 'httpmethod',
  'originalurl', 'rewriteurl', 'trailer', 'contenttransferencoding']);
const jsonType = /^application\/json(?:\s*;\s*charset=(?:utf-8|"utf-8"))?$/i;

export async function forwardTeachProposalImport(request: UploadRequest & { names: () => string[] }, path: 'proposal-import' | 'proposal-imports' | 'proposal-validation') {
  const list = path === 'proposal-imports';
  const validate = path === 'proposal-validation';
  const plain = (status: number) => new Response(null, { status, headers });
  if (!isQA || process.env.BM_TEACH_IMPORT_PILOT !== 'true') return plain(404);
  const query = request.url.includes('?') ? request.url.slice(request.url.indexOf('?') + 1) : null;
  const enriched = list && !!query?.startsWith('validation=');
  if ((validate || enriched) && process.env.BM_TEACH_VALIDATION_PILOT !== 'true') return plain(404);
  const [authorization, extraAuth] = request.values('authorization');
  if (extraAuth !== undefined || !authorization?.startsWith('Bearer ') || !authorization.slice(7).trim() || authorization.includes(',')) return plain(401);
  const contentTypes = request.values('content-type');
  const encodings = request.values('transfer-encoding');
  const lengths = request.values('content-length');
  const names = request.values(workbookFilenameHeader);
  const attempts = request.values(importAttemptHeader);
  if (request.values('content-disposition').length || request.values(referenceFilenameHeader).length || request.names().some(name => {
    const key = name.toLowerCase().replace(/_/g, '-').replace(/^x-/, '').replace(/^bm-/, '').replace(/^teach-/, '').replace(/-/g, '');
    return importOverrides.has(key) || ((enriched || validate) && validationOverrides.has(key));
  })) return plain(400);
  let cursor: string | null = null;
  if (list) {
    if (enriched) {
      const match = /^validation=1(?:&cursor=([1-9][0-9]{0,18}))?$/.exec(query ?? '');
      if (!match || match[0] !== query || (match[1] !== undefined && !validImportId(match[1]))) return plain(400);
      cursor = match[1] ?? null;
    } else if (query !== null) {
      cursor = query.startsWith('cursor=') ? query.slice(7) : '';
      if (!validImportId(cursor)) return plain(400);
    }
    if (contentTypes.length || encodings.length || names.length || attempts.length || request.values('content-encoding').length ||
        (lengths.length !== 0 && (lengths.length !== 1 || lengths[0] !== '0'))) return plain(400);
  } else if (validate) {
    if (query !== null || encodings.length || lengths.length !== 1 || !validImportId(lengths[0]) ||
        contentTypes.length > 1 || contentTypes[0]?.includes(',') || names.length || attempts.length) return plain(400);
    if (Number(lengths[0]) > validationBodyLimit) return plain(413);
    if (contentTypes[0]?.toLowerCase() !== 'application/json' || request.values('content-encoding').length) return plain(415);
  } else {
    const filename = names.length === 1 ? filenameFromHeader(names[0]) : null;
    if (query !== null || !filename || !validWorkbookFilename(filename) || attempts.length !== 1 || !validImportAttempt(attempts[0]) ||
        contentTypes.length > 1 || contentTypes[0]?.includes(',') || lengths.length > 1 ||
        (encodings.length && (encodings.length !== 1 || encodings[0].toLowerCase() !== 'chunked' || lengths.length)) ||
        (!encodings.length && !lengths.length)) return plain(400);
    if (contentTypes[0]?.toLowerCase() !== workbookMediaType || request.values('content-encoding').length) return plain(415);
    if (lengths.length) {
      if (!validImportId(lengths[0])) return plain(400);
      if (Number(lengths[0]) > workbookBodyLimit) return plain(413);
    }
  }
  const target = process.env.BM_BACKEND_URL;
  const match = target && /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})\/?$/.exec(target);
  if (!match || match[0] !== target || Number(match[1]) > 65535) return plain(502);
  if (active >= 4) return plain(429);
  const reader = list ? null : request.body()?.getReader();
  if (!list && !reader) return plain(400);

  active++;
  const upstream = new AbortController();
  let failure: number | undefined;
  let size = 0;
  let complete = list;
  const stop = (status: number) => { failure ??= status; upstream.abort(); void reader?.cancel().catch(() => {}); };
  const onDisconnect = () => stop(408);
  request.signal.addEventListener('abort', onDisconnect, { once: true });
  if (request.signal.aborted) onDisconnect();
  const timer = setTimeout(() => stop(408), 15_000);

  const body = reader ? new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const part = await reader.read();
        if (failure) { controller.error(new Error('Import stopped')); return; }
        if (part.done) {
          if (!size || (lengths.length && size !== Number(lengths[0]))) { stop(400); controller.error(new Error('Invalid size')); return; }
          complete = true;
          controller.close();
        } else if (part.value.byteLength > (validate ? validationBodyLimit : workbookBodyLimit) - size) {
          stop(413); controller.error(new Error('Upload limit'));
        } else if (validate && part.value.byteLength > Number(lengths[0]) - size) {
          stop(400); controller.error(new Error('Invalid size'));
        } else {
          size += part.value.byteLength;
          controller.enqueue(part.value);
        }
      } catch { controller.error(new Error('Import interrupted')); }
    },
    cancel() { void reader.cancel().catch(() => {}); },
  }, { highWaterMark: 0 }) : undefined;

  try {
    const init: RequestInit & { duplex?: 'half' } = {
      method: list ? 'GET' : 'POST', signal: upstream.signal, cache: 'no-store', redirect: 'error',
      headers: { Authorization: authorization, ...(list ? {} : validate ? { 'Content-Type': 'application/json', 'Content-Length': lengths[0] }
        : { 'Content-Type': workbookMediaType, [workbookFilenameHeader]: names[0], [importAttemptHeader]: attempts[0] }) },
      ...(list ? {} : { body, duplex: 'half' }),
    };
    const response = await fetch(`http://127.0.0.1:${match[1]}/api/v1/teach-me/${path}${list ? importsQuery(cursor, enriched) : ''}`, init);
    if (failure) return plain(failure);
    const success = response.status === 200 || (!list && response.status === 201);
    const conflict = !list && !validate && response.status === 409;
    if (!success && !conflict) {
      void response.body?.cancel().catch(() => {});
      return plain([400, 401, 403, 404, 405, 408, 413, 415, 429, 500, 503].includes(response.status) ? response.status : 502);
    }
    if (!complete || !jsonType.test(response.headers.get('Content-Type') ?? '')) {
      void response.body?.cancel().catch(() => {});
      return plain(502);
    }
    const limit = list ? importListResponseLimit : validate ? validationResponseLimit : 4 * 1024;
    const value = await boundedJson(response, true, limit);
    if (failure) return plain(failure);
    const result = conflict ? (exactTeachObject(value, 'error') && importConflicts.some(it => it === value.error) ? { error: value.error } : null)
      : list ? readImportPage(value, cursor, enriched) : validate ? readValidationResult(value, response.status) : readImportReceipt(value, response.status);
    if (!result) return plain(502);
    const json = JSON.stringify(result);
    if (Buffer.byteLength(json) > limit) return plain(502);
    return new Response(json, { status: response.status, headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8' } });
  } catch { return plain(failure ?? 502); }
  finally {
    clearTimeout(timer);
    request.signal.removeEventListener('abort', onDisconnect);
    upstream.abort();
    void reader?.cancel().catch(() => {});
    reader?.releaseLock();
    active--;
  }
}

type UploadRequest = {
  url: string;
  values: (name: string) => string[];
  body: () => ReadableStream<Uint8Array> | null;
  signal: AbortSignal;
};

const canonicalPilotPins: ReadonlySet<string> = new Set([profileWorkbookDigest]);
const revisionFor = (workbookSha256: string) => createHash('sha256').update(draftPreviewRevisionFields({
  profileKey: previewProfile, supplierKey: 'gesternova', workbookSha256, revisionId: '',
}), 'utf8').digest('hex');

export async function forwardTeachUpload(request: UploadRequest, path: UploadPath, pins = canonicalPilotPins) {
  const reference = path === 'references';
  const clarification = path === 'clarifications';
  const activation = path === 'activation';
  const filenameHeader = reference ? referenceFilenameHeader : workbookFilenameHeader;
  const types = request.values('content-type');
  const [type] = types;
  const draftWire = clarification && types.length === 1 && type.toLowerCase() === supplierDraftMediaType;
  const previewWire = clarification && types.length === 1 && type.toLowerCase() === draftPreviewMediaType;
  const pilotWire = clarification && types.length === 1 && type.toLowerCase() === qaPilotPreviewMediaType;
  const pilot = activation || pilotWire;
  const bodyLimit = activation ? activationBodyLimit : pilotWire || previewWire ? draftPreviewBodyLimit : draftWire ? supplierDraftBodyLimit : clarification ? clarificationBodyLimit : reference ? referenceBodyLimit : workbookBodyLimit;
  function error(status: number) {
    const code = status === 415 ? (activation ? undefined : draftWire || previewWire || pilotWire ? 'unsupported_workbook' : clarification ? 'unsupported_clarification' : reference ? 'unsupported_reference' : 'unsupported_workbook') : errors[status];
    return code ? Response.json({ error: code }, { status, headers }) : new Response(null, { status, headers });
  }
  if (!isQA || (clarification && !isTeachClarificationEnabled()) || (draftWire && !isTeachSupplierDraftEnabled()) ||
      (previewWire && !isTeachDraftPreviewEnabled()) || (pilot &&
        (!isTeachDraftPreviewEnabled() || process.env.BM_TEACH_ACTIVATION_PILOT !== 'true'))) return error(404);
  const authorizations = request.values('authorization');
  const [authorization] = authorizations;
  if (!authorization?.startsWith('Bearer ') || !authorization.slice(7).trim() ||
      ((clarification || activation) && (authorizations.length !== 1 || authorization.includes(',')))) return error(401);
  if (active >= 4) return error(429);
  const names = clarification || activation ? [] : request.values(filenameHeader);
  const [wire] = names;
  const filename = filenameFromHeader(wire ?? null);
  if (request.url.includes('?') || types.length > 1 || type?.includes(',') ||
      ((draftWire || previewWire || pilot) && (request.values(workbookFilenameHeader).length > 0 || request.values(referenceFilenameHeader).length > 0)) ||
      (pilot && request.values('content-disposition').length > 0) ||
      (!clarification && !activation && (names.length !== 1 || !filename))) return error(400);
  const kind = reference ? referenceKindForMediaType(type) : 'workbook';
  if (!kind) return error(415);
  const mediaType = activation ? 'application/json' : pilotWire ? qaPilotPreviewMediaType : previewWire ? draftPreviewMediaType : draftWire ? supplierDraftMediaType : clarification ? clarificationMediaType : kind === 'workbook' ? workbookMediaType : referenceFormats[kind].mediaType;
  if (!clarification && filename && (kind === 'workbook' ? !validWorkbookFilename(filename) : !validReferenceFilename(filename, kind))) return error(400);
  if (type?.toLowerCase() !== mediaType || request.values('content-encoding').length) return error(415);
  const backend = process.env.BM_BACKEND_URL;
  if (!backend) return error(502);
  if (pilot) {
    const port = /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})\/?$/.exec(backend);
    if (port?.[0] !== backend || Number(port[1]) > 65535) return error(502);
  }

  const upstream = new AbortController();
  const reader = request.body()?.getReader();
  if (!reader) return error(400);
  active++;
  let received = 0;
  let complete = false;
  let readingClient = false;
  let failure: number | undefined;
  // Capture only the bounded activation JSON or preview manifest for request/response binding.
  const context = pilot ? Buffer.alloc(activation ? activationBodyLimit : 4 + 32 * 1024) : null;
  const stop = (status: number) => {
    failure ??= status;
    upstream.abort();
    void reader.cancel().catch(() => {});
  };
  const onDisconnect = () => stop(408);
  request.signal.addEventListener('abort', onDisconnect, { once: true });
  if (request.signal.aborted) onDisconnect();
  const timer = setTimeout(() => stop(readingClient ? 408 : 502), 15_000);

  try {
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          readingClient = true;
          const part = await reader.read();
          if (upstream.signal.aborted) { controller.error(new Error('Upload stopped')); return; }
          if (part.done) {
            if (!received) { stop(400); controller.error(new Error('Empty upload')); return; }
            complete = true;
            controller.close();
          } else if (part.value.byteLength > bodyLimit - received) {
            stop(413);
            controller.error(new Error('Upload limit'));
          } else {
            if (context && received < context.length) context.set(part.value.subarray(0, context.length - received), received);
            received += part.value.byteLength;
            controller.enqueue(part.value);
          }
        } catch { controller.error(new Error('Upload interrupted')); }
        finally { readingClient = false; }
      },
      cancel() { void reader.cancel().catch(() => {}); },
    }, { highWaterMark: 0 });
    const init: RequestInit & { duplex: 'half' } = {
      method: 'POST', body, duplex: 'half', signal: upstream.signal, cache: 'no-store', redirect: 'error',
      headers: { Authorization: authorization, 'Content-Type': mediaType, ...(clarification || activation ? {} : { [filenameHeader]: wire }) },
    };
    const response = await fetch(`${backend.replace(/\/$/, '')}/api/v1/teach-me/${path}`, init);
    if (response.status !== 200 || failure || !complete) {
      void response.body?.cancel().catch(() => {});
      if (failure) return error(failure);
      const allowed = [400, 401, 403, 404, 408, 413, 415, 429].includes(response.status) || ((clarification || activation) && response.status === 409) ||
        (pilot && [500, 503].includes(response.status));
      return error(allowed ? response.status : 502);
    }
    const jsonType = clarification || activation ? /^application\/json(?:\s*;\s*charset=(?:utf-8|"utf-8"))?$/i : /^application\/json(?:\s*;|$)/i;
    if (!jsonType.test(response.headers.get('Content-Type') ?? '')) {
      void response.body?.cancel().catch(() => {});
      return error(502);
    }
    const payload = await boundedJson(response, clarification || activation);
    if (context && !failure) {
      const decode = (bytes: Uint8Array) => new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
      if (activation) {
        const selected = parseActivationRequest(decode(context.subarray(0, received)));
        const result = selected && readActivationResult(payload, selected);
        return result ? Response.json(result, { headers }) : error(502);
      }
      const size = context.readUInt32BE();
      if (!size || size > context.length - 4 || size >= received - 4) return error(502);
      const manifest = JSON.parse(decode(context.subarray(4, size + 4)));
      const result = readPilotPreview(payload, pins);
      if (!result || !Array.isArray(manifest) || manifest.length !== 7) return error(502);
      const { preview, active } = result;
      const binding = [1, 'preview', received - size - 4, preview.profileKey, preview.supplierKey, preview.workbookSha256, preview.revisionId];
      if (!binding.every((value, i) => value === manifest[i]) || revisionFor(preview.workbookSha256) !== preview.revisionId ||
          (active.revisionId !== null && !Array.from(pins).some((pin) => revisionFor(pin) === active.revisionId))) return error(502);
      return Response.json(result, { headers });
    }
    if (previewWire) {
      const result = readTeachDraftPreviewResult(payload);
      if (!result) return error(502);
      const selection = result.kind === 'draft' ? result.draft : result;
      if (createHash('sha256').update(draftPreviewRevisionFields(selection), 'utf8').digest('hex') !== selection.revisionId) return error(502);
      return failure ? error(failure) : Response.json(result, { headers });
    }
    if (clarification) {
      const result = draftWire ? readSupplierDraftResult(payload) : readClarificationResult(payload);
      if (result?.kind === 'draft' && createHash('sha256').update(supplierDraftRevisionFields(result.draft), 'utf8').digest('hex') !== result.draft.revisionId) return error(502);
      return result && !failure ? Response.json(result, { headers }) : error(failure ?? 502);
    }
    const attachment = filename && readTeachReceipt(payload, kind, filename, received);
    return attachment && !failure ? Response.json({ attachment }, { headers }) : error(failure ?? 502);
  } catch { return error(failure ?? 502); }
  finally {
    clearTimeout(timer);
    request.signal.removeEventListener('abort', onDisconnect);
    upstream.abort();
    void reader.cancel().catch(() => {});
    reader.releaseLock();
    active--;
  }
}
