# Firebase Studio

This is a NextJS starter in Firebase Studio.

To get started, take a look at src/app/page.tsx.

## Enséñame: piloto local de aclaración

**Solo QA local aislado y ejemplos sintéticos.** El modo «Probar aclaración» queda
apagado por defecto. Necesita `NEXT_PUBLIC_APP_ENV=qa` y
`NEXT_PUBLIC_TEACH_CLARIFY_LOCAL=true` en BmWeb, y el opt-in independiente
`BM_TEACH_CLARIFY_LOCAL=true` en BmBackend de QA. No configurar el opt-in en QA
alojado. BmBackend revalida el token, el acceso admin vigente y la nominación en
cada turno. El compositor de recibos original y su comentario local no cambian.

`POST /api/teach-me/clarifications` (Pages API sin `bodyParser`) transmite un
frame a `/api/v1/teach-me/clarifications` del `BM_BACKEND_URL` configurado. Solo
reenvía el bearer y el tipo canónico `application/vnd.bm.teach-clarification`,
sin parámetros, query, encoding, redirecciones ni caché. Los cuatro puestos del
proxy son compartidos con los recibos y hay un plazo local de 15 s. El frame
usa un prefijo de cuatro bytes big-endian con la longitud del manifiesto UTF-8
(1–32 KiB). El manifiesto es `[1,"ask",xlsxBytes]` o
`[1,"reply",xlsxBytes,pdfBytes,pngBytes,workbookSha256,answer]`, seguido de los
archivos crudos en ese orden, omitiendo los tamaños cero. Máximos: Excel 5 MiB,
PDF/PNG 2 MiB cada uno, respuesta 4 KiB UTF-8 y frame 9 MiB + 32 KiB + 4 bytes.
No se envían nombres de archivo. El proxy acota el éxito JSON a 4 KiB y solo
acepta las variantes `question` (dos citas + SHA-256), `not_applicable` y
`acknowledged`; la interfaz verifica además el turno.

Tras la pregunta se descarta la primera selección. Para responder hay que
reseleccionar el mismo Excel y, opcionalmente, un PDF y/o PNG. El nuevo texto y
los bytes sí viajan en este turno; las referencias se validan como bytes opacos.
El SHA-256 comprueba continuidad, no concede acceso ni identifica un archivo
guardado. La prueba no selecciona una columna, no interpreta las referencias,
no llama a un modelo externo ni crea reglas. Los errores recuperables permiten
reintento explícito en la misma vista. Al cancelar, cerrar, recargar, recibir
una denegación o cambiar de cuenta se borra la conversación. No hay historial
ni persistencia del lado del navegador o del servidor.

Verificación con Node 20: `./init.sh` (sin `--dev`) y
`npm test -- src/app/api/teach-me src/components/teach-me-access.test.tsx src/components/teach-workbook-composer.test.tsx src/components/teach-workbook-composer-auth.test.tsx src/components/teach-clarification-composer.test.tsx`.
Los tests del compositor verifican los dos frames y su representación, no el
layout real. El test de integración contra Ktor se activa desde BmBackend; usa
dos puertos efímeros de loopback y autorización controlada, no un stack QA ni
Firebase real. Véase «Clarify workbook rules» en el README de BmBackend.

## Enséñame: probar un borrador de Skill

Piloto apagado por defecto y **solo para QA local aislado**. Además de los flags
de entorno y aclaración de arriba, requiere `NEXT_PUBLIC_TEACH_DRAFT_LOCAL=true`
en BmWeb y `BM_TEACH_DRAFT_LOCAL=true` en BmBackend. No habilitar en QA alojado
ni producción. La aclaración normal conserva su pregunta, su acuse y su
transporte opcional de PDF/PNG.

En «Probar borrador de Skill», elige `ensename-demo.xlsx` desde el checkout de
BmBackend (`src/test/resources/ensename/ensename-demo.xlsx`), sin volverlo a
guardar. Reselecciona esos mismos bytes en cada turno. Tras ver las dos citas,
elige explícitamente Comercializadora Demo y escribe «La columna B» o «La
columna C». Puedes hacer una corrección para comparar las dos revisiones de
una única regla de columna. «Borrador sin activar» no implica ni una prueba de
extracción ni una validación. Cancelar, cerrar, recargar, salir, cambiar de
cuenta o conocer una denegación borra la vista; no hay historial.

El mismo endpoint Pages usa `application/vnd.bm.teach-supplier-draft` para
seleccionar el wire, el límite de `5 MiB + 32 KiB + 4 bytes` y el esquema de
respuesta. No reenvía nombres ni adjuntos de referencia. Habilitar la vista no
otorga acceso: el backend reautoriza antes de leer cada uno de los tres POST.
El proxy valida el JSON cerrado (máx. 4 KiB) y la huella de contenido; la vista
comprueba el turno, la identidad, el digest y la cita elegida. Los IDs no son
historial, permisos ni localizadores. No se toca la carga PDF ni el catálogo.

Se verifica con los mismos comandos web de arriba. El README de BmBackend
documenta el gate adicional Pages → Netty con el XLSX sintético; no usa
Firebase real, no arranca un stack QA y no verifica el layout en navegador.

## Enséñame: previsualizar precios (V2)

**Solo QA local aislado, apagado por defecto.** Requiere `NEXT_PUBLIC_APP_ENV=qa`,
`NEXT_PUBLIC_TEACH_CLARIFY_LOCAL=true`, `NEXT_PUBLIC_TEACH_DRAFT_LOCAL=true` y
`NEXT_PUBLIC_TEACH_PREVIEW_LOCAL=true`, además de los opt-ins independientes de
BmBackend. No poner los opt-ins de preview en QA alojado ni en producción.
Elige explícitamente Gesternova 2.0TD (sintético) y prepara un borrador V2 con
`gesternova-20td-sanitized.xlsx` de `BmBackend/src/test/resources/ensename/`.
Al pulsar «Previsualizar precios», reselecciona la misma muestra sin volverla a
guardar. El panel conserva la revisión y el resultado en memoria de la vista;
no activa nada ni guarda propuestas, no transforma V1 y no admite el original
comercial u otros libros. Los resultados son literales con citas (no son un
payload de importación). Cambiar la selección, cerrar, recargar, cambiar de
cuenta o conocer una denegación invalida el resultado.

Pages retransmite el frame por `/api/teach-me/clarifications` con el tipo
singleton `application/vnd.bm.teach-draft-preview`, sin nombres ni referencias.
El prefijo BE de cuatro bytes delimita `[1,"prepare",xlsxBytes,profileKey]` o
`[1,"preview",xlsxBytes,profileKey,supplierKey,workbookSha256,revisionId]`, luego
solo el XLSX. El manifiesto admite 1–32 KiB y el XLSX 1 byte–5 MiB. Comparte los
cuatro puestos y 15 s del proxy; el éxito cerrado de 4 KiB valida variante,
regla, citas y huella V2 antes de que la UI compruebe el turno y la revisión.
BmBackend es la única autoridad en cada POST; no hay llamadas a BmPriceAgent.
Véase el README de BmBackend para el contrato canónico del ID y el gate joint.

Verificación con Node 20: `./init.sh` (sin `--dev`) y
`npm test -- src/app/api/teach-me src/components/teach-clarification-composer.test.tsx src/components/teach-me-access.test.tsx src/components/teach-draft-preview.test.tsx`.
