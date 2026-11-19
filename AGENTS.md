# Instrucciones del repositorio

BmWeb es el panel de administración de BM. Este harness organiza **Enséñame**, la sección de QA para crear Skills de extracción de precios eléctricos en Excel.

## Lectura inicial

- `CONTEXT.md`: vocabulario del dominio.
- `docs/build-brief.md`: alcance y criterios del piloto.
- `docs/domain-model.md`: selección, versiones y estados.
- `docs/risks-and-open-questions.md`: decisiones pendientes y condiciones para habilitar QA y producción.
- `DESIGN.md`: pautas de interfaz para Enséñame.

## Inicio y verificación

1. Confirma la raíz de `BmWeb` con `pwd` y revisa `PROGRESS.md`.
2. Elige la primera entrada pendiente de `feature_list.json` cuyas dependencias estén `accepted`. Trabaja una por sesión y prepara su especificación antes de implementar.
3. Usa Node 20. Si faltan dependencias, ejecuta `npm ci`. Ejecuta `./init.sh` para verificar la línea base (`npm run typecheck` y `npm test`). Si falla, identifica y registra el motivo antes de empezar.
4. Para arrancar la web local, usa `./init.sh --dev` con Firebase y `BM_BACKEND_URL` configurados para QA; Next.js escucha en el puerto `9002`.

## Entrega

- Mantén la carga PDF existente y respeta los límites entre BmWeb (interfaz), BmBackEnd (autorización y persistencia) y BmPriceAgent (extracción). Lee las instrucciones de cada repositorio que afecte el cambio.
- Comprueba la autorización y el entorno en servidor. QA no puede modificar el catálogo de producción; el PR de promoción no se fusiona desde Enséñame.
- Ejecuta la verificación base y las comprobaciones de la entrada seleccionada, incluidas las de otros repositorios si aplica. Registra evidencia, bloqueos y próximos pasos en `feature_list.json` y `PROGRESS.md`. Usa `passing` tras la verificación y reserva `accepted` para la validación independiente.
