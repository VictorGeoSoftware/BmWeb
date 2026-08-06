'use client';

import { useEffect, useMemo, useState } from 'react';
import { Trash2, UserPlus } from 'lucide-react';
import { auth } from '@/lib/firebase/client';
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
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';

interface GrantedUserItem {
  email: string;
  grantedAt: number;
  name: string | null;
  isOnline: boolean | null;
  monthlyUsageCount: number | null;
  usageStartedAt: number | null;
  lastConnectedAt: number | null;
  lastDisconnectedAt: number | null;
  activityUpdatedAt: number | null;
}

interface GrantedUsersResponse {
  success: boolean;
  users?: GrantedUserItem[];
  message?: string;
}

interface ActionMessage {
  type: 'success' | 'error';
  text: string;
}

/** Firebase ID token of the logged-in dashboard user; the backend verifies it. */
async function buildAuthHeaders(): Promise<Record<string, string>> {
  const idToken = await auth.currentUser?.getIdToken();
  if (!idToken) {
    throw new Error('No hay una sesión iniciada. Vuelve a iniciar sesión.');
  }
  return { Authorization: `Bearer ${idToken}` };
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

function formatDateTime(timestamp: number | null): string {
  if (!timestamp) return '—';

  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return '—';

  const day = String(date.getDate()).padStart(2, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const year = date.getFullYear();
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const seconds = String(date.getSeconds()).padStart(2, '0');

  return `${day}-${month}-${year}, ${hours}:${minutes}:${seconds}`;
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
  const [users, setUsers] = useState<GrantedUserItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [newEmail, setNewEmail] = useState('');
  const [isAdding, setIsAdding] = useState(false);
  const [actionMessage, setActionMessage] = useState<ActionMessage | null>(null);
  const [userPendingDeletion, setUserPendingDeletion] = useState<GrantedUserItem | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

  const loadUsers = async (showLoading: boolean) => {
    if (showLoading) {
      setIsLoading(true);
    }

    try {
      setError(null);
      const headers = await buildAuthHeaders();
      const response = await fetch('/api/users/grants', { cache: 'no-store', headers });
      const payload = (await response.json()) as GrantedUsersResponse;

      if (!response.ok) {
        throw new Error(payload?.message ?? 'Failed to load granted users');
      }

      setUsers(payload.users ?? []);
    } catch (fetchError) {
      setError(fetchError instanceof Error ? fetchError.message : 'Failed to load granted users');
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

  const addUser = async () => {
    const email = newEmail.trim();
    if (!email || isAdding) return;

    setIsAdding(true);
    setActionMessage(null);

    try {
      const authHeaders = await buildAuthHeaders();
      const response = await fetch('/api/users/grants', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders },
        body: JSON.stringify({ email }),
      });
      const payload = (await response.json()) as GrantedUsersResponse;

      if (!response.ok) {
        throw new Error(payload?.message ?? 'No se pudo conceder el acceso');
      }

      setNewEmail('');
      setActionMessage({ type: 'success', text: `Acceso concedido a ${email}.` });
      await loadUsers(false);
    } catch (addError) {
      setActionMessage({
        type: 'error',
        text: addError instanceof Error ? addError.message : 'No se pudo conceder el acceso',
      });
    } finally {
      setIsAdding(false);
    }
  };

  const deleteUser = async () => {
    if (!userPendingDeletion || isDeleting) return;

    const email = userPendingDeletion.email;
    setIsDeleting(true);
    setActionMessage(null);

    try {
      const headers = await buildAuthHeaders();
      const response = await fetch(`/api/users/grants/${encodeURIComponent(email)}`, {
        method: 'DELETE',
        headers,
      });
      const payload = (await response.json()) as GrantedUsersResponse;

      if (!response.ok) {
        throw new Error(payload?.message ?? 'No se pudo eliminar el usuario');
      }

      setActionMessage({
        type: 'success',
        text: `Usuario ${email} eliminado. Se revocó su acceso y todos sus datos.`,
      });
      setUserPendingDeletion(null);
      await loadUsers(false);
    } catch (deleteError) {
      setActionMessage({
        type: 'error',
        text: deleteError instanceof Error ? deleteError.message : 'No se pudo eliminar el usuario',
      });
    } finally {
      setIsDeleting(false);
    }
  };

  const totals = useMemo(() => {
    const totalUsers = users.length;
    const onlineUsers = users.filter(user => user.isOnline === true).length;
    const monthlyResponses = users.reduce(
      (total, user) => total + (user.monthlyUsageCount ?? 0),
      0
    );

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
          Gestiona el acceso a la aplicación y consulta el estado de conexión y uso mensual de
          respuestas de propuestas por usuario.
        </p>
      </header>

      <div className="mb-6 flex flex-wrap items-center gap-2">
        <Input
          type="email"
          placeholder="Email del nuevo usuario"
          value={newEmail}
          onChange={event => setNewEmail(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'Enter') {
              void addUser();
            }
          }}
          className="w-72"
          disabled={isAdding}
        />
        <Button onClick={() => void addUser()} disabled={isAdding || !newEmail.trim()}>
          <UserPlus />
          {isAdding ? 'Añadiendo…' : 'Añadir usuario'}
        </Button>
      </div>

      {actionMessage && (
        <div
          className={`mb-6 rounded-lg border p-3 text-sm ${
            actionMessage.type === 'success'
              ? 'border-emerald-500/50 bg-emerald-500/10 text-emerald-700'
              : 'border-destructive/50 bg-destructive/10 text-destructive'
          }`}
        >
          {actionMessage.text}
        </div>
      )}

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
          Aún no hay usuarios con acceso concedido.
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
                <TableHead className="text-right">Acciones</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {users.map(user => (
                <TableRow key={user.email}>
                  <TableCell className="font-medium">{user.name ?? '—'}</TableCell>
                  <TableCell>{user.email}</TableCell>
                  <TableCell>
                    {user.isOnline === null ? (
                      <Badge variant="outline">Sin actividad</Badge>
                    ) : (
                      <Badge variant={user.isOnline ? 'default' : 'secondary'}>
                        {user.isOnline ? 'Online' : 'Offline'}
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-right font-semibold">
                    {user.monthlyUsageCount ?? '—'}
                  </TableCell>
                  <TableCell>{formatDate(user.usageStartedAt)}</TableCell>
                  <TableCell>{formatDateTime(user.lastConnectedAt)}</TableCell>
                  <TableCell>{formatDateTime(user.lastDisconnectedAt)}</TableCell>
                  <TableCell>{formatDateTime(user.activityUpdatedAt)}</TableCell>
                  <TableCell className="text-right">
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => setUserPendingDeletion(user)}
                      aria-label={`Eliminar a ${user.email}`}
                    >
                      <Trash2 className="text-destructive" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <AlertDialog
        open={userPendingDeletion !== null}
        onOpenChange={open => {
          if (!open && !isDeleting) {
            setUserPendingDeletion(null);
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>¿Eliminar a {userPendingDeletion?.email}?</AlertDialogTitle>
            <AlertDialogDescription>
              Esta acción eliminará el acceso del usuario y borrará todos sus datos de la base de
              datos. Se cerrará su sesión y no podrá volver a iniciarla. Esta acción no se puede
              deshacer.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeleting}>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              onClick={event => {
                event.preventDefault();
                void deleteUser();
              }}
              disabled={isDeleting}
            >
              {isDeleting ? 'Eliminando…' : 'Eliminar'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
