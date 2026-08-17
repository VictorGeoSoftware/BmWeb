'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { auth } from '@/lib/firebase/client';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

interface CollectedPriceItem {
  id: number;
  companyName: string;
  tariffType: string;
  /** Always 6 entries, P1..P6; null for periods the tariff does not use. */
  powerPrices: (number | null)[];
  energyPrices: (number | null)[];
  extraServices: number | null;
  collectedAt: number;
}

interface CollectedPricesResponse {
  success: boolean;
  items?: CollectedPriceItem[];
  total?: number;
  limit?: number;
  offset?: number;
  message?: string;
}

const PERIODS = ['P1', 'P2', 'P3', 'P4', 'P5', 'P6'] as const;

/**
 * 2.0TD is deliberately absent: those supplies are never collected, so offering it
 * as a filter would only ever return an empty table.
 */
const TARIFF_OPTIONS = ['3.0TD', '3.1TD', '6.1TD', '6.2TD', '6.3TD', '6.4TD'] as const;

const ALL_TARIFFS = 'all';
const PAGE_SIZES = [25, 50, 100] as const;

/** Firebase ID token of the logged-in dashboard user; the backend verifies it. */
async function buildAuthHeaders(): Promise<Record<string, string>> {
  const idToken = await auth.currentUser?.getIdToken();
  if (!idToken) {
    throw new Error('No active session. Please sign in again.');
  }
  return { Authorization: `Bearer ${idToken}` };
}

