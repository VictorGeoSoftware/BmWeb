# Brief de Enséñame

## Objetivo

Un compañero de operaciones debe poder enseñar a BmWeb a leer propuestas de precios eléctricos en Excel sin pedir a un desarrollador que escriba las reglas. La sección **Enséñame** le permite explicar el documento en un chat, revisar la extracción, probarla directamente en QA y solicitar su publicación. Hoy, la carga de propuestas admite PDF y BmPriceAgent usa una Skill compartida para esos documentos; ese flujo no cambia.

## Primera versión

1. En QA, un administrador autorizado abre Enséñame y adjunta un `.xlsx` al mensaje. Puede añadir PDF y capturas `.png` para aclarar las reglas.
2. El asistente inspecciona el Excel, hace preguntas sobre lo que no esté claro y propone una Skill independiente. El autor corrige las reglas y revisa una extracción de prueba sin modificar las propuestas guardadas.
3. El autor activa la Skill en QA sin intervención de un desarrollador. En la carga de propuestas de QA, se identifica la comercializadora primero por el nombre del archivo y, si no se identifica, por su contenido. Si hay una Skill activa para esa comercializadora, se usa para la extracción.
4. Tras comprobar el resultado en QA, el autor puede solicitar su promoción. Se abre un PR con la versión exacta validada. Solo Victor puede aprobar su publicación mediante el merge; Enséñame no hace el merge ni cambia directamente producción.

**Fuera de alcance:** gas, cálculo de ofertas indexadas o híbridas, otros formatos de Excel, creación de Skills para PDF y más de una Skill de Excel activa por comercializadora y entorno.

## Validación del piloto

- Usar `GESTERNOVA_Precios_2.0TD Resumen 140826.xlsx`, de la carpeta de muestras `B&M documents/Excel price proposals`. El libro contiene ofertas fijas, indexadas e híbridas: validar con el autor qué ofertas fijas se esperan y comprobar nombres, tarifas, unidades y valores contra sus celdas. Las restantes no se deben importar.
- Repetir la prueba en la carga de QA con otro libro del mismo formato, real o preparado con precios diferentes y resultado esperado conocido. Verificar selección automática, resultado guardado y ausencia de cambios en producción.
- Comprobar que una comercializadora ambigua, una Skill ausente o un formato incompatible no provocan una importación parcial o incorrecta. Verificar también que la carga PDF existente sigue funcionando y que un administrador sin autorización no puede invocar las operaciones de Enséñame.
- Abrir el PR sin publicar, comprobar que corresponde a la versión probada y verificar que producción no usa esa versión antes del merge y del despliegue.

## Operación

BmWeb es la interfaz; BmBackEnd ya controla la carga y persistencia de propuestas, y BmPriceAgent realiza la extracción. La autorización se concede a administradores nominados y se comprueba en servidor en cada operación; retirarla bloquea nuevas operaciones sin borrar el historial de auditoría. Victor mantiene los permisos y la publicación. Registrar quién activó, validó y solicitó la promoción, la versión, el entorno, el resultado y el enlace del PR, sin registrar los adjuntos ni el contenido del chat.
