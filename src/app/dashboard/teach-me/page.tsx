'use client';

import { useTeachMeAccess } from '@/hooks/use-teach-me-access';

export default function TeachMePage() {
  const access = useTeachMeAccess();

  if (access === 'checking') return <p role="status">Comprobando acceso…</p>;
  if (access === 'denied') return <p role="status">Esta sección no está disponible para tu cuenta en este entorno.</p>;
  if (access === 'error') return <p role="alert">No se pudo comprobar el acceso. Vuelve a intentarlo.</p>;

  return (
    <section aria-labelledby="teach-me-title">
      <div className="flex items-center gap-3">
        <h1 id="teach-me-title" className="font-headline text-2xl font-bold">Enséñame</h1>
        <span className="rounded-md bg-muted px-2 py-1 text-xs font-medium text-muted-foreground">QA</span>
      </div>
      <p className="mt-2 text-muted-foreground">Espacio para enseñar a BmWeb a leer propuestas de precios eléctricos en Excel.</p>
    </section>
  );
}
