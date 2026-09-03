"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState, DragEvent } from 'react';
import {
  UploadCloud,
  File as FileIcon,
  X,
  CheckCircle2,
  AlertCircle,
  Loader2,
  CircleSlash,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useToast } from '@/hooks/use-toast';
import { cn } from '@/lib/utils';
import { Progress } from '@/components/ui/progress';
import { authFetch } from '@/lib/api-client';
import {
  MAX_BATCH_FILES,
  MAX_FILE_SIZE_BYTES,
  UPLOAD_CONCURRENCY,
  createUploadItems,
  runUploadQueue,
  selectPdfFiles,
  type UploadItem,
  type UploadItemStatus,
  type UploadSummary,
} from '@/lib/upload-queue';

/** Uploads one PDF. Throws with the backend's message so the queue can record it. */
async function uploadPriceProposal(file: File, signal: AbortSignal): Promise<void> {
  const formData = new FormData();
  formData.append('file', file);

  const response = await authFetch('/api/price-proposal/upload', {
    method: 'POST',
    body: formData,
    signal,
  });

  const responseText = await response.text();
  let payload: { message?: string } = {};
  try {
    payload = responseText ? JSON.parse(responseText) : {};
  } catch {
    // A non-JSON body (a proxy error page, say) is not fatal on its own; the
    // status code below is what decides success.
    payload = {};
  }

  if (!response.ok) {
    throw new Error(payload?.message ?? `Upload failed (${response.status})`);
  }
}

