/**
 * Client-side batch upload queue.
 *
 * Price proposals are uploaded one file per HTTP request, with a bounded number
 * of requests in flight. This is deliberate: the backend's
 * `POST /api/v1/upload-price-proposal` takes a single PDF, and BmPriceAgent
 * parallelises across *concurrent requests* (its `MAX_CONCURRENCY` semaphore),
 * not within one. Fanning out from the browser therefore gives real parallelism,
 * per-file progress and per-file errors without any backend change.
 *
 * Cancellation is cooperative and honest about its limits: aborting stops
 * everything still queued and stops us waiting on what is in flight, but files
 * that already completed are already stored server-side, and an in-flight
 * extraction may still land. Recovery for those is the bulk-delete action on the
 * price proposals page.
 */

/** Requests in flight at once. Matches BmPriceAgent's `MAX_CONCURRENCY` default. */
export const UPLOAD_CONCURRENCY = 5;

/** Upper bound on a single batch, to fail fast on an accidental huge selection. */
export const MAX_BATCH_FILES = 30;

/** Advertised in the dropzone copy; enforced here rather than just claimed. */
export const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024;

export type UploadItemStatus = 'pending' | 'uploading' | 'done' | 'failed' | 'cancelled';

export interface UploadItem {
  id: string;
  file: File;
  status: UploadItemStatus;
  error?: string;
}

export interface RejectedFile {
  file: File;
  reason: string;
}

export interface FileSelection {
  accepted: File[];
  rejected: RejectedFile[];
}

export interface UploadSummary {
  done: number;
  failed: number;
  cancelled: number;
}

function isPdf(file: File): boolean {
  // Some browsers/OSes report an empty or generic MIME type for drag-and-dropped
  // files, so the extension is checked as a fallback rather than trusting `type`.
  return file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
}

function formatMegabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/**
 * Validates an incoming selection against what is already staged.
 *
 * `batchFileCount` is separate from `alreadySelected` because settled files can
 * remain visible (and should still be detected as duplicates) without
 * consuming capacity in the next batch.
 *
 * Returns both halves so the caller can stage the good files and tell the user
 * precisely which ones were dropped and why — a silent `slice()` is how the
 * previous single-file limit confused people.
 */
export function selectPdfFiles(
  incoming: File[],
  alreadySelected: File[] = [],
  batchFileCount = alreadySelected.length
): FileSelection {
  const accepted: File[] = [];
  const rejected: RejectedFile[] = [];

  const seen = new Set(alreadySelected.map(file => `${file.name}:${file.size}`));
  let remainingSlots = MAX_BATCH_FILES - batchFileCount;

  for (const file of incoming) {
    if (!isPdf(file)) {
      rejected.push({ file, reason: 'Not a PDF' });
      continue;
    }

    if (file.size > MAX_FILE_SIZE_BYTES) {
      rejected.push({
        file,
        reason: `Larger than ${formatMegabytes(MAX_FILE_SIZE_BYTES)} (${formatMegabytes(file.size)})`,
      });
      continue;
    }

    const key = `${file.name}:${file.size}`;
    if (seen.has(key)) {
      rejected.push({ file, reason: 'Already selected' });
      continue;
    }

    if (remainingSlots <= 0) {
      rejected.push({ file, reason: `Batch limit of ${MAX_BATCH_FILES} files reached` });
      continue;
    }

    seen.add(key);
    remainingSlots -= 1;
    accepted.push(file);
  }

  return { accepted, rejected };
}

export function createUploadItems(files: File[]): UploadItem[] {
  return files.map(file => ({
    id: typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${file.name}-${file.size}-${Math.random().toString(36).slice(2)}`,
    file,
    status: 'pending' as const,
  }));
}

export interface RunUploadQueueOptions {
  items: UploadItem[];
  signal: AbortSignal;
  concurrency?: number;
  uploadFile: (file: File, signal: AbortSignal) => Promise<void>;
  onItemChange: (id: string, patch: Partial<UploadItem>) => void;
}

/**
 * Drains `items` through `uploadFile`, at most `concurrency` at a time.
 *
 * Never rejects: a per-file failure is recorded on that item and the queue keeps
 * going, so one bad PDF cannot take down the rest of the batch.
 */
export async function runUploadQueue({
  items,
  signal,
  concurrency = UPLOAD_CONCURRENCY,
  uploadFile,
  onItemChange,
}: RunUploadQueueOptions): Promise<UploadSummary> {
  const queue = [...items];
  const summary: UploadSummary = { done: 0, failed: 0, cancelled: 0 };
  let cursor = 0;

  const worker = async (): Promise<void> => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= queue.length) return;

      const item = queue[index];

      // Once aborted we keep draining, but only to mark the remainder as
      // cancelled so the UI reflects the final state of every file.
      if (signal.aborted) {
        onItemChange(item.id, { status: 'cancelled' });
        summary.cancelled += 1;
        continue;
      }

      onItemChange(item.id, { status: 'uploading', error: undefined });

      try {
        await uploadFile(item.file, signal);
        onItemChange(item.id, { status: 'done' });
        summary.done += 1;
      } catch (error) {
        if (signal.aborted) {
          onItemChange(item.id, { status: 'cancelled' });
          summary.cancelled += 1;
        } else {
          const message = error instanceof Error ? error.message : 'Unexpected upload error';
          onItemChange(item.id, { status: 'failed', error: message });
          summary.failed += 1;
        }
      }
    }
  };

  const workerCount = Math.max(1, Math.min(concurrency, queue.length));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  return summary;
}
