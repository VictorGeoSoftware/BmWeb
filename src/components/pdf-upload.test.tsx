/**
 * Component tests for the bulk PDF upload view.
 *
 * These render the real component into jsdom and drive it the way a user would
 * — picking files, clicking buttons — asserting only on what ends up on screen.
 * The single seam is the network: `authFetch` is mocked so each test can decide
 * what the backend says, while the queue, state machine and rendering all run
 * for real.
 */

import { StrictMode } from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// `@/lib/api-client` imports the Firebase client at module scope, which would
// try to initialise an app with no config. Mocking the module keeps the test
// from ever touching Firebase.
vi.mock('@/lib/api-client', () => ({
  authFetch: vi.fn(),
}));

// The toast system renders into a provider the component tree does not include
// here, so assert on the calls instead of on rendered toast markup.
// `vi.mock` factories are hoisted above the imports, so the spy has to be
// created with `vi.hoisted` to exist by the time the factory runs.
const { toastMock } = vi.hoisted(() => ({ toastMock: vi.fn() }));
vi.mock('@/hooks/use-toast', () => ({
  useToast: () => ({ toast: toastMock, toasts: [], dismiss: vi.fn() }),
  toast: toastMock,
}));

import PdfUpload from '@/components/pdf-upload';
import { authFetch } from '@/lib/api-client';
import { MAX_BATCH_FILES, MAX_FILE_SIZE_BYTES } from '@/lib/upload-queue';

const authFetchMock = vi.mocked(authFetch);

function pdf(name: string, size = 1024): File {
  return new File([new Uint8Array(size)], name, { type: 'application/pdf' });
}

/**
 * A backend reply the component will treat as success.
 *
 * Returned from a factory, never shared: a `Response` body can only be read
 * once, so handing the same instance to two uploads would make the second fail
 * with "body already read" and quietly invalidate the test.
 */
function ok(body: unknown = { success: true }): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

/** A backend reply carrying an error message the UI is expected to surface. */
function serverError(message: string, status = 500): Response {
  return new Response(JSON.stringify({ success: false, message }), { status });
}

/** Answers every upload with a freshly built response. */
function respondWith(build: () => Response) {
  authFetchMock.mockImplementation(async () => build());
}

/** The hidden `<input type="file">` behind the dropzone. */
function fileInput(): HTMLInputElement {
  const input = document.querySelector('input[type="file"]');
  if (!input) throw new Error('file input not found');
  return input as HTMLInputElement;
}

/**
 * Drops files onto the dropzone.
 *
 * The file picker filters by the input's `accept` attribute before the app sees
 * anything, so drag-and-drop is the only route by which a non-PDF can actually
 * reach the component. That is the path the validation rules exist for.
 */
function dropFiles(files: File[]) {
  const dropzone = fileInput().parentElement as HTMLElement;
  fireEvent.drop(dropzone, {
    dataTransfer: { files, items: [], types: ['Files'] },
  });
}

function uploadButton() {
  return screen.getByRole('button', { name: /upload price proposals/i });
}

/** The `<li>` rendered for a given file, so status assertions stay scoped. */
function rowFor(name: string): HTMLElement {
  return screen.getByText(name).closest('li') as HTMLElement;
}

