// BunnyLing · proxy seguro de Deepgram para Netlify Functions (API moderna Request/Response).
// La clave se recibe por HTTPS en Authorization; no se almacena, no se escribe en logs y
// nunca se devuelve al navegador en la respuesta.

const DEEPGRAM = 'https://api.deepgram.com';
const ALLOWED_GET = new Set(['/v1/models']);
const ALLOWED_POST = new Set(['/v1/listen', '/v1/speak']);

function json(data, status = 200) {
  return Response.json(data, {
    status,
    headers: {
      'Cache-Control': 'no-store, max-age=0',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

export default async function deepgramProxy(request) {
  const incoming = new URL(request.url);
  const path = incoming.searchParams.get('path') || '';
  const method = request.method.toUpperCase();

  if (method !== 'GET' && method !== 'POST') {
    return json({ message: 'Método no permitido' }, 405);
  }
  if ((method === 'GET' && !ALLOWED_GET.has(path)) ||
      (method === 'POST' && !ALLOWED_POST.has(path))) {
    return json({ message: 'Ruta Deepgram no permitida' }, 404);
  }

  const apiKey = request.headers.get('authorization');
  if (method === 'POST' && !apiKey) {
    return json({ message: 'Falta la clave de Deepgram en Ajustes de BunnyLing' }, 401);
  }

  const query = new URLSearchParams(incoming.searchParams);
  query.delete('path');
  const target = DEEPGRAM + path + (query.size ? `?${query.toString()}` : '');
  const headers = new Headers();
  if (apiKey) headers.set('Authorization', apiKey);
  if (method === 'POST') {
    const contentType = request.headers.get('content-type');
    if (contentType) headers.set('Content-Type', contentType);
  } else {
    headers.set('Accept', 'application/json');
  }

  try {
    // Se reenvía el cuerpo sin transformarlo: audio binario para /listen y JSON para /speak.
    const upstream = await fetch(target, {
      method,
      headers,
      body: method === 'POST' ? await request.arrayBuffer() : undefined,
      redirect: 'follow',
    });

    const responseHeaders = new Headers({
      'Cache-Control': 'no-store, max-age=0',
      'X-Content-Type-Options': 'nosniff',
    });
    const contentType = upstream.headers.get('content-type');
    if (contentType) responseHeaders.set('Content-Type', contentType);

    return new Response(upstream.body, {
      status: upstream.status,
      headers: responseHeaders,
    });
  } catch (error) {
    // No incluir la clave ni los encabezados en el error.
    return json({
      message: 'No se pudo conectar con la API de Deepgram desde Netlify',
      detail: String(error?.message || 'error de red'),
    }, 502);
  }
}
