# Registro de progreso

## Estado actual

- Raíz del harness: `BmWeb`. La primera sección de Enséñame está implementada en `features/teach-me`, con el backend en el worktree `../BmBackEnd-teach-me` (rama del mismo nombre, basada en `origin/qa`).
- Verificación base: `./init.sh` (`npm run typecheck` y `npm test`). CI usa Node 20 y `npm ci`.
- Última verificación: 2026-11-19. TypeScript sin errores, 100 pruebas web y 10 pruebas enfocadas de backend superadas.
- Arranque local: `./init.sh --dev` con la configuración de Firebase y backend de QA. La aplicación escucha en `localhost:9002`.
- `teach-access-qa` está `passing`, pendiente de validación independiente. `teach-workbook-attachment` depende de su aceptación.
- Condiciones para habilitar el piloto: resolver aislamiento entre entornos, tratamiento de datos reales y expectativas de extracción. Ver `docs/risks-and-open-questions.md`.

## Sesión 001

- Objetivo: preparar el harness mínimo a partir del brief aprobado.
- Resultado: instrucciones de trabajo, comando de inicio y catálogo de funcionalidades pendientes. Sin cambios en la aplicación ni en otros repositorios.
- Evidencia: `init.sh` es ejecutable, pasa `bash -n` y completa la verificación base. El catálogo contiene 13 entradas válidas, sin dependencias cíclicas y con `teach-access-qa` como única entrada sin prerrequisitos. El modo `--dev` no se arrancó.
- Siguiente paso: usar `feature-spec` para `teach-access-qa`.

## Sesión 002

- Especificación: `docs/specs/teach-access-qa.md`. Menú y página protegidos por autorización de servidor específica de QA; sin chat, extracción ni cambios de infraestructura.
- BmWeb: `./init.sh`, 100 pruebas en 6 archivos. Backend (JDK 17): `./gradlew test --tests '*TeachMeAccessRoutesTest' --tests '*FirebaseRouteAuthTest'`, 10 pruebas. No se arrancó Docker.
- Smoke pendiente: desplegar los dos cambios en QA con `NEXT_PUBLIC_APP_ENV=qa`, `BM_ENV=qa` y `BM_TEACH_ME_ADMIN_EMAILS` aplicado al backend QA. Sign-in real con dos administradores, URL directa y retirada de acceso. No se desplegó ni se cambió la configuración remota.