beforeEach(() => {
  toastMock.mockClear();
  authFetchMock.mockReset();
  respondWith(() => ok());
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('PdfUpload', () => {
  describe('selecting files', () => {
    it('advertises the batch limits it actually enforces', () => {
      render(<PdfUpload />);

      expect(
        screen.getByText(
          `PDF only, up to ${MAX_FILE_SIZE_BYTES / (1024 * 1024)}MB each, ${MAX_BATCH_FILES} files per batch`
        )
      ).toBeInTheDocument();
    });

    it('accepts multiple files at once', async () => {
      const user = userEvent.setup();
      render(<PdfUpload />);

      await user.upload(fileInput(), [pdf('a.pdf'), pdf('b.pdf'), pdf('c.pdf')]);

      expect(screen.getByText(`Files (3/${MAX_BATCH_FILES} in current batch)`)).toBeInTheDocument();
      expect(screen.getByText('a.pdf')).toBeInTheDocument();
      expect(screen.getByText('c.pdf')).toBeInTheDocument();
    });

    it('allows the file input to take more than one file', () => {
      // Without `multiple` the browser silently drops all but the first file,
      // which is exactly the single-file behaviour this feature replaced.
      render(<PdfUpload />);

      expect(fileInput()).toHaveAttribute('multiple');
    });

    it('adds to the staged list instead of replacing it', async () => {
      const user = userEvent.setup();
      render(<PdfUpload />);

      await user.upload(fileInput(), [pdf('a.pdf')]);
      await user.upload(fileInput(), [pdf('b.pdf')]);

      expect(screen.getByText(`Files (2/${MAX_BATCH_FILES} in current batch)`)).toBeInTheDocument();
    });

    it('keeps the PDFs and warns about the files it skipped', async () => {
      render(<PdfUpload />);

      dropFiles([pdf('proposal.pdf'), new File(['x'], 'photo.png', { type: 'image/png' })]);

      expect(await screen.findByText('proposal.pdf')).toBeInTheDocument();
      expect(screen.queryByText('photo.png')).not.toBeInTheDocument();
      expect(toastMock).toHaveBeenCalledWith(
        expect.objectContaining({
          variant: 'destructive',
          title: '1 file skipped',
          description: 'photo.png: Not a PDF',
        })
      );
    });

    it('rejects a PDF that is over the size limit', async () => {
      const user = userEvent.setup();
      render(<PdfUpload />);

      await user.upload(fileInput(), [pdf('huge.pdf', MAX_FILE_SIZE_BYTES + 1)]);

      expect(screen.queryByText('huge.pdf')).not.toBeInTheDocument();
      expect(toastMock).toHaveBeenCalledWith(
        expect.objectContaining({
          title: '1 file skipped',
          description: 'huge.pdf: Larger than 10.0MB (10.0MB)',
        })
      );
    });

    it('summarises long reject lists rather than listing every file', async () => {
      render(<PdfUpload />);

      dropFiles(
        Array.from({ length: 5 }, (_, i) => new File(['x'], `img-${i}.png`, { type: 'image/png' }))
      );

      await waitFor(() =>
        expect(toastMock).toHaveBeenCalledWith(
          expect.objectContaining({
            title: '5 files skipped',
            description: expect.stringContaining('(+2 more)'),
          })
        )
      );
    });

    it('warns exactly once per selection, even under StrictMode', async () => {
      // React double-invokes state updaters under StrictMode to surface impure
      // ones, and Next runs the app in StrictMode in development. `addFiles`
      // computes the rejected list inside a `setItems` updater and toasts from
      // there, so a replayed updater would double-warn the user.
      //
      // The mix matters: a selection where everything is rejected returns the
      // previous state unchanged, React bails out of the re-render and the
      // updater is never replayed. Accepting at least one file is what forces
      // the replay, so that is the case worth pinning.
      render(
        <StrictMode>
          <PdfUpload />
        </StrictMode>
      );

      dropFiles([pdf('good.pdf'), new File(['x'], 'photo.png', { type: 'image/png' })]);

      expect(await screen.findByText('good.pdf')).toBeInTheDocument();
      expect(toastMock).toHaveBeenCalledTimes(1);
    });

    it('does not warn when every file is valid', async () => {
      const user = userEvent.setup();
      render(<PdfUpload />);

      await user.upload(fileInput(), [pdf('a.pdf'), pdf('b.pdf')]);

      expect(toastMock).not.toHaveBeenCalled();
    });

    it('rejects a duplicate of an already staged file', async () => {
      const user = userEvent.setup();
      render(<PdfUpload />);

      await user.upload(fileInput(), [pdf('proposal.pdf', 2048)]);
      await user.upload(fileInput(), [pdf('proposal.pdf', 2048)]);

      expect(screen.getByText(`Files (1/${MAX_BATCH_FILES} in current batch)`)).toBeInTheDocument();
      expect(toastMock).toHaveBeenCalledWith(
        expect.objectContaining({ description: 'proposal.pdf: Already selected' })
      );
    });

    it('removes a single file without disturbing the others', async () => {
      const user = userEvent.setup();
      render(<PdfUpload />);
      await user.upload(fileInput(), [pdf('a.pdf'), pdf('b.pdf'), pdf('c.pdf')]);

      await user.click(screen.getByRole('button', { name: 'Remove b.pdf' }));

      expect(screen.getByText('a.pdf')).toBeInTheDocument();
      expect(screen.queryByText('b.pdf')).not.toBeInTheDocument();
      expect(screen.getByText('c.pdf')).toBeInTheDocument();
    });

    it('clears the whole selection on Clear all', async () => {
      const user = userEvent.setup();
      render(<PdfUpload />);
      await user.upload(fileInput(), [pdf('a.pdf'), pdf('b.pdf')]);

      await user.click(screen.getByRole('button', { name: /clear all/i }));

      expect(screen.queryByText('a.pdf')).not.toBeInTheDocument();
      expect(screen.queryByText(/in current batch/)).not.toBeInTheDocument();
    });

    it('shows no file list before anything is selected', () => {
      render(<PdfUpload />);

      expect(screen.queryByText(/in current batch/)).not.toBeInTheDocument();
      expect(uploadButton()).toBeDisabled();
    });
  });

  describe('uploading a batch', () => {
    it('sends one request per file, each carrying its own PDF', async () => {
      const user = userEvent.setup();
      render(<PdfUpload />);
      await user.upload(fileInput(), [pdf('a.pdf'), pdf('b.pdf')]);

      await user.click(uploadButton());

      await waitFor(() => expect(authFetchMock).toHaveBeenCalledTimes(2));

      const sentNames = authFetchMock.mock.calls.map(([, init]) => {
        const body = init?.body as FormData;
        return (body.get('file') as File).name;
      });
      expect(sentNames.sort()).toEqual(['a.pdf', 'b.pdf']);

      for (const [url, init] of authFetchMock.mock.calls) {
        expect(url).toBe('/api/price-proposal/upload');
        expect(init?.method).toBe('POST');
        // The signal is what makes the Stop button able to tear requests down.
        expect(init?.signal).toBeInstanceOf(AbortSignal);
      }
    });

    it('marks every file stored and reports a clean batch', async () => {
      const user = userEvent.setup();
      render(<PdfUpload />);
      await user.upload(fileInput(), [pdf('a.pdf'), pdf('b.pdf')]);

      await user.click(uploadButton());

      await screen.findByText('Batch finished');
      expect(within(rowFor('a.pdf')).getByText('Stored')).toBeInTheDocument();
      expect(within(rowFor('b.pdf')).getByText('Stored')).toBeInTheDocument();
      expect(screen.getByText('2 stored.')).toBeInTheDocument();
      expect(toastMock).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Upload successful',
          description: '2 price proposals processed and stored.',
        })
      );
    });

    it('uses the singular form for a batch of one', async () => {
      const user = userEvent.setup();
      render(<PdfUpload />);
      await user.upload(fileInput(), [pdf('only.pdf')]);

      await user.click(uploadButton());

      await waitFor(() =>
        expect(toastMock).toHaveBeenCalledWith(
          expect.objectContaining({ description: '1 price proposal processed and stored.' })
        )
      );
    });

    it('tells the price proposals page to refresh once files are stored', async () => {
      // This event is the only link between the upload view and the list view.
      const user = userEvent.setup();
      const onRefresh = vi.fn();
      window.addEventListener('price-proposals-refresh-requested', onRefresh);
      render(<PdfUpload />);
      await user.upload(fileInput(), [pdf('a.pdf')]);

      await user.click(uploadButton());

      await waitFor(() => expect(onRefresh).toHaveBeenCalledTimes(1));
      window.removeEventListener('price-proposals-refresh-requested', onRefresh);
    });

    it('does not ask for a refresh when nothing was stored', async () => {
      const user = userEvent.setup();
      const onRefresh = vi.fn();
      window.addEventListener('price-proposals-refresh-requested', onRefresh);
      respondWith(() => serverError('Extraction failed'));
      render(<PdfUpload />);
      await user.upload(fileInput(), [pdf('a.pdf')]);

      await user.click(uploadButton());

      await screen.findByText('Batch finished');
      expect(onRefresh).not.toHaveBeenCalled();
      window.removeEventListener('price-proposals-refresh-requested', onRefresh);
    });

    it('re-uploading only sends the files that are still pending', async () => {
      const user = userEvent.setup();
      render(<PdfUpload />);
      await user.upload(fileInput(), [pdf('a.pdf')]);
      await user.click(uploadButton());
      await screen.findByText('Batch finished');

      await user.upload(fileInput(), [pdf('b.pdf')]);
      authFetchMock.mockClear();
      await user.click(uploadButton());

      await waitFor(() => expect(authFetchMock).toHaveBeenCalledTimes(1));
      const body = authFetchMock.mock.calls[0][1]?.body as FormData;
      expect((body.get('file') as File).name).toBe('b.pdf');
    });

    it('frees settled files from the next batch limit while keeping them visible', async () => {
      const user = userEvent.setup();
      render(<PdfUpload />);
      const firstBatch = Array.from({ length: MAX_BATCH_FILES }, (_, i) => pdf(`first-${i}.pdf`));
      await user.upload(fileInput(), firstBatch);
      await user.click(uploadButton());
      await screen.findByText('Batch finished');

      const nextBatch = Array.from({ length: MAX_BATCH_FILES }, (_, i) => pdf(`next-${i}.pdf`));
      await user.upload(fileInput(), nextBatch);

      expect(screen.getByText(`Files (${MAX_BATCH_FILES}/${MAX_BATCH_FILES} in current batch)`)).toBeInTheDocument();
      expect(screen.getByText('first-0.pdf')).toBeInTheDocument();
      expect(screen.getByText('next-29.pdf')).toBeInTheDocument();
      expect(toastMock).not.toHaveBeenCalledWith(
        expect.objectContaining({ description: expect.stringContaining('Batch limit') })
      );
    });
  });

  describe('partial failures', () => {
    beforeEach(() => {
      authFetchMock.mockImplementation(async (_url, init) => {
        const file = (init?.body as FormData).get('file') as File;
        return file.name.startsWith('bad')
          ? serverError('Could not extract tables')
          : ok();
      });
    });

    it('stores the good files and surfaces the backend message on the bad ones', async () => {
      const user = userEvent.setup();
      render(<PdfUpload />);
      await user.upload(fileInput(), [pdf('good-1.pdf'), pdf('bad-1.pdf'), pdf('good-2.pdf')]);

      await user.click(uploadButton());

      await screen.findByText('Batch finished');
      expect(within(rowFor('good-1.pdf')).getByText('Stored')).toBeInTheDocument();
      expect(within(rowFor('bad-1.pdf')).getByText('Could not extract tables')).toBeInTheDocument();
      expect(screen.getByText('2 stored, 1 failed.')).toBeInTheDocument();
    });

    it('warns that the batch finished with errors', async () => {
      const user = userEvent.setup();
      render(<PdfUpload />);
      await user.upload(fileInput(), [pdf('good-1.pdf'), pdf('bad-1.pdf')]);

      await user.click(uploadButton());

      await waitFor(() =>
        expect(toastMock).toHaveBeenCalledWith(
          expect.objectContaining({
            variant: 'destructive',
            title: 'Batch finished with errors',
            description: '1 stored, 1 failed. Check the list below.',
          })
        )
      );
    });

    it('offers to retry only the failed files', async () => {
      const user = userEvent.setup();
      render(<PdfUpload />);
      await user.upload(fileInput(), [pdf('good-1.pdf'), pdf('bad-1.pdf'), pdf('bad-2.pdf')]);
      await user.click(uploadButton());
      await screen.findByText('Batch finished');

      const retry = await screen.findByRole('button', { name: 'Retry 2 files' });
      respondWith(() => ok());
      // Forget the first batch's calls so what follows is only the retry.
      authFetchMock.mockClear();
      await user.click(retry);

      await waitFor(() => expect(authFetchMock).toHaveBeenCalledTimes(2));
      const retried = authFetchMock.mock.calls.map(
        ([, init]) => ((init?.body as FormData).get('file') as File).name
      );
      expect(retried.sort()).toEqual(['bad-1.pdf', 'bad-2.pdf']);
    });

    it('clears the retry affordance once the retry succeeds', async () => {
      const user = userEvent.setup();
      render(<PdfUpload />);
      await user.upload(fileInput(), [pdf('bad-1.pdf')]);
      await user.click(uploadButton());

      const retry = await screen.findByRole('button', { name: 'Retry 1 file' });
      respondWith(() => ok());
      await user.click(retry);

      await waitFor(() =>
        expect(within(rowFor('bad-1.pdf')).getByText('Stored')).toBeInTheDocument()
      );
      expect(screen.queryByRole('button', { name: /^Retry/ })).not.toBeInTheDocument();
    });

    it('reports a transport failure rather than swallowing it', async () => {
      const user = userEvent.setup();
      authFetchMock.mockRejectedValue(new Error('You must be signed in to perform this action.'));
      render(<PdfUpload />);
      await user.upload(fileInput(), [pdf('a.pdf')]);

      await user.click(uploadButton());

      await screen.findByText('Batch finished');
      expect(
        within(rowFor('a.pdf')).getByText('You must be signed in to perform this action.')
      ).toBeInTheDocument();
    });

    it('falls back to the status code when the error body is not JSON', async () => {
      const user = userEvent.setup();
      respondWith(() => new Response('<html>502 Bad Gateway</html>', { status: 502 }));
      render(<PdfUpload />);
      await user.upload(fileInput(), [pdf('a.pdf')]);

      await user.click(uploadButton());

      await screen.findByText('Batch finished');
      expect(within(rowFor('a.pdf')).getByText('Upload failed (502)')).toBeInTheDocument();
    });

    it('treats a successful response with an unparseable body as success', async () => {
      const user = userEvent.setup();
      respondWith(() => new Response('', { status: 200 }));
      render(<PdfUpload />);
      await user.upload(fileInput(), [pdf('a.pdf')]);

      await user.click(uploadButton());

      await waitFor(() =>
        expect(within(rowFor('a.pdf')).getByText('Stored')).toBeInTheDocument()
      );
    });
  });

  describe('stopping a batch', () => {
    /**
     * Holds every upload open until the test releases it, so there is a stable
     * window in which the batch is genuinely in flight and Stop is clickable.
     */
    function pendingUploads() {
      const rejects: Array<(reason: unknown) => void> = [];
      authFetchMock.mockImplementation(
        (_url, init) =>
          new Promise<Response>((_resolve, reject) => {
            rejects.push(reject);
            init?.signal?.addEventListener('abort', () =>
              reject(new DOMException('The operation was aborted.', 'AbortError'))
            );
          })
      );
      return rejects;
    }

    it('swaps Upload for Stop while a batch is running', async () => {
      const user = userEvent.setup();
      pendingUploads();
      render(<PdfUpload />);
      await user.upload(fileInput(), [pdf('a.pdf')]);

      await user.click(uploadButton());

      const stop = await screen.findByRole('button', { name: 'Stop' });
      expect(stop).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /upload price proposals/i })).not.toBeInTheDocument();
    });

    it('shows how many files have settled and the concurrency in use', async () => {
      const user = userEvent.setup();
      pendingUploads();
      render(<PdfUpload />);
      await user.upload(fileInput(), [pdf('a.pdf'), pdf('b.pdf')]);

      await user.click(uploadButton());

      expect(await screen.findByText(/Processing 0 of 2/)).toBeInTheDocument();
    });

    it('locks the selection while uploading', async () => {
      const user = userEvent.setup();
      pendingUploads();
      render(<PdfUpload />);
      await user.upload(fileInput(), [pdf('a.pdf')]);

      await user.click(uploadButton());

      await screen.findByRole('button', { name: 'Stop' });
      expect(fileInput()).toBeDisabled();
      expect(screen.getByRole('button', { name: /clear all/i })).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Remove a.pdf' })).toBeDisabled();
    });

    it('cancels the remaining files and says stored files stay stored', async () => {
      const user = userEvent.setup();
      pendingUploads();
      render(<PdfUpload />);
      await user.upload(fileInput(), [pdf('a.pdf'), pdf('b.pdf')]);
      await user.click(uploadButton());

      await user.click(await screen.findByRole('button', { name: 'Stop' }));

      await screen.findByText('Batch finished');
      expect(within(rowFor('a.pdf')).getByText('Cancelled')).toBeInTheDocument();
      expect(screen.getByText('0 stored, 2 cancelled.')).toBeInTheDocument();
      expect(
        screen.getByText(/files already stored stay stored/i)
      ).toBeInTheDocument();
      expect(toastMock).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Upload stopped' })
      );
    });

    it('lets cancelled files be retried', async () => {
      const user = userEvent.setup();
      pendingUploads();
      render(<PdfUpload />);
      await user.upload(fileInput(), [pdf('a.pdf')]);
      await user.click(uploadButton());
      await user.click(await screen.findByRole('button', { name: 'Stop' }));

      const retry = await screen.findByRole('button', { name: 'Retry 1 file' });
      respondWith(() => ok());
      await user.click(retry);

      await waitFor(() =>
        expect(within(rowFor('a.pdf')).getByText('Stored')).toBeInTheDocument()
      );
    });

    it('aborts in-flight requests when the view unmounts', async () => {
      const user = userEvent.setup();
      pendingUploads();
      const { unmount } = render(<PdfUpload />);
      await user.upload(fileInput(), [pdf('a.pdf')]);
      await user.click(uploadButton());
      await screen.findByRole('button', { name: 'Stop' });

      const signal = authFetchMock.mock.calls[0][1]?.signal as AbortSignal;
      expect(signal.aborted).toBe(false);

      unmount();

      expect(signal.aborted).toBe(true);
    });
  });
});
