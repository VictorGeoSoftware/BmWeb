'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';

interface UserActivityItem {
  name: string;
  email: string;
  isOnline: boolean;
  monthlyUsageCount: number;
  lastConnectedAt: number | null;
  lastDisconnectedAt: number | null;
  updatedAt: number;
}

interface UserActivityResponse {
  success: boolean;
  users: UserActivityItem[];
  message?: string;
}

interface UserFirstConnectionItem {
  email: string;
  firstConnectedAt: number | null;
}

interface UserFirstConnectionResponse {
  success: boolean;
  users: UserFirstConnectionItem[];
  message?: string;
}

function formatDate(timestamp: number | null): string {
  if (!timestamp) return '—';

  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return '—';

  const day = String(date.getDate()).padStart(2, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const year = date.getFullYear();

  return `${day}-${month}-${year}`;
}

function LoadingSkeleton() {
  return (
    <div className="space-y-3">
      {[1, 2, 3].map(item => (
        <div key={item} className="rounded-lg border p-4">
          <Skeleton className="h-4 w-full" />
        </div>
      ))}
    </div>
  );
}

export default function UsersPage() {
  const [users, setUsers] = useState<UserActivityItem[]>([]);
  const [firstConnectionByEmail, setFirstConnectionByEmail] = useState<Record<string, number | null>>({});
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadUsers = async (showLoading: boolean) => {
    if (showLoading) {
      setIsLoading(true);
    }

    try {
      setError(null);
      const [usersResponse, firstConnectionsResponse] = await Promise.all([
        fetch('/api/users/activity', { cache: 'no-store' }),
        fetch('/api/users/activity/first-connection', { cache: 'no-store' }),
      ]);
      const usersPayload = (await usersResponse.json()) as UserActivityResponse;
      const firstConnectionsPayload =
        (await firstConnectionsResponse.json()) as UserFirstConnectionResponse;

      if (!usersResponse.ok) {
        throw new Error(usersPayload?.message ?? 'Failed to load users activity');
      }

      if (!firstConnectionsResponse.ok) {
        throw new Error(
          firstConnectionsPayload?.message ?? 'Failed to load users first connection activity'
        );
      }

      setUsers(usersPayload.users ?? []);
      setFirstConnectionByEmail(
        (firstConnectionsPayload.users ?? []).reduce<Record<string, number | null>>((acc, item) => {
          acc[item.email] = item.firstConnectedAt;
          return acc;
        }, {})
      );
    } catch (fetchError) {
      setError(fetchError instanceof Error ? fetchError.message : 'Failed to load users activity');
    } finally {
      if (showLoading) {
        setIsLoading(false);
      }
    }
  };

  useEffect(() => {
    void loadUsers(true);

    const poller = window.setInterval(() => {
      void loadUsers(false);
    }, 4000);

    return () => {
      window.clearInterval(poller);
    };
  }, []);

  const totals = useMemo(() => {
    const totalUsers = users.length;
    const onlineUsers = users.filter(user => user.isOnline).length;
    const monthlyResponses = users.reduce((total, user) => total + user.monthlyUsageCount, 0);

    return {
      totalUsers,
      onlineUsers,
      monthlyResponses,
    };
  }, [users]);

  return (
    <>
      <header className="mb-8">
        <h1 className="text-3xl font-bold font-headline">Usuarios</h1>
        <p className="text-muted-foreground">
          Estado de conexión y uso mensual de respuestas de propuestas por usuario.
        </p>
      </header>

      <div className="mb-6 flex flex-wrap items-center gap-4 text-sm text-muted-foreground">
        <span>
          Usuarios: <span className="font-semibold text-foreground">{totals.totalUsers}</span>
        </span>
        <span>
          Online: <span className="font-semibold text-foreground">{totals.onlineUsers}</span>
        </span>
        <span>
          Respuestas mensuales: <span className="font-semibold text-foreground">{totals.monthlyResponses}</span>
        </span>
      </div>

      {isLoading && <LoadingSkeleton />}

      {!isLoading && error && (
        <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-4 text-destructive text-sm">
          {error}
        </div>
      )}

      {!isLoading && !error && users.length === 0 && (
        <div className="rounded-lg border border-dashed p-12 text-center text-muted-foreground">
          Aún no hay usuarios registrados con actividad.
        </div>
      )}

      {!isLoading && !error && users.length > 0 && (
        <div className="rounded-lg border bg-card shadow-sm overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Nombre</TableHead>
                <TableHead>Email</TableHead>
                <TableHead>Estado</TableHead>
                <TableHead className="text-right">Uso mensual</TableHead>
                <TableHead>Fecha inicio</TableHead>
                <TableHead>Última conexión</TableHead>
                <TableHead>Última desconexión</TableHead>
                <TableHead>Actualizado</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {users.map(user => (
                <TableRow key={user.email}>
                  <TableCell className="font-medium">{user.name}</TableCell>
                  <TableCell>{user.email}</TableCell>
                  <TableCell>
                    <Badge variant={user.isOnline ? 'default' : 'secondary'}>
                      {user.isOnline ? 'Online' : 'Offline'}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right font-semibold">{user.monthlyUsageCount}</TableCell>
                  <TableCell>{formatDate(firstConnectionByEmail[user.email] ?? null)}</TableCell>
                  <TableCell>{formatDate(user.lastConnectedAt)}</TableCell>
                  <TableCell>{formatDate(user.lastDisconnectedAt)}</TableCell>
                  <TableCell>{formatDate(user.updatedAt)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </>
  );
}
