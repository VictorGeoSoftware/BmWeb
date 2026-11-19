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
