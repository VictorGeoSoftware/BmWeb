# Modelo de dominio de Enséñame

- **Comercializadora:** identidad canónica a la que se asocia una Skill. Se busca en el nombre del archivo y, si no se reconoce allí, en el contenido. Si hay señales incompatibles o no se puede resolver una identidad única, se avisa y no se importan precios.
- **Sesión de enseñanza:** conversación con mensajes, un Excel de muestra y adjuntos de referencia opcionales. Produce un borrador de Skill y uno o más resultados de prueba.
- **Versión de Skill:** revisión identificable de las reglas. Un borrador se puede corregir y probar sin afectar a la carga normal. La versión activada en QA pasa a ser la seleccionada para esa comercializadora en ese entorno. Cada entorno admite como máximo una versión activa por comercializadora.
- **Validación en QA:** aprobación explícita del autor sobre el resultado de una prueba de la versión activa. Ajustar las reglas genera otra versión, que debe volver a probarse antes de promoverse. Si el esquema del Excel no encaja en la Skill, la carga falla explícitamente y no guarda propuestas.
- **Solicitud de promoción:** vincula la versión validada en QA con su PR. Abrirlo no cambia el entorno de producción; el despliegue posterior al merge es lo que hace disponible la versión en producción. Si el PR se cierra sin merge o el despliegue falla, la versión no se considera publicada.
