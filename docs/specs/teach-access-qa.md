# Especificación: acceso a Enséñame en QA

## Origen

- `id`: `teach-access-qa`
- `area`: `acceso`
- `depends_on`: `[]`
- Estado al planificar: `not_started`.
- Fuente: `feature_list.json`, `docs/build-brief.md` y `DESIGN.md`.

## Objetivo

Cuando trabajo en el dashboard de QA como administrador autorizado para enseñar reglas, quiero abrir Enséñame sin habilitar la función para otros administradores ni para producción.

No incluye chat, adjuntos, extracción, activación de Skills, datos comerciales ni publicación. Tampoco añade una pantalla de administración de permisos.

## Escenarios de aceptación

### Administrador autorizado

- **Dado** un entorno QA, una sesión Firebase válida, un administrador vigente y su correo en la lista de Enséñame,
- **cuando** visita el dashboard o abre `/dashboard/teach-me`,
- **entonces** ve el enlace y, tras la comprobación, la página inicial con el indicador QA. La API responde `204` sin datos personales.

### Administrador no autorizado

- **Dado** un administrador válido que no está en la lista, o una lista vacía,
- **cuando** abre el dashboard o la URL directa,
- **entonces** el enlace no aparece, la API responde `403` y la página no muestra la sección autorizada.

### Revocación o sesión inválida

- **Dado** un correo retirado de la lista aplicada, un permiso de administrador retirado o una sesión inválida,
- **cuando** se realiza la siguiente comprobación,
- **entonces** no se devuelve permiso (`403` para falta de permiso, `401` para falta de autenticación). Un error de red o respuesta inesperada tampoco habilita el acceso.

### Fuera de QA

- **Dado** un despliegue no QA, incluso con una lista configurada por error,
- **cuando** se solicita el acceso,
- **entonces** no aparece el enlace ni se habilita el contenido, y el endpoint no concede acceso (`404`).

## Estado del repositorio

- BmWeb: `src/app/dashboard/layout.tsx` aplica `AuthGuard`; `src/components/app-sidebar.tsx` contiene la navegación; `src/lib/env.ts` expone `isQA`; `src/lib/api-client.ts` añade el token Firebase; `src/lib/backend-auth.ts` extrae la cabecera en proxies Next.js.
- BmBackEnd: `Application.kt` registra rutas `/api/v1`; `routes/FirebaseRouteAuth.kt` verifica el token y consulta el permiso actual de administrador; `services/AdminAccessControlService.kt` usa `admin_users`; `observability/DeploymentInfo.kt` lee `BM_ENV`.
- `FirebaseRouteAuthTest.kt` demuestra pruebas Ktor sin Firebase ni Postgres reales. BmWeb usa Vitest; no se encontró un comando E2E en `package.json`.
- BmBackEnd tiene una rama de otro trabajo activa; usar un worktree separado de `origin/qa` para esta implementación.

## Contrato técnico

- BmBackEnd habilita `GET /api/v1/teach-me/check-access` únicamente con `BM_ENV=qa`. Requiere Firebase válido, administración vigente y coincidencia exacta del correo normalizado con `BM_TEACH_ME_ADMIN_EMAILS` (lista de correos separados por comas, en servidor).
- La lista se lee al iniciar el proceso. Para revocar solo Enséñame, retirar el correo y aplicar la configuración reiniciando el backend QA; la siguiente solicitud tras aplicarla se deniega. La revocación del permiso general se comprueba en cada solicitud.
- El proxy `GET /api/teach-me/check-access` usa `BM_BACKEND_URL`, reenvía solo la autorización y no almacena la respuesta. Fuera de QA devuelve `404`. Solo una respuesta `204` del backend habilita la sección; errores no conceden acceso.
- El menú y la página verifican el permiso; la página directa no depende de la visibilidad del enlace. No renderizar contenido protegido durante la espera. Aplicar el mismo límite de servidor en futuras operaciones; no confiar en el resultado almacenado por la interfaz.

## Cambios previstos

- BmBackEnd: servicio pequeño para la lista específica, ruta y registro en `Application.kt`, pruebas Ktor enfocadas.
- BmWeb: proxy de acceso, comprobación reutilizada por el menú y la página, y pruebas del proxy e interfaz.
- Sin migraciones, nuevas dependencias, cambios en el permiso general ni modificaciones en BmPriceAgent.

## Interfaz

- Reutilizar el menú y los estilos existentes; enlace **Enséñame**, encabezado y estado `QA`.
- Diferenciar espera, acceso no disponible y fallo de verificación con texto. No se requiere otro artefacto de diseño.

## Impacto documental

- `ARCHITECTURE.md`: no necesario; se reutilizan interfaz, proxy y autoridad de backend existentes.
- `CONSTRAINTS.md`: no necesario; las restricciones de QA y servidor ya están en `AGENTS.md` y el brief.
- `AGENTS.md`: sin cambios; no cambia el flujo de trabajo.
- `PROGRESS.md` y catálogo: registrar implementación y evidencia, incluido el estado del smoke en QA. Documentar la variable en el backend para operación.

## Implementación

1. Añadir la comprobación de servidor específica sin ampliar los permisos de administración general.
2. Conectar el proxy de BmWeb y las dos entradas de interfaz (menú y URL directa).
3. Ejecutar los casos de acceso, producción y fallo cerrado; dejar documentado cómo probarlo en QA real.

- [ ] Probar la ruta Ktor con token inyectado y repositorio administrativo en memoria.
- [ ] Probar el proxy con upstream controlado, incluidos `401`, `403`, error y no QA.
- [ ] Probar que el menú y el contenido solo se habilitan con una concesión explícita.
- [ ] Verificar en QA con dos administradores reales cuando esté desplegada la configuración.

## Verificación y evidencia

- BmBackEnd (JDK 17): `./gradlew test --tests '*TeachMeAccessRoutesTest' --tests '*FirebaseRouteAuthTest'`. No requiere Docker.
- BmWeb (Node 20): `./init.sh`; registra TypeScript y Vitest, sin arrancar servicios. `./init.sh --dev` es opcional para el smoke manual.
- Smoke de despliegue: con Firebase de QA y el backend actualizado, confirmar menú, URL directa, cuenta no nominada y retirada de acceso tras aplicar el cambio. Registrar si se ejecutó; no desplegar ni cambiar producción como parte de esta especificación.

## Lista de validación

- [ ] La autorización se decide en servidor y fallan cerrado los estados no permitidos.
- [ ] Ni producción ni un administrador no nominado pueden habilitar Enséñame.
- [ ] El permiso no modifica los endpoints generales de administración.
- [ ] Las pruebas ejecutadas y cualquier smoke pendiente constan en el harness.
- [ ] No se incorpora ninguna funcionalidad posterior a esta primera sección.
