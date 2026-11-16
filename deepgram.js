'use strict';

/*
 * BunnyLing — proxy de Deepgram para Netlify Functions.
 * Mantiene intacto el cuerpo binario de audio/vídeo recibido por Netlify.
 * Rutas permitidas: /v1/models, /v1/listen y /v1/speak.
 */
const API_BASE = 'https://api.deepgram.com';
const ALLOWED_PATHS = new Set(['/v1/models', '/v1/listen', '/v1/speak']);
const MAX_BUFFERED_BINARY_BYTES = Math.floor(4.4 * 1024 * 1024);

const response = (statusCode, data, extraHeaders = {}) => ({
  statusCode,
  headers: {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...extraHeaders
  },
  body: JSON.stringify(data)
});

function headerValue(headers, wanted) {
  const key = Object.keys(headers || {}).find(k => k.toLowerCase() === wanted.toLowerCase());
  return key ? String(headers[key] || '') : '';
}

function queryEntries(event) {
  const single = event.queryStringParameters || {};
  const multi = event.multiValueQueryStringParameters || {};
  const out = new URLSearchParams();
  for (const [key, value] of Object.entries(single)) {
    if (key === 'path' || value == null) continue;
    if (Object.prototype.hasOwnProperty.call(multi, key) && Array.isArray(multi[key])) {
      for (const item of multi[key]) if (item != null) out.append(key, String(item));
    } else {
      out.set(key, String(value));
    }
  }
  return out;
}

exports.handler = async function handler(event) {
  const method = String(event.httpMethod || 'GET').toUpperCase();
  if (method === 'OPTIONS') {
    return { statusCode: 204, headers: { 'cache-control': 'no-store' }, body: '' };
  }
  if (!['GET', 'POST'].includes(method)) {
    return response(405, { err_code: 'METHOD_NOT_ALLOWED', err_msg: 'Método no permitido.' }, { allow: 'GET, POST, OPTIONS' });
  }

  const query = event.queryStringParameters || {};
  const path = String(query.path || '');
  if (!ALLOWED_PATHS.has(path)) {
    return response(404, { err_code: 'INVALID_DEEPGRAM_PATH', err_msg: 'Ruta Deepgram no permitida.' });
  }
  if ((path === '/v1/models' && method !== 'GET') || (path !== '/v1/models' && method !== 'POST')) {
    return response(405, { err_code: 'METHOD_NOT_ALLOWED', err_msg: 'Método no válido para esta ruta.' });
  }

  const authorization = headerValue(event.headers, 'authorization');
  if (!authorization) {
    return response(401, { err_code: 'MISSING_AUTHORIZATION', err_msg: 'Falta la clave API de Deepgram en Ajustes.' });
  }

  const url = new URL(path, API_BASE);
  const params = queryEntries(event);
  params.forEach((value, key) => url.searchParams.append(key, value));

  const requestHeaders = { authorization };
  const contentType = headerValue(event.headers, 'content-type');
  const accept = headerValue(event.headers, 'accept');
  if (contentType) requestHeaders['content-type'] = contentType;
  if (accept) requestHeaders.accept = accept;

  let body;
  if (method === 'POST') {
    if (typeof event.body !== 'string' || event.body.length === 0) {
      return response(400, { err_code: 'EMPTY_REQUEST_BODY', err_msg: 'El archivo o texto enviado a Deepgram está vacío.' });
    }

    const isBinary = /^(audio|video)\//i.test(contentType) || /application\/(?:octet-stream|pdf)/i.test(contentType);
    if (isBinary && !event.isBase64Encoded) {
      // No reenviar bytes ya convertidos a UTF-8: eso corrompería MP3/MP4 y causa HTTP 400 en Deepgram.
      return response(400, {
        err_code: 'NETLIFY_BINARY_BODY_NOT_BASE64',
        err_msg: 'Netlify recibió el archivo binario sin codificación Base64. No se envió a Deepgram para evitar corromper el audio/vídeo. Verifica que la solicitud conserve isBase64Encoded=true.'
      });
    }

    body = event.isBase64Encoded
      ? Buffer.from(event.body, 'base64')
      : Buffer.from(event.body, 'utf8');

    if (!body.length) {
      return response(400, { err_code: 'EMPTY_DECODED_BODY', err_msg: 'No se pudieron recuperar los bytes del archivo.' });
    }
    if (isBinary && body.length > MAX_BUFFERED_BINARY_BYTES) {
      return response(413, {
        err_code: 'NETLIFY_BINARY_LIMIT',
        err_msg: 'El archivo supera el límite práctico de carga binaria de esta función de Netlify (aprox. 4,4 MiB). Usa un archivo de audio más pequeño o una carga mediante URL.'
      });
    }
  }

  try {
    const upstream = await fetch(url, {
      method,
      headers: requestHeaders,
      body,
      redirect: 'follow'
    });
    const bytes = Buffer.from(await upstream.arrayBuffer());
    const upstreamType = upstream.headers.get('content-type') || 'application/json; charset=utf-8';
    const headers = {
      'content-type': upstreamType,
      'cache-control': 'no-store'
    };

    // BunnyLing necesita este encabezado de TTS para comprobar si Deepgram truncó el texto.
    for (const name of ['dg-char-count', 'dg-request-id', 'x-request-id', 'retry-after']) {
      const value = upstream.headers.get(name);
      if (value) headers[name] = value;
    }

    const textual = /(?:application\/json|text\/)/i.test(upstreamType);
    return {
      statusCode: upstream.status,
      headers,
      body: textual ? bytes.toString('utf8') : bytes.toString('base64'),
      isBase64Encoded: !textual
    };
  } catch (error) {
    return response(502, {
      err_code: 'DEEPGRAM_PROXY_ERROR',
      err_msg: 'No se pudo conectar con Deepgram desde Netlify.',
      detail: String(error?.message || error || 'Error de red').slice(0, 300)
    });
  }
};
