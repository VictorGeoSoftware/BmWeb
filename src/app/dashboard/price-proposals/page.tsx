'use client';

import { useEffect, useState } from 'react';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Progress } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import { useToast } from '@/hooks/use-toast';
import { Trash2 } from 'lucide-react';

interface TarifaRow {
  tarifa: string;
  potencia_contratada: string | null;
  P1: number | null;
  P2: number | null;
  P3: number | null;
  P4: number | null;
  P5: number | null;
  P6: number | null;
}

interface PriceTableResult {
  id?: number;
  fileName: string;
  extracted_tables: {
    filename: string;
    termino_de_potencia: {
      titulo: string;
      tabla_precio_potencia: { titulo: string; tarifas: TarifaRow[] };
    };
    termino_de_energia: {
      titulo: string;
      tabla_precio_clasica_base: { titulo: string; tarifas: TarifaRow[] };
    };
  };
}

interface PriceTableResponse {
  success: boolean;
  results: PriceTableResult[];
  iva: number;
  impuestoElectrico: number;
}

interface DeleteSelectedResponse {
  success: boolean;
  message: string;
  deleted_ids?: number[];
  not_found_ids?: number[];
}

const P_COLS = ['P1', 'P2', 'P3', 'P4', 'P5', 'P6'] as const;

function fmt(v: number | null) {
  if (v === null || v === undefined) return '—';
  return v.toFixed(6);
}