const STATUS_LABEL: Record<UploadItemStatus, string> = {
  pending: 'Queued',
  uploading: 'Processing…',
  done: 'Stored',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

function StatusIcon({ status }: { status: UploadItemStatus }) {
  switch (status) {
    case 'uploading':
      return <Loader2 className="h-4 w-4 animate-spin text-primary" />;
    case 'done':
      return <CheckCircle2 className="h-4 w-4 text-emerald-600" />;
    case 'failed':
      return <AlertCircle className="h-4 w-4 text-destructive" />;
    case 'cancelled':
      return <CircleSlash className="h-4 w-4 text-muted-foreground" />;
    default:
      return <FileIcon className="h-4 w-4 text-muted-foreground" />;
  }
}

export default function PdfUpload() {
  const [items, setItems] = useState<UploadItem[]>([]);
  const [isUploading, setIsUploading] = useState(false);
  const [isDragActive, setIsDragActive] = useState(false);
  const [summary, setSummary] = useState<UploadSummary | null>(null);
  const { toast } = useToast();
  const inputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  const counts = useMemo(() => {
    const settled = items.filter(item => item.status !== 'pending' && item.status !== 'uploading').length;
    return {
      total: items.length,
      settled,
      done: items.filter(item => item.status === 'done').length,
      failed: items.filter(item => item.status === 'failed').length,
      cancelled: items.filter(item => item.status === 'cancelled').length,
      progress: items.length === 0 ? 0 : Math.round((settled / items.length) * 100),
    };
  }, [items]);

  const retryableCount = counts.failed + counts.cancelled;

  // A batch only lives as long as the page: closing the tab aborts the in-flight
  // requests and drops the queue. Warn first so that is a deliberate choice.
  useEffect(() => {
    if (!isUploading) return;
    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [isUploading]);

  // Navigating away mid-batch should not leave orphaned requests running.
  useEffect(() => () => abortRef.current?.abort(), []);

  const patchItem = useCallback((id: string, patch: Partial<UploadItem>) => {
    setItems(prev => prev.map(item => (item.id === id ? { ...item, ...patch } : item)));
  }, []);

  const addFiles = (incoming: FileList | null) => {
    if (!incoming || incoming.length === 0) return;

    setItems(prev => {
      const { accepted, rejected } = selectPdfFiles(Array.from(incoming), prev.map(item => item.file));

      if (rejected.length > 0) {
        const detail = rejected
          .slice(0, 3)
          .map(entry => `${entry.file.name}: ${entry.reason}`)
          .join(' · ');
        const more = rejected.length > 3 ? ` (+${rejected.length - 3} more)` : '';
        toast({
          variant: 'destructive',
          title: `${rejected.length} file${rejected.length === 1 ? '' : 's'} skipped`,
          description: `${detail}${more}`,
        });
      }

      if (accepted.length === 0) return prev;
      return [...prev, ...createUploadItems(accepted)];
    });

    setSummary(null);
  };

  const handleDrag = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === 'dragenter' || e.type === 'dragover') {
      setIsDragActive(true);
    } else if (e.type === 'dragleave') {
      setIsDragActive(false);
    }
  };

  const handleDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragActive(false);
    addFiles(e.dataTransfer.files);
  };

  const resetInput = () => {
    if (inputRef.current) inputRef.current.value = '';
  };

  const removeItem = (id: string) => {
    setItems(prev => prev.filter(item => item.id !== id));
    resetInput();
  };

  const clearAll = () => {
    setItems([]);
    setSummary(null);
    resetInput();
  };

  const runBatch = async (targets: UploadItem[]) => {
    if (targets.length === 0) return;

    const controller = new AbortController();
    abortRef.current = controller;
    setIsUploading(true);
    setSummary(null);

    try {
      const result = await runUploadQueue({
        items: targets,
        signal: controller.signal,
        concurrency: UPLOAD_CONCURRENCY,
        uploadFile: uploadPriceProposal,
        onItemChange: patchItem,
      });

      setSummary(result);

      if (result.done > 0) {
        // Existing cross-page refresh channel, also used by the sidebar actions.
        window.dispatchEvent(new Event('price-proposals-refresh-requested'));
      }

      if (result.cancelled > 0) {
        toast({
          title: 'Upload stopped',
          description:
            `${result.done} stored, ${result.cancelled} cancelled` +
            (result.failed > 0 ? `, ${result.failed} failed.` : '.') +
            ' Files already stored can be removed from Price Proposals.',
        });
      } else if (result.failed > 0) {
        toast({
          variant: 'destructive',
          title: 'Batch finished with errors',
          description: `${result.done} stored, ${result.failed} failed. Check the list below.`,
        });
      } else {
        toast({
          title: 'Upload successful',
          description: `${result.done} price proposal${result.done === 1 ? '' : 's'} processed and stored.`,
        });
      }
    } finally {
      abortRef.current = null;
      setIsUploading(false);
      resetInput();
    }
  };

  const handleUpload = () => {
    const pending = items.filter(item => item.status === 'pending');
    if (pending.length === 0) {
      toast({
        variant: 'destructive',
        title: 'Nothing to upload',
        description: 'Select at least one PDF price proposal.',
      });
      return;
    }
    void runBatch(pending);
  };

  const handleRetryFailed = () => {
    const retryable = items.filter(item => item.status === 'failed' || item.status === 'cancelled');
    if (retryable.length === 0) return;
    const reset = retryable.map(item => ({ ...item, status: 'pending' as const, error: undefined }));
    setItems(prev =>
      prev.map(item => reset.find(candidate => candidate.id === item.id) ?? item)
    );
    void runBatch(reset);
  };

  const handleStop = () => abortRef.current?.abort();

  return (
    <div className="w-full max-w-2xl mx-auto">
      <div
        onDragEnter={handleDrag}
        onDragLeave={handleDrag}
        onDragOver={handleDrag}
        onDrop={handleDrop}
        onClick={() => !isUploading && inputRef.current?.click()}
        className={cn(
          'flex flex-col items-center justify-center w-full h-64 border-2 border-dashed rounded-lg transition-colors',
          isUploading ? 'cursor-not-allowed opacity-60' : 'cursor-pointer',
          isDragActive ? 'border-primary bg-accent/10' : 'border-border hover:border-primary/50'
        )}
      >
        <input
          ref={inputRef}
          type="file"
          className="hidden"
          accept="application/pdf,.pdf"
          multiple
          disabled={isUploading}
          onChange={e => addFiles(e.target.files)}
        />
        <div className="flex flex-col items-center justify-center pt-5 pb-6 text-center pointer-events-none">
          <UploadCloud className={cn('w-10 h-10 mb-4 text-muted-foreground', isDragActive && 'text-primary')} />
          <p className="mb-2 text-sm text-muted-foreground">
            <span className="font-semibold text-primary">Click to upload</span> or drag and drop
          </p>
          <p className="text-xs text-muted-foreground">
            PDF only, up to {MAX_FILE_SIZE_BYTES / (1024 * 1024)}MB each, {MAX_BATCH_FILES} files per batch
          </p>
        </div>
      </div>

      {items.length > 0 && (
        <div className="mt-6">
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-lg font-medium">
              Selected files ({items.length}/{MAX_BATCH_FILES})
            </h3>
            <Button variant="ghost" size="sm" onClick={clearAll} disabled={isUploading}>
              Clear all
            </Button>
          </div>
          <ul className="space-y-2 max-h-80 overflow-y-auto pr-1">
            {items.map(item => (
              <li key={item.id} className="flex items-center justify-between p-3 bg-muted rounded-lg gap-3">
                <div className="flex items-center gap-3 overflow-hidden">
                  <span className="flex-shrink-0">
                    <StatusIcon status={item.status} />
                  </span>
                  <div className="overflow-hidden">
                    <span className="text-sm font-medium truncate block">{item.file.name}</span>
                    <span
                      className={cn(
                        'text-xs',
                        item.status === 'failed' ? 'text-destructive' : 'text-muted-foreground'
                      )}
                    >
                      {item.error ?? STATUS_LABEL[item.status]}
                    </span>
                  </div>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => removeItem(item.id)}
                  disabled={isUploading}
                  aria-label={`Remove ${item.file.name}`}
                >
                  <X className="h-4 w-4" />
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {isUploading && (
        <div className="mt-6">
          <Progress value={counts.progress} className="w-full" />
          <p className="text-sm text-center mt-2 text-muted-foreground">
            Processing {counts.settled} of {counts.total} · {UPLOAD_CONCURRENCY} at a time
          </p>
        </div>
      )}

      {summary && !isUploading && (
        <div className="mt-6 rounded-lg border p-4 text-sm">
          <p className="font-medium">Batch finished</p>
          <p className="text-muted-foreground mt-1">
            {summary.done} stored
            {summary.failed > 0 && `, ${summary.failed} failed`}
            {summary.cancelled > 0 && `, ${summary.cancelled} cancelled`}.
          </p>
          {summary.cancelled > 0 && (
            <p className="text-muted-foreground mt-2">
              Stopping cancels everything still queued, but files already stored stay stored —
              remove them from the Price Proposals page if they were uploaded by mistake.
            </p>
          )}
        </div>
      )}

      <div className="mt-8 flex justify-end gap-2">
        {retryableCount > 0 && !isUploading && (
          <Button variant="outline" onClick={handleRetryFailed}>
            Retry {retryableCount} file{retryableCount === 1 ? '' : 's'}
          </Button>
        )}
        {isUploading ? (
          <Button variant="destructive" onClick={handleStop}>
            Stop
          </Button>
        ) : (
          <Button
            onClick={handleUpload}
            disabled={items.every(item => item.status !== 'pending')}
            style={{ backgroundColor: 'var(--accent)', color: 'var(--accent-foreground)' }}
          >
            Upload price proposals
          </Button>
        )}
      </div>
    </div>
  );
}
