BUNNYLING — ACTUALIZACIÓN DE CORRECCIONES
=========================================

ARCHIVOS DEL PAQUETE
--------------------
index.html
memory.js
sw.js
netlify/functions/deepgram.js

DÓNDE COLOCARLOS
----------------
1. Reemplaza el index.html de la raíz del sitio.
2. Reemplaza memory.js de la raíz del sitio.
3. Reemplaza sw.js de la raíz del sitio.
4. Reemplaza la función del servidor en netlify/functions/deepgram.js.
   Si tu proyecto usa otra carpeta de funciones, conserva esa carpeta y
   sustituye el archivo deepgram.js que ya utiliza la ruta
   /.netlify/functions/deepgram.
5. Publica/despliega nuevamente el sitio en Netlify. La función de Deepgram
   también debe quedar desplegada; no basta con copiar los tres archivos web.

QUÉ CAMBIA
----------
- La transcripción envía el archivo binario con MIME determinado por extensión
  y presenta el mensaje completo que devuelve Deepgram, incluyendo request_id.
- La función Netlify reenvía los bytes sin convertir audio/vídeo a texto y
  conserva los encabezados de respuesta que BunnyLing necesita.
- La Biblioteca agrupa los complementos con su material principal; los
  complementos ya no aparecen como archivos independientes.
- La lectura en voz alta evita incorporar dos veces el mismo segmento guardado,
  permite recuperar segmentos parciales y elimina subtítulos duplicados con
  igual texto y marcas de tiempo.
- La versión de alineación de narración sube a 4 para no mezclar subtítulos
  antiguos que pudieron haberse generado con otra alineación.

LÍMITE DE CARGA
---------------
Las funciones síncronas de Netlify tienen un límite de solicitud de 6 MB;
para cargas binarias codificadas en Base64, el tamaño práctico ronda 4,5 MB.
La función incluida avisa si el archivo excede aproximadamente 4,4 MiB.
Es una limitación de la plataforma, no de Deepgram. Para archivos mayores se
necesita una ruta de carga por URL o almacenamiento intermedio, fuera de esta
función síncrona.

IMPORTANTE
----------
No recibí el archivo de función Deepgram que ya estaba desplegado en tu proyecto.
Por eso el ZIP incluye una implementación completa de reemplazo en la ruta
indicada; verifica que tu proyecto Netlify esté configurado para desplegar
netlify/functions como directorio de funciones.