function formatDateTime(epochMillis: number): string {
  return new Date(epochMillis).toLocaleString('es-ES', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Prices are per-kWh / per-kW and need the full precision the broker entered. */
function formatPrice(value: number | null): string {
  return value === null || value === undefined ? '—' : value.toFixed(6);
}

function formatAmount(value: number | null): string {
  return value === null || value === undefined ? '—' : `${value.toFixed(2)} €`;
}

function LoadingSkeleton() {
  return (
    <div className="space-y-3">
      {Array.from({ length: 6 }).map((_, index) => (
        <Skeleton key={index} className="h-12 w-full" />
      ))}
    </div>
  );
}

export default function CollectedPricesPage() {
  const [items, setItems] = useState<CollectedPriceItem[]>([]);
  const [total, setTotal] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [tariffFilter, setTariffFilter] = useState<string>(ALL_TARIFFS);
  const [companyFilter, setCompanyFilter] = useState('');
  const [appliedCompanyFilter, setAppliedCompanyFilter] = useState('');
  const [pageSize, setPageSize] = useState<number>(PAGE_SIZES[1]);
  const [offset, setOffset] = useState(0);

  const loadCollectedPrices = useCallback(async () => {
    setIsLoading(true);
    try {
      setError(null);
      const headers = await buildAuthHeaders();

      const query = new URLSearchParams({
        limit: String(pageSize),
        offset: String(offset),
      });
      if (tariffFilter !== ALL_TARIFFS) query.set('tariffType', tariffFilter);
      if (appliedCompanyFilter.trim() !== '') {
        query.set('companyName', appliedCompanyFilter.trim());
      }

      const response = await fetch(`/api/collected-prices?${query.toString()}`, {
        cache: 'no-store',
        headers,
      });
      const payload = (await response.json()) as CollectedPricesResponse;

      if (!response.ok) {
        throw new Error(payload?.message ?? 'Failed to load collected prices');
      }

      setItems(payload.items ?? []);
      setTotal(payload.total ?? 0);
    } catch (fetchError) {
      setError(
        fetchError instanceof Error ? fetchError.message : 'Failed to load collected prices'
      );
      setItems([]);
      setTotal(0);
    } finally {
      setIsLoading(false);
    }
  }, [pageSize, offset, tariffFilter, appliedCompanyFilter]);

  useEffect(() => {
    void loadCollectedPrices();
  }, [loadCollectedPrices]);

  // Any filter change invalidates the current page: staying on page 4 of a narrower
  // result set would show an empty table.
  const applyTariffFilter = (value: string) => {
    setTariffFilter(value);
    setOffset(0);
  };

  const applyCompanyFilter = () => {
    setAppliedCompanyFilter(companyFilter);
    setOffset(0);
  };

  const clearFilters = () => {
    setTariffFilter(ALL_TARIFFS);
    setCompanyFilter('');
    setAppliedCompanyFilter('');
    setOffset(0);
  };

  const hasActiveFilters =
    tariffFilter !== ALL_TARIFFS || appliedCompanyFilter.trim() !== '';

  const range = useMemo(() => {
    if (total === 0) return { from: 0, to: 0 };
    return { from: offset + 1, to: Math.min(offset + items.length, total) };
  }, [offset, items.length, total]);

  const canGoPrevious = offset > 0;
  const canGoNext = offset + pageSize < total;

  return (
    <>
      <header className="mb-8">
        <h1 className="text-3xl font-bold font-headline">Collected Prices</h1>
        <p className="text-muted-foreground">
          Prices customers were already paying, captured by brokers when preparing a
          comparison. 2.0TD supplies are not collected.
        </p>
      </header>

      <div className="mb-6 flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1.5">
          <label className="text-xs font-medium text-muted-foreground">Tariff</label>
          <Select value={tariffFilter} onValueChange={applyTariffFilter}>
            <SelectTrigger className="w-[160px]">
              <SelectValue placeholder="All tariffs" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_TARIFFS}>All tariffs</SelectItem>
              {TARIFF_OPTIONS.map(tariff => (
                <SelectItem key={tariff} value={tariff}>
                  {tariff}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex flex-col gap-1.5">
          <label className="text-xs font-medium text-muted-foreground">Supplier</label>
          <Input
            value={companyFilter}
            onChange={event => setCompanyFilter(event.target.value)}
            onKeyDown={event => {
              if (event.key === 'Enter') applyCompanyFilter();
            }}
            onBlur={applyCompanyFilter}
            placeholder="Filter by supplier"
            className="w-[220px]"
          />
        </div>

        {hasActiveFilters && (
          <Button variant="ghost" onClick={clearFilters}>
            Clear filters
          </Button>
        )}

        <Button
          variant="outline"
          onClick={() => void loadCollectedPrices()}
          disabled={isLoading}
          className="ml-auto"
        >
          <RefreshCw className={isLoading ? 'animate-spin' : undefined} />
          Refresh
        </Button>
      </div>

      {isLoading && <LoadingSkeleton />}

      {!isLoading && error && (
        <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-4 text-destructive text-sm">
          {error}
        </div>
      )}

      {!isLoading && !error && items.length === 0 && (
        <div className="rounded-lg border border-dashed p-12 text-center text-muted-foreground">
          {hasActiveFilters
            ? 'No collected prices match these filters.'
            : 'No prices have been collected yet.'}
        </div>
      )}

      {!isLoading && !error && items.length > 0 && (
        <>
          <div className="rounded-lg border bg-card shadow-sm overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="whitespace-nowrap">Collected</TableHead>
                  <TableHead>Supplier</TableHead>
                  <TableHead>Tariff</TableHead>
                  {PERIODS.map(period => (
                    <TableHead key={`power-${period}`} className="text-right whitespace-nowrap">
                      Power {period}
                    </TableHead>
                  ))}
                  {PERIODS.map(period => (
                    <TableHead key={`energy-${period}`} className="text-right whitespace-nowrap">
                      Energy {period}
                    </TableHead>
                  ))}
                  <TableHead className="text-right whitespace-nowrap">Extra services</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map(item => (
                  <TableRow key={item.id}>
                    <TableCell className="whitespace-nowrap">
                      {formatDateTime(item.collectedAt)}
                    </TableCell>
                    <TableCell className="font-medium">{item.companyName}</TableCell>
                    <TableCell>
                      <Badge variant="outline">{item.tariffType}</Badge>
                    </TableCell>
                    {PERIODS.map((period, index) => (
                      <TableCell
                        key={`power-${item.id}-${period}`}
                        className="text-right font-mono text-xs"
                      >
                        {formatPrice(item.powerPrices?.[index] ?? null)}
                      </TableCell>
                    ))}
                    {PERIODS.map((period, index) => (
                      <TableCell
                        key={`energy-${item.id}-${period}`}
                        className="text-right font-mono text-xs"
                      >
                        {formatPrice(item.energyPrices?.[index] ?? null)}
                      </TableCell>
                    ))}
                    <TableCell className="text-right font-mono text-xs">
                      {formatAmount(item.extraServices)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          <div className="mt-4 flex flex-wrap items-center justify-between gap-4">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <span>
                {range.from}–{range.to} of {total}
              </span>
              <Select
                value={String(pageSize)}
                onValueChange={value => {
                  setPageSize(Number(value));
                  setOffset(0);
                }}
              >
                <SelectTrigger className="h-8 w-[110px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PAGE_SIZES.map(size => (
                    <SelectItem key={size} value={String(size)}>
                      {size} / page
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={!canGoPrevious}
                onClick={() => setOffset(Math.max(0, offset - pageSize))}
              >
                Previous
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={!canGoNext}
                onClick={() => setOffset(offset + pageSize)}
              >
                Next
              </Button>
            </div>
          </div>
        </>
      )}
    </>
  );
}
