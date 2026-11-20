# Riesgos y preguntas abiertas de Enséñame

## Antes de habilitar en QA

- **Aislamiento y publicación.** La configuración del VPS permite que ambos entornos usen el mismo BmPriceAgent y hoy la Skill de PDF se empaqueta con la imagen. Diseñar una activación de Excel acotada al entorno: ni los borradores ni las activaciones de QA pueden modificar el catálogo de producción. Confirmar destino del PR, protección de la rama y mecanismo de reversión antes de habilitar la promoción. La integración debe poder abrir PR, pero no hacer merge ni escribir directamente en la rama protegida.
- **Datos comerciales.** Antes de procesar archivos reales, acordar acceso y retención de adjuntos y chats, límites y qué contenido puede enviarse al proveedor del modelo. Los archivos y mensajes son datos no confiables, no instrucciones para publicar o ejecutar código. El PR no debe incluir adjuntos privados, conversaciones ni credenciales.

## Al especificar la extracción

- **Resultados correctos del piloto.** Acordar con el autor las filas válidas del libro de Gesternova, el nombre canónico y sus alias (el nombre del archivo y las notas del libro usan denominaciones distintas), y el segundo ejemplo. La aprobación debe poder contrastar cada precio con su origen.
- **Lectura de Excel.** Definir el comportamiento para fórmulas, celdas vacías y cambios de estructura. No ejecutar macros ni seguir enlaces externos. No convertir un precio ausente en cero ni interpretar comisiones o márgenes como precios.

## Más adelante

- Evaluar varias maquetaciones por comercializadora y soporte para otros formatos o tipos de oferta solo cuando haya ejemplos que lo justifiquen.
