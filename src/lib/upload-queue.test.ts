// @vitest-environment node

/**
 * Unit tests for the client-side batch upload queue.
 *
 * This module is deliberately free of React, DOM and network access, so these
 * tests need no rendering and no HTTP mocking — `uploadFile` is just a function
 * the test supplies. That makes it the cheapest place to pin down the tricky
 * parts of bulk upload: validation rules, bounded concurrency and cancellation.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  MAX_BATCH_FILES,
  MAX_FILE_SIZE_BYTES,
  UPLOAD_CONCURRENCY,
  createUploadItems,
  runUploadQueue,
  selectPdfFiles,
  type UploadItem,
} from '@/lib/upload-queue';

/**
 * Builds a `File` of an exact byte size without allocating a real buffer of
 * that size for the large cases — `size` is derived from the blob parts, so a
 * single padded string is enough and keeps the 10MB tests instant.
 */
function makeFile(
  name: string,
  { type = 'application/pdf', size = 1024 }: { type?: string; size?: number } = {}
): File {
  return new File([new Uint8Array(size)], name, { type });
}

function itemsOf(...files: File[]): UploadItem[] {
  return createUploadItems(files);
}

describe('selectPdfFiles', () => {
  it('accepts PDFs by MIME type', () => {
    const file = makeFile('proposal.pdf');

    const { accepted, rejected } = selectPdfFiles([file]);

    expect(accepted).toEqual([file]);
    expect(rejected).toEqual([]);
  });

  it('accepts a .pdf whose MIME type the browser failed to report', () => {
    // Drag-and-drop from some file managers yields an empty `type`. Falling back
    // to the extension is the whole reason `isPdf` checks both.
    const file = makeFile('dragged.pdf', { type: '' });

    const { accepted, rejected } = selectPdfFiles([file]);

    expect(accepted).toEqual([file]);
    expect(rejected).toEqual([]);
  });

  it('accepts a .PDF extension regardless of case', () => {
    const file = makeFile('SCANNED.PDF', { type: 'application/octet-stream' });

    expect(selectPdfFiles([file]).accepted).toEqual([file]);
  });

  it('rejects non-PDF files with a reason', () => {
    const pdf = makeFile('proposal.pdf');
    const image = makeFile('photo.png', { type: 'image/png' });

    const { accepted, rejected } = selectPdfFiles([pdf, image]);

    expect(accepted).toEqual([pdf]);
    expect(rejected).toEqual([{ file: image, reason: 'Not a PDF' }]);
  });

  it('rejects files above the size limit and reports both sizes', () => {
    const tooBig = makeFile('huge.pdf', { size: MAX_FILE_SIZE_BYTES + 1 });

    const { accepted, rejected } = selectPdfFiles([tooBig]);

    expect(accepted).toEqual([]);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBe('Larger than 10.0MB (10.0MB)');
  });

  it('accepts a file exactly at the size limit', () => {
    // The check is `>`, not `>=`; a boundary flip here would reject valid files.
    const exact = makeFile('exact.pdf', { size: MAX_FILE_SIZE_BYTES });

    expect(selectPdfFiles([exact]).accepted).toEqual([exact]);
  });

  it('rejects a file already staged, matching on name and size', () => {
    const staged = makeFile('proposal.pdf', { size: 2048 });
    const duplicate = makeFile('proposal.pdf', { size: 2048 });

    const { accepted, rejected } = selectPdfFiles([duplicate], [staged]);

    expect(accepted).toEqual([]);
    expect(rejected).toEqual([{ file: duplicate, reason: 'Already selected' }]);
  });

  it('treats same-named files of different sizes as distinct', () => {
    const staged = makeFile('proposal.pdf', { size: 2048 });
    const other = makeFile('proposal.pdf', { size: 4096 });

    expect(selectPdfFiles([other], [staged]).accepted).toEqual([other]);
  });

  it('deduplicates within a single selection', () => {
    const first = makeFile('proposal.pdf', { size: 2048 });
    const second = makeFile('proposal.pdf', { size: 2048 });

    const { accepted, rejected } = selectPdfFiles([first, second]);

    expect(accepted).toEqual([first]);
    expect(rejected).toEqual([{ file: second, reason: 'Already selected' }]);
  });

  it('caps a selection at the batch limit', () => {
    const files = Array.from({ length: MAX_BATCH_FILES + 2 }, (_, i) =>
      makeFile(`proposal-${i}.pdf`)
    );

    const { accepted, rejected } = selectPdfFiles(files);

    expect(accepted).toHaveLength(MAX_BATCH_FILES);
    expect(rejected).toHaveLength(2);
    expect(rejected[0].reason).toBe(`Batch limit of ${MAX_BATCH_FILES} files reached`);
  });

  it('counts already-staged files against the batch limit', () => {
    const staged = Array.from({ length: MAX_BATCH_FILES - 1 }, (_, i) =>
      makeFile(`staged-${i}.pdf`)
    );
    const incoming = [makeFile('new-a.pdf'), makeFile('new-b.pdf')];

    const { accepted, rejected } = selectPdfFiles(incoming, staged);

    expect(accepted).toEqual([incoming[0]]);
    expect(rejected).toEqual([
      { file: incoming[1], reason: `Batch limit of ${MAX_BATCH_FILES} files reached` },
    ]);
  });

  it('applies the rules in order: type, then size, then duplicate, then limit', () => {
    // A file can fail several rules at once; the reported reason should be the
    // most specific thing wrong with it, not whichever check happens to run last.
    const oversizedImage = makeFile('photo.png', {
      type: 'image/png',
      size: MAX_FILE_SIZE_BYTES + 1,
    });

    expect(selectPdfFiles([oversizedImage]).rejected[0].reason).toBe('Not a PDF');
  });

  it('returns empty halves for an empty selection', () => {
    expect(selectPdfFiles([])).toEqual({ accepted: [], rejected: [] });
  });

  it('does not mutate the caller\'s arrays', () => {
    const incoming = [makeFile('a.pdf')];
    const staged = [makeFile('b.pdf')];

    selectPdfFiles(incoming, staged);

    expect(incoming).toHaveLength(1);
    expect(staged).toHaveLength(1);
  });
});