function TarifaSection({
  title,
  tarifas,
}: {
  title: string;
  tarifas: TarifaRow[];
}) {
  return (
    <div className="mb-2">
      <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-1">
        {title}
      </p>
      <Table>
        <TableHeader>
          <TableRow className="bg-muted/50">
            <TableHead className="w-20">Tarifa</TableHead>
            {P_COLS.map(p => (
              <TableHead key={p} className="text-right">
                {p}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {tarifas.map((row, i) => (
            <TableRow key={i}>
              <TableCell>
                <Badge variant="outline">{row.tarifa}</Badge>
              </TableCell>
              {P_COLS.map(p => (
                <TableCell key={p} className="text-right font-mono text-xs">
                  {fmt(row[p])}
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function ResultCard({
  result,
  selected,
  onSelectionChange,
}: {
  result: PriceTableResult;
  selected: boolean;
  onSelectionChange: (checked: boolean) => void;
}) {
  const { extracted_tables } = result;
  const { termino_de_potencia, termino_de_energia } = extracted_tables;
  const isSelectable = typeof result.id === 'number';

  return (
    <div className="rounded-lg border bg-card shadow-sm overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3 border-b bg-muted/30">
        <div className="flex items-start gap-3">
          <Checkbox
            checked={selected}
            onCheckedChange={checked => onSelectionChange(checked === true)}
            disabled={!isSelectable}
            aria-label={`Select proposal ${result.fileName}`}
            className="mt-0.5"
          />

          <div>
            <p className="font-semibold text-sm">{result.fileName}</p>
            <p className="text-xs text-muted-foreground">
              Empresa: <span className="font-medium">{extracted_tables.filename}</span>
            </p>
          </div>
        </div>

        {!isSelectable && (
          <span className="text-[11px] text-muted-foreground">Not selectable</span>
        )}
      </div>

      <div className="p-4 space-y-4">
        <div>
          <h3 className="text-sm font-bold mb-2 text-primary">
            {termino_de_potencia.titulo}
          </h3>
          <TarifaSection
            title={termino_de_potencia.tabla_precio_potencia.titulo}
            tarifas={termino_de_potencia.tabla_precio_potencia.tarifas}
          />
        </div>

        <div>
          <h3 className="text-sm font-bold mb-2 text-primary">
            {termino_de_energia.titulo}
          </h3>
          <TarifaSection
            title={termino_de_energia.tabla_precio_clasica_base.titulo}
            tarifas={termino_de_energia.tabla_precio_clasica_base.tarifas}
          />
        </div>
      </div>
    </div>
  );
}

function LoadingSkeleton() {
  return (
    <div className="space-y-4">
      {[1, 2, 3].map(i => (
        <div key={i} className="rounded-lg border p-4 space-y-3">
          <Skeleton className="h-5 w-1/3" />
          <Skeleton className="h-4 w-1/4" />
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      ))}
    </div>
  );
}

export default function PriceProposalsPage() {
  const { toast } = useToast();
  const [data, setData] = useState<PriceTableResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [refreshProgress, setRefreshProgress] = useState(0);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [isDeletingSelection, setIsDeletingSelection] = useState(false);

  const loadPriceProposals = async (showLoadingSkeleton: boolean) => {
    if (showLoadingSkeleton) {
      setLoading(true);
    }

    setError(null);

    try {
      const response = await fetch('/api/price-proposals', { cache: 'no-store' });
      const json = (await response.json()) as PriceTableResponse;

      if (!response.ok) {
        throw new Error('Failed to load price proposals');
      }

      setData(json);
      setSelectedIds(prev => {
        const validIds = new Set((json.results ?? []).map(result => result.id).filter((id): id is number => typeof id === 'number'));
        return new Set([...prev].filter(id => validIds.has(id)));
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load price proposals');
    } finally {
      if (showLoadingSkeleton) {
        setLoading(false);
      }
      setIsRefreshing(false);
    }
  };

  useEffect(() => {
    if (!isRefreshing) {
      setRefreshProgress(0);
      return;
    }

    setRefreshProgress(15);
    const timer = window.setInterval(() => {
      setRefreshProgress(prev => (prev >= 92 ? 92 : prev + 6));
    }, 150);

    return () => {
      window.clearInterval(timer);
    };
  }, [isRefreshing]);

  useEffect(() => {
    void loadPriceProposals(true);
  }, []);

  useEffect(() => {
    const handlePriceProposalsCleared = () => {
      setSelectedIds(new Set());
      setIsRefreshing(true);
      void loadPriceProposals(false);
    };

    const handlePriceProposalsRefreshRequested = () => {
      setIsRefreshing(true);
      void loadPriceProposals(false);
    };

    window.addEventListener('price-proposals-cleared', handlePriceProposalsCleared);
    window.addEventListener('price-proposals-refresh-requested', handlePriceProposalsRefreshRequested);

    return () => {
      window.removeEventListener('price-proposals-cleared', handlePriceProposalsCleared);
      window.removeEventListener('price-proposals-refresh-requested', handlePriceProposalsRefreshRequested);
    };
  }, []);

  const toggleSelection = (id: number, checked: boolean) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (checked) {
        next.add(id);
      } else {
        next.delete(id);
      }
      return next;
    });
  };

  const handleDeleteSelection = async () => {
    const ids = [...selectedIds];
    if (ids.length === 0) {
      return;
    }

    if (!window.confirm(`This will permanently delete ${ids.length} selected proposal(s). Continue?`)) {
      return;
    }

    setIsDeletingSelection(true);
    try {
      const response = await fetch('/api/price-proposals', {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ ids }),
      });

      const payload = (await response.json()) as DeleteSelectedResponse;
      if (!response.ok) {
        throw new Error(payload?.message ?? 'Failed to delete selected proposals');
      }

      const deletedIds = payload.deleted_ids ?? [];
      setData(prev => {
        if (!prev) {
          return prev;
        }

        return {
          ...prev,
          results: prev.results.filter(result => typeof result.id !== 'number' || !deletedIds.includes(result.id)),
        };
      });

      setSelectedIds(new Set());

      toast({
        title: deletedIds.length > 0 ? 'Selection deleted' : 'No proposals deleted',
        description: payload.message,
      });

      if ((payload.not_found_ids ?? []).length > 0) {
        void loadPriceProposals(false);
      }
    } catch (deleteError) {
      toast({
        variant: 'destructive',
        title: 'Delete selection failed',
        description:
          deleteError instanceof Error ? deleteError.message : 'Unexpected error while deleting selected proposals',
      });
    } finally {
      setIsDeletingSelection(false);
    }
  };

  return (
    <>
      <header className="mb-8">
        <h1 className="text-3xl font-bold font-headline">Price Proposals</h1>
        <p className="text-muted-foreground">
          Stored electricity price tables extracted from uploaded proposals.
        </p>
      </header>

      {isRefreshing && (
        <div className="mb-6 rounded-md border bg-muted/30 px-3 py-2">
          <div className="mb-2 text-xs font-medium text-muted-foreground">Refreshing results...</div>
          <Progress value={refreshProgress} className="h-1.5" />
        </div>
      )}

      {loading && <LoadingSkeleton />}

      {error && (
        <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-4 text-destructive text-sm">
          {error}
        </div>
      )}

      {!loading && !error && data && (
        <>
          {data.results.length === 0 ? (
            <div className="rounded-lg border border-dashed p-12 text-center text-muted-foreground">
              No price proposals stored yet. Upload a PDF to get started.
            </div>
          ) : (
            <>
              <div className="flex items-center gap-4 mb-6 text-sm text-muted-foreground">
                <span>
                  <span className="font-semibold text-foreground">{data.results.length}</span> result
                  {data.results.length !== 1 ? 's' : ''}
                </span>
                <span>IVA: <span className="font-semibold text-foreground">{data.iva}%</span></span>
                <span>
                  Impuesto Eléctrico:{' '}
                  <span className="font-semibold text-foreground">{data.impuestoElectrico}%</span>
                </span>
                {selectedIds.size > 0 && (
                  <Button
                    variant="destructive"
                    size="sm"
                    onClick={handleDeleteSelection}
                    disabled={isDeletingSelection}
                    className="ml-auto"
                  >
                    <Trash2 />
                    {isDeletingSelection
                      ? `Deleting ${selectedIds.size}...`
                      : `Delete Selection (${selectedIds.size})`}
                  </Button>
                )}
              </div>
              <div className="space-y-6">
                {data.results.map((result, i) => (
                  <ResultCard
                    key={result.id ?? `${result.fileName}-${i}`}
                    result={result}
                    selected={typeof result.id === 'number' ? selectedIds.has(result.id) : false}
                    onSelectionChange={checked => {
                      if (typeof result.id === 'number') {
                        toggleSelection(result.id, checked);
                      }
                    }}
                  />
                ))}
              </div>
            </>
          )}
        </>
      )}
    </>
  );
}
