import type { NextApiRequest, NextApiResponse } from 'next';
import { forwardTeachUpload, forwardTeachProposalImport, promotionProxyEnabled } from '@/lib/teach-workbook-proxy';
import { promotionRefHeader } from '@/lib/teach-production-promotion';
import { requestBytes } from '@/lib/teach-raw-request';

// App Router receives Node's normalized headers (duplicate Content-Type can be lost).
// This Pages API boundary exposes rawHeaders and leaves IncomingMessage unparsed.
export async function handleTeachUpload(req: NextApiRequest, res: NextApiResponse,
  path: 'messages' | 'references' | 'clarifications' | 'activation' | 'proposal-import' | 'proposal-imports' | 'proposal-validation' | 'production-promotion', fixturePins?: ReadonlySet<string>) {
  const promote = path === 'production-promotion';
  const methods = promote ? ['GET', 'POST'] : [path === 'proposal-imports' ? 'GET' : 'POST'];
  if (promote && !promotionProxyEnabled()) { res.setHeader('Cache-Control', 'no-store'); res.status(404).end(); return; }
  if (!methods.includes(req.method ?? '')) {
    res.setHeader('Allow', methods.join(', '));
    res.setHeader('Cache-Control', 'no-store');
    res.status(405).end();
    return;
  }

  const disconnect = new AbortController();
  const aborted = () => disconnect.abort();
  req.on('aborted', aborted).on('error', aborted);
  res.on('close', aborted);
  try {
    const request = {
      url: req.url ?? '', signal: disconnect.signal,
      values(name: string) {
        const values: string[] = [];
        for (let i = 0; i < req.rawHeaders.length; i += 2) {
          if (req.rawHeaders[i].toLowerCase() === name.toLowerCase()) {
            values.push(req.rawHeaders[i + 1].replace(/^[\t ]+|[\t ]+$/g, ''));
          }
        }
        return values;
      },
      names: () => req.rawHeaders.filter((_, i) => i % 2 === 0),
      body: () => requestBytes(req),
    };
    const response = await (!promote && request.values(promotionRefHeader).length
      ? new Response(null, { status: 400, headers: { 'Cache-Control': 'no-store' } })
      : path === 'proposal-import' || path === 'proposal-imports' || path === 'proposal-validation' || path === 'production-promotion'
      ? forwardTeachProposalImport(request, path, req.method === 'GET') : forwardTeachUpload(request, path, fixturePins));
    if (res.destroyed) return;
    // On early rejection, do not consume the rest of the upload for keep-alive.
    if (!req.readableEnded) res.setHeader('Connection', 'close');
    response.headers.forEach((value, name) => res.setHeader(name, value));
    res.status(response.status).end(response.body ? await response.text() : undefined);
  } finally {
    req.off('aborted', aborted).off('error', aborted);
    res.off('close', aborted);
  }
}
