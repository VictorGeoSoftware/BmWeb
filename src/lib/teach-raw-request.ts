import type { IncomingMessage } from 'node:http';
import { validTeachFilename } from '@/lib/teach-workbook';

export function filenameFromHeader(wire: string | null) {
  if (!wire || !/^[A-Za-z0-9_-]{1,340}$/.test(wire)) return null;
  try {
    const bytes = Buffer.from(wire, 'base64url');
    if (bytes.length > 255 || bytes.toString('base64url') !== wire) return null;
    const name = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    return validTeachFilename(name) ? name : null;
  } catch { return null; }
}

/** Use the paused Node stream. Only read on downstream demand; cancel without draining. */
export function requestBytes(req: IncomingMessage) {
  let clear: (() => void) | undefined;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      return new Promise<void>((resolve) => {
        const finish = () => { clear?.(); resolve(); };
        const error = () => { finish(); controller.error(new Error('Client stream closed')); };
        const end = () => { finish(); controller.close(); };
        const read = () => {
          const bytes = req.read(Math.min(req.readableLength, 8192)) as Buffer | null;
          if (bytes !== null) { finish(); controller.enqueue(bytes); }
          else if (req.readableEnded) end();
        };
        clear = () => {
          req.off('readable', read).off('end', end).off('close', error);
          clear = undefined;
          resolve();
        };
        if (req.destroyed && !req.readableEnded) { error(); return; }
        req.on('readable', read).once('end', end).once('close', error);
        read();
      });
    },
    cancel() { clear?.(); },
  }, { highWaterMark: 0 });
}