describe('createUploadItems', () => {
  it('creates one pending item per file, preserving order', () => {
    const files = [makeFile('a.pdf'), makeFile('b.pdf')];

    const items = createUploadItems(files);

    expect(items).toHaveLength(2);
    expect(items.map(item => item.file)).toEqual(files);
    expect(items.every(item => item.status === 'pending')).toBe(true);
    expect(items.every(item => item.error === undefined)).toBe(true);
  });

  it('assigns unique ids, which the queue relies on to patch the right row', () => {
    // Same name and size: if ids were derived only from file metadata these two
    // would collide and the UI would update one row twice.
    const items = createUploadItems([
      makeFile('proposal.pdf', { size: 2048 }),
      makeFile('proposal.pdf', { size: 2048 }),
    ]);

    expect(new Set(items.map(item => item.id)).size).toBe(2);
  });
});

describe('runUploadQueue', () => {
  const neverAborted = () => new AbortController().signal;

  it('uploads every file and reports them all as done', async () => {
    const items = itemsOf(makeFile('a.pdf'), makeFile('b.pdf'), makeFile('c.pdf'));
    const uploadFile = vi.fn().mockResolvedValue(undefined);
    const onItemChange = vi.fn();

    const summary = await runUploadQueue({
      items,
      signal: neverAborted(),
      uploadFile,
      onItemChange,
    });

    expect(summary).toEqual({ done: 3, failed: 0, cancelled: 0 });
    expect(uploadFile).toHaveBeenCalledTimes(3);
    expect(uploadFile.mock.calls.map(call => (call[0] as File).name)).toEqual([
      'a.pdf',
      'b.pdf',
      'c.pdf',
    ]);
  });

  it('marks each item uploading and then done, in that order', async () => {
    const items = itemsOf(makeFile('a.pdf'));
    const onItemChange = vi.fn();

    await runUploadQueue({
      items,
      signal: neverAborted(),
      uploadFile: vi.fn().mockResolvedValue(undefined),
      onItemChange,
    });

    expect(onItemChange.mock.calls).toEqual([
      [items[0].id, { status: 'uploading', error: undefined }],
      [items[0].id, { status: 'done' }],
    ]);
  });

  it('leaves no item without a terminal status', async () => {
    const items = itemsOf(...Array.from({ length: 9 }, (_, i) => makeFile(`f-${i}.pdf`)));
    const statuses = new Map<string, string>();

    await runUploadQueue({
      items,
      signal: neverAborted(),
      // A mix of outcomes, so this is not just testing the happy path.
      uploadFile: (file: File) =>
        file.name.endsWith('3.pdf') ? Promise.reject(new Error('boom')) : Promise.resolve(),
      onItemChange: (id, patch) => {
        if (patch.status) statuses.set(id, patch.status);
      },
    });

    expect(statuses.size).toBe(items.length);
    expect([...statuses.values()].every(status => status !== 'pending' && status !== 'uploading')).toBe(
      true
    );
  });

  it('keeps going after a failure and records the error message', async () => {
    const items = itemsOf(makeFile('good.pdf'), makeFile('bad.pdf'), makeFile('good-2.pdf'));
    const patches: Array<[string, unknown]> = [];

    const summary = await runUploadQueue({
      items,
      signal: neverAborted(),
      concurrency: 1,
      uploadFile: (file: File) =>
        file.name === 'bad.pdf'
          ? Promise.reject(new Error('Could not extract tables'))
          : Promise.resolve(),
      onItemChange: (id, patch) => patches.push([id, patch]),
    });

    expect(summary).toEqual({ done: 2, failed: 1, cancelled: 0 });
    expect(patches).toContainEqual([
      items[1].id,
      { status: 'failed', error: 'Could not extract tables' },
    ]);
  });

  it('falls back to a generic message when a non-Error is thrown', async () => {
    const items = itemsOf(makeFile('a.pdf'));
    const onItemChange = vi.fn();

    await runUploadQueue({
      items,
      signal: neverAborted(),
      // eslint-disable-next-line prefer-promise-reject-errors
      uploadFile: () => Promise.reject('a bare string'),
      onItemChange,
    });

    expect(onItemChange).toHaveBeenLastCalledWith(items[0].id, {
      status: 'failed',
      error: 'Unexpected upload error',
    });
  });

  it('never rejects, even when every file fails', async () => {
    const items = itemsOf(makeFile('a.pdf'), makeFile('b.pdf'));

    const summary = await runUploadQueue({
      items,
      signal: neverAborted(),
      uploadFile: () => Promise.reject(new Error('backend down')),
      onItemChange: vi.fn(),
    });

    expect(summary).toEqual({ done: 0, failed: 2, cancelled: 0 });
  });

  it('returns a summary consistent with the statuses it reported', async () => {
    // The counters are incremented independently of the `onItemChange` patches,
    // so they can silently drift apart. This pins them together.
    const items = itemsOf(...Array.from({ length: 12 }, (_, i) => makeFile(`f-${i}.pdf`)));
    const tally = { done: 0, failed: 0, cancelled: 0 };

    const summary = await runUploadQueue({
      items,
      signal: neverAborted(),
      uploadFile: (file: File) =>
        Number(file.name.match(/\d+/)![0]) % 4 === 0
          ? Promise.reject(new Error('nope'))
          : Promise.resolve(),
      onItemChange: (_id, patch) => {
        if (patch.status === 'done') tally.done += 1;
        if (patch.status === 'failed') tally.failed += 1;
        if (patch.status === 'cancelled') tally.cancelled += 1;
      },
    });

    expect(summary).toEqual(tally);
    expect(summary.done + summary.failed + summary.cancelled).toBe(items.length);
  });

  describe('concurrency', () => {
    /**
     * Hands back a controllable `uploadFile`: it records how many calls are in
     * flight and only settles when the test says so. Real timers would make the
     * assertions racy; manual resolution makes them deterministic.
     */
    function deferredUploader() {
      const resolvers: Array<() => void> = [];
      let inFlight = 0;
      let maxInFlight = 0;

      const uploadFile = () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        return new Promise<void>(resolve => {
          resolvers.push(() => {
            inFlight -= 1;
            resolve();
          });
        });
      };

      return {
        uploadFile,
        get maxInFlight() {
          return maxInFlight;
        },
        get started() {
          return resolvers.length;
        },
        /** Lets the event loop run so pending workers can start their request. */
        flush: () => new Promise(resolve => setTimeout(resolve, 0)),
        resolveAll: () => {
          while (resolvers.length > 0) resolvers.shift()!();
        },
      };
    }

    /**
     * Settles every in-flight request repeatedly until the queue finishes.
     *
     * Workers only pick up the next file once the current one settles, so a
     * single `resolveAll()` drains one "round" of at most `concurrency` files.
     * The bound guards against an infinite loop if the queue ever stalls.
     */
    async function drain<T>(uploader: ReturnType<typeof deferredUploader>, run: Promise<T>) {
      let settled = false;
      const tracked = run.then(result => {
        settled = true;
        return result;
      });

      for (let round = 0; round < 100 && !settled; round += 1) {
        uploader.resolveAll();
        await uploader.flush();
      }

      return tracked;
    }

    it('never exceeds the requested concurrency', async () => {
      const uploader = deferredUploader();
      const items = itemsOf(...Array.from({ length: 12 }, (_, i) => makeFile(`f-${i}.pdf`)));

      const run = runUploadQueue({
        items,
        signal: neverAborted(),
        concurrency: 3,
        uploadFile: uploader.uploadFile,
        onItemChange: vi.fn(),
      });

      await uploader.flush();
      expect(uploader.started).toBe(3);

      const summary = await drain(uploader, run);

      expect(uploader.maxInFlight).toBe(3);
      expect(summary.done).toBe(12);
    });

    it('defaults to the shared UPLOAD_CONCURRENCY', async () => {
      const uploader = deferredUploader();
      const items = itemsOf(
        ...Array.from({ length: UPLOAD_CONCURRENCY + 4 }, (_, i) => makeFile(`f-${i}.pdf`))
      );

      const run = runUploadQueue({
        items,
        signal: neverAborted(),
        uploadFile: uploader.uploadFile,
        onItemChange: vi.fn(),
      });

      await uploader.flush();
      expect(uploader.started).toBe(UPLOAD_CONCURRENCY);

      await drain(uploader, run);

      expect(uploader.maxInFlight).toBe(UPLOAD_CONCURRENCY);
    });

    it('spawns no more workers than there are files', async () => {
      const uploader = deferredUploader();
      const items = itemsOf(makeFile('a.pdf'), makeFile('b.pdf'));

      const run = runUploadQueue({
        items,
        signal: neverAborted(),
        concurrency: 10,
        uploadFile: uploader.uploadFile,
        onItemChange: vi.fn(),
      });

      await uploader.flush();
      expect(uploader.started).toBe(2);

      uploader.resolveAll();
      await run;
    });

    it('processes each file exactly once across workers', async () => {
      // Two workers sharing a cursor could hand the same index to both.
      const items = itemsOf(...Array.from({ length: 20 }, (_, i) => makeFile(`f-${i}.pdf`)));
      const seen: string[] = [];

      await runUploadQueue({
        items,
        signal: neverAborted(),
        concurrency: 5,
        uploadFile: async (file: File) => {
          await Promise.resolve();
          seen.push(file.name);
        },
        onItemChange: vi.fn(),
      });

      expect(seen).toHaveLength(20);
      expect(new Set(seen).size).toBe(20);
    });

    it('resolves without hanging on an empty queue', async () => {
      const uploadFile = vi.fn();

      const summary = await runUploadQueue({
        items: [],
        signal: neverAborted(),
        uploadFile,
        onItemChange: vi.fn(),
      });

      expect(summary).toEqual({ done: 0, failed: 0, cancelled: 0 });
      expect(uploadFile).not.toHaveBeenCalled();
    });
  });

  describe('cancellation', () => {
    it('cancels everything and uploads nothing when aborted up front', async () => {
      const controller = new AbortController();
      controller.abort();
      const items = itemsOf(makeFile('a.pdf'), makeFile('b.pdf'));
      const uploadFile = vi.fn();
      const onItemChange = vi.fn();

      const summary = await runUploadQueue({
        items,
        signal: controller.signal,
        uploadFile,
        onItemChange,
      });

      expect(summary).toEqual({ done: 0, failed: 0, cancelled: 2 });
      expect(uploadFile).not.toHaveBeenCalled();
      expect(onItemChange).toHaveBeenCalledWith(items[0].id, { status: 'cancelled' });
      expect(onItemChange).toHaveBeenCalledWith(items[1].id, { status: 'cancelled' });
    });

    it('keeps files finished before the abort as done', async () => {
      const controller = new AbortController();
      const items = itemsOf(...Array.from({ length: 6 }, (_, i) => makeFile(`f-${i}.pdf`)));
      let completed = 0;

      const summary = await runUploadQueue({
        items,
        signal: controller.signal,
        concurrency: 1,
        uploadFile: async () => {
          completed += 1;
          // Abort partway through, the way a user hitting Stop would.
          if (completed === 2) controller.abort();
        },
        onItemChange: vi.fn(),
      });

      expect(summary).toEqual({ done: 2, failed: 0, cancelled: 4 });
    });

    it('classifies an in-flight rejection after abort as cancelled, not failed', async () => {
      // `fetch` rejects with an AbortError when the signal fires. That is a
      // cancellation, and must not be reported to the user as a real failure.
      const controller = new AbortController();
      const items = itemsOf(makeFile('a.pdf'));
      const onItemChange = vi.fn();

      const summary = await runUploadQueue({
        items,
        signal: controller.signal,
        uploadFile: (_file: File, signal: AbortSignal) =>
          new Promise<void>((_resolve, reject) => {
            signal.addEventListener('abort', () =>
              reject(new DOMException('The operation was aborted.', 'AbortError'))
            );
            controller.abort();
          }),
        onItemChange,
      });

      expect(summary).toEqual({ done: 0, failed: 0, cancelled: 1 });
      expect(onItemChange).toHaveBeenLastCalledWith(items[0].id, { status: 'cancelled' });
    });

    it('forwards the signal to uploadFile so requests can be torn down', async () => {
      const controller = new AbortController();
      const uploadFile = vi.fn().mockResolvedValue(undefined);

      await runUploadQueue({
        items: itemsOf(makeFile('a.pdf')),
        signal: controller.signal,
        uploadFile,
        onItemChange: vi.fn(),
      });

      expect(uploadFile).toHaveBeenCalledWith(expect.any(File), controller.signal);
    });
  });
});
