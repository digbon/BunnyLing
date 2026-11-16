/* BunnyLing Central Memory & Artifact Registry (memory.js)
 * Archivo central que gestiona:
 * 1. Identificación determinista de materiales por huella digital de contenido (SHA-256) + nombre.
 * 2. Registro unificado en IndexedDB + espejo en carpeta local (`bunnyling-memoria.json`).
 * 3. Consulta estricta ANTES de gastar tokens de IA (traducciones, búsquedas en contexto,
 *    transcripciones y generación de voz alta con sus subtítulos sincronizados).
 * 4. Trazabilidad exacta de rangos: qué archivo corresponde a qué material, y de dónde a dónde
 *    (bloques, párrafos, tiempos y porcentajes) cubre cada traducción, transcripción o narración.
 */
'use strict';

window.BunnyMemory = (() => {
  const MANIFEST_FILE = 'bunnyling-memoria.json';
  const META_KEY = 'bunnyling_central_memory_v1';
  const SCHEMA_VERSION = 1;

  let deps = {
    DB: null,
    getDirHandle: () => null,
    dirWritable: async () => false,
    parseSubs: () => [],
    wordsToCues: () => [],
    narBlobDur: async () => 0,
    WORD_RE: /\p{L}[\p{L}\p{N}]*(?:[-'’][\p{L}\p{N}]+)*/gu,
    normKey: w => String(w || '').toLowerCase().trim()
  };

  let state = {
    version: SCHEMA_VERSION,
    updatedAt: new Date().toISOString(),
    documents: {}
  };

  let initPromise = null;
  let persistTimer = null;

  const normText = s => String(s || '').replace(/\r\n?/g, '\n').replace(/\s+/g, ' ').trim();
  const baseNameOf = name => String(name || 'contenido').replace(/\.[^.]+$/, '');
  const normFileName = name => String(name || '').toLowerCase().trim();

  function hashText(str) {
    const s = normText(str);
    let h1 = 0xdeadbeef ^ s.length;
    let h2 = 0x41c6ce57 ^ s.length;
    for (let i = 0; i < s.length; i++) {
      const ch = s.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (h2 >>> 0).toString(16).padStart(8, '0') + (h1 >>> 0).toString(16).padStart(8, '0');
  }

  async function fingerprintBlob(blob, fallbackName = '') {
    if (!blob || typeof blob.size !== 'number') {
      return 'name:' + hashText(fallbackName || 'unknown');
    }
    const size = blob.size;
    const headLen = Math.min(size, 262144);
    const tailLen = size > 262144 ? Math.min(size - headLen, 262144) : 0;
    const midStart = size > 786432 ? Math.floor(size / 2) - 65536 : 0;
    const midLen = midStart > 0 ? Math.min(131072, size - midStart - tailLen) : 0;

    const parts = [await blob.slice(0, headLen).arrayBuffer()];
    if (midLen > 0) parts.push(await blob.slice(midStart, midStart + midLen).arrayBuffer());
    if (tailLen > 0) parts.push(await blob.slice(size - tailLen, size).arrayBuffer());
    parts.push(new TextEncoder().encode(`|size:${size}`).buffer);

    if (globalThis.crypto?.subtle) {
      const combined = new Uint8Array(parts.reduce((acc, b) => acc + b.byteLength, 0));
      let offset = 0;
      for (const buf of parts) {
        combined.set(new Uint8Array(buf), offset);
        offset += buf.byteLength;
      }
      const digest = await crypto.subtle.digest('SHA-256', combined);
      const hex = [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
      return `sha256:${hex.slice(0, 32)}:${size}`;
    }
    const sampleText = await blob.slice(0, Math.min(size, 65536)).text().catch(() => fallbackName);
    return `fnv:${hashText(sampleText)}:${size}`;
  }

  function ensureDoc(docHash, meta = {}) {
    let doc = state.documents[docHash];
    if (!doc) {
      doc = {
        docHash,
        sourceId: meta.sourceId || null,
        fileName: meta.fileName || 'contenido',
        normName: normFileName(meta.fileName || 'contenido'),
        kind: meta.kind || 'doc',
        size: meta.size || 0,
        totalBlocks: meta.totalBlocks || 0,
        totalParagraphs: meta.totalParagraphs || 0,
        totalLetters: meta.totalLetters || 0,
        durationSec: meta.durationSec || 0,
        updatedAt: new Date().toISOString(),
        files: {
          translations: baseNameOf(meta.fileName) + '.traducciones.json',
          transcriptionJson: baseNameOf(meta.fileName) + '.transcripcion.json',
          transcriptionSrt: baseNameOf(meta.fileName) + '.transcripcion.srt',
          narrationManifest: baseNameOf(meta.fileName) + '.narracion.json'
        },
        translations: {},
        transcriptions: {},
        narrations: {}
      };
      state.documents[docHash] = doc;
    } else {
      if (meta.sourceId) doc.sourceId = meta.sourceId;
      if (meta.fileName) {
        doc.fileName = meta.fileName;
        doc.normName = normFileName(meta.fileName);
        doc.files ||= {};
        doc.files.translations ||= baseNameOf(meta.fileName) + '.traducciones.json';
        doc.files.transcriptionJson ||= baseNameOf(meta.fileName) + '.transcripcion.json';
        doc.files.transcriptionSrt ||= baseNameOf(meta.fileName) + '.transcripcion.srt';
        doc.files.narrationManifest ||= baseNameOf(meta.fileName) + '.narracion.json';
      }
      if (meta.kind) doc.kind = meta.kind;
      if (meta.size) doc.size = meta.size;
      if (Number.isFinite(meta.totalBlocks) && meta.totalBlocks > 0) doc.totalBlocks = meta.totalBlocks;
      if (Number.isFinite(meta.totalParagraphs) && meta.totalParagraphs > 0) doc.totalParagraphs = meta.totalParagraphs;
      if (Number.isFinite(meta.totalLetters) && meta.totalLetters > 0) doc.totalLetters = meta.totalLetters;
      if (Number.isFinite(meta.durationSec) && meta.durationSec > 0) doc.durationSec = meta.durationSec;
      doc.updatedAt = new Date().toISOString();
    }
    return doc;
  }

  function findDocByAny({ docHash, sourceId, fileName } = {}) {
    if (docHash && state.documents[docHash]) return state.documents[docHash];
    const all = Object.values(state.documents);
    if (sourceId) {
      const byId = all.find(d => d.sourceId === sourceId);
      if (byId) return byId;
    }
    if (fileName) {
      const nn = normFileName(fileName);
      const byName = all.find(d => d.normName === nn);
      if (byName) return byName;
    }
    return null;
  }

  function computeRanges(blockIndices, blocks = [], paras = [], totalLetters = 0) {
    const sorted = [...new Set(blockIndices.filter(n => Number.isInteger(n) && n >= 0))].sort((a, b) => a - b);
    if (!sorted.length) return [];
    const cumLetters = [];
    let acc = 0;
    for (let i = 0; i < blocks.length; i++) {
      cumLetters[i] = acc;
      acc += Number(blocks[i]?.letters) || String(blocks[i]?.text || '').length;
    }
    const tot = Math.max(1, totalLetters || acc);
    const ranges = [];
    let start = sorted[0];
    let prev = sorted[0];

    const pushRange = (fromB, toB) => {
      const b0 = blocks[fromB];
      const b1 = blocks[toB];
      const fromPara = b0?.from ?? fromB;
      const toPara = b1?.to ?? toB;
      const fromTime = Number(paras[fromPara]?.start) || 0;
      const toTime = Number(paras[toPara]?.end) || 0;
      const startL = cumLetters[fromB] ?? 0;
      const endL = (cumLetters[toB] ?? startL) + (Number(b1?.letters) || String(b1?.text || '').length);
      ranges.push({
        fromBlock: fromB,
        toBlock: toB,
        fromPara,
        toPara,
        fromTime: Math.round(fromTime * 100) / 100,
        toTime: Math.round(toTime * 100) / 100,
        fromPct: Math.max(0, Math.min(100, Math.round((startL / tot) * 100))),
        toPct: Math.max(0, Math.min(100, Math.round((endL / tot) * 100))),
        complete: blocks.length > 0 && fromB === 0 && toB === blocks.length - 1
      });
    };

    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i] === prev + 1) {
        prev = sorted[i];
      } else {
        pushRange(start, prev);
        start = prev = sorted[i];
      }
    }
    pushRange(start, prev);
    return ranges;
  }

  function schedulePersist(immediate = false) {
    state.updatedAt = new Date().toISOString();
    if (!deps.DB) return Promise.resolve();
    const run = async () => {
      try {
        await deps.DB.meta.set(META_KEY, state);
      } catch (e) {
        console.warn('BunnyMemory: error guardando en IndexedDB:', e);
      }
      await exportManifestToFolder(false);
    };
    clearTimeout(persistTimer);
    if (immediate) return run();
    persistTimer = setTimeout(run, 250);
    return Promise.resolve();
  }

  async function writeFileToFolder(fileName, content) {
    const dirH = deps.getDirHandle?.();
    if (!dirH || !(await deps.dirWritable(false))) return false;
    try {
      const fh = await dirH.getFileHandle(fileName, { create: true });
      const w = await fh.createWritable();
      await w.write(content);
      await w.close();
      return true;
    } catch {
      return false;
    }
  }

  async function readJsonFromFolder(fileName) {
    const dirH = deps.getDirHandle?.();
    if (!dirH) return null;
    try {
      const fh = await dirH.getFileHandle(fileName);
      const txt = await (await fh.getFile()).text();
      return JSON.parse(txt);
    } catch {
      return null;
    }
  }

  async function readBlobFromFolder(fileName) {
    const dirH = deps.getDirHandle?.();
    if (!dirH) return null;
    try {
      const fh = await dirH.getFileHandle(fileName);
      return await fh.getFile();
    } catch {
      return null;
    }
  }

  function buildExportableManifest() {
    const docsOut = {};
    for (const [docHash, doc] of Object.entries(state.documents)) {
      const narrsSummary = {};
      for (const [k, n] of Object.entries(doc.narrations || {})) {
        const { cues, ...rest } = n;
        narrsSummary[k] = { ...rest, cueCount: Array.isArray(cues) ? cues.length : (n.cueCount || 0) };
      }
      const trsSummary = {};
      for (const [pair, tr] of Object.entries(doc.translations || {})) {
        trsSummary[pair] = {
          sourceLang: tr.sourceLang,
          targetLang: tr.targetLang,
          fileName: tr.fileName,
          model: tr.model,
          updatedAt: tr.updatedAt,
          totalItems: Object.keys(tr.items || {}).length,
          ranges: tr.ranges || []
        };
      }
      docsOut[docHash] = {
        docHash: doc.docHash,
        sourceId: doc.sourceId,
        fileName: doc.fileName,
        kind: doc.kind,
        size: doc.size,
        totalBlocks: doc.totalBlocks,
        totalParagraphs: doc.totalParagraphs,
        totalLetters: doc.totalLetters,
        durationSec: doc.durationSec,
        updatedAt: doc.updatedAt,
        files: doc.files,
        translations: trsSummary,
        transcriptions: doc.transcriptions || {},
        narrations: narrsSummary
      };
    }
    return {
      app: 'BunnyLing',
      manifestoCentral: MANIFEST_FILE,
      version: SCHEMA_VERSION,
      updatedAt: state.updatedAt,
      totalDocumentos: Object.keys(docsOut).length,
      documentos: docsOut
    };
  }

  async function exportManifestToFolder(ask = false) {
    const dirH = deps.getDirHandle?.();
    if (!dirH || !(await deps.dirWritable(ask))) return false;
    try {
      const fh = await dirH.getFileHandle(MANIFEST_FILE, { create: true });
      const w = await fh.createWritable();
      await w.write(JSON.stringify(buildExportableManifest(), null, 2));
      await w.close();
      return true;
    } catch {
      return false;
    }
  }

  async function mergeFolderManifest() {
    const remote = await readJsonFromFolder(MANIFEST_FILE);
    const docs = remote?.documentos || remote?.documents;
    if (!docs || typeof docs !== 'object') return false;
    let changed = false;
    for (const [docHash, rDoc] of Object.entries(docs)) {
      const local = ensureDoc(docHash, rDoc);
      if (rDoc.transcriptions) {
        for (const [lang, rTr] of Object.entries(rDoc.transcriptions)) {
          if (!local.transcriptions[lang]) {
            local.transcriptions[lang] = { ...rTr };
            changed = true;
          }
        }
      }
      if (rDoc.narrations) {
        for (const [nk, rNar] of Object.entries(rDoc.narrations)) {
          if (!local.narrations[nk] && rNar.complete) {
            local.narrations[nk] = { ...rNar };
            changed = true;
          }
        }
      }
      if (rDoc.translations) {
        for (const [pair, rTrMeta] of Object.entries(rDoc.translations)) {
          if (!local.translations[pair]) {
            local.translations[pair] = {
              sourceLang: rTrMeta.sourceLang,
              targetLang: rTrMeta.targetLang,
              fileName: rTrMeta.fileName || local.files.translations,
              model: rTrMeta.model || '',
              updatedAt: rTrMeta.updatedAt || new Date().toISOString(),
              ranges: rTrMeta.ranges || [],
              items: {},
              lookups: {}
            };
            changed = true;
          }
        }
      }
    }
    if (changed) await schedulePersist(true);
    return changed;
  }

  async function init(injectedDeps) {
    deps = { ...deps, ...injectedDeps };
    if (!initPromise) {
      initPromise = (async () => {
        try {
          const saved = await deps.DB?.meta.get(META_KEY);
          if (saved && typeof saved === 'object' && saved.documents) {
            state = {
              version: SCHEMA_VERSION,
              updatedAt: saved.updatedAt || new Date().toISOString(),
              documents: saved.documents
            };
          }
        } catch (e) {
          console.warn('BunnyMemory: error cargando memoria central:', e);
        }
        await mergeFolderManifest();
        return state;
      })();
    }
    return initPromise;
  }

  /* ==================== 1. REGISTRO DE MATERIAL ==================== */
  async function registerDocument(file, extra = {}) {
    await init(deps);
    const docHash = await fingerprintBlob(file?.blob, file?.name);
    const existingByLegacy = findDocByAny({ sourceId: file?.id, fileName: file?.name });
    if (existingByLegacy && existingByLegacy.docHash !== docHash && !state.documents[docHash]) {
      // Migrar historial previo (por ID o nombre) al docHash definitivo para no perder nada
      state.documents[docHash] = { ...existingByLegacy, docHash };
      delete state.documents[existingByLegacy.docHash];
    }
    const doc = ensureDoc(docHash, {
      sourceId: file?.id,
      fileName: file?.name,
      kind: extra.kind || file?.kind,
      size: file?.size || file?.blob?.size || 0,
      totalBlocks: extra.totalBlocks,
      totalParagraphs: extra.totalParagraphs,
      totalLetters: extra.totalLetters,
      durationSec: extra.durationSec
    });
    await schedulePersist(false);
    return {
      docHash,
      sourceId: doc.sourceId,
      fileName: doc.fileName,
      files: { ...doc.files }
    };
  }

  function updateDocumentStructure(docHash, { kind, totalBlocks, totalParagraphs, totalLetters, durationSec } = {}) {
    if (!docHash || !state.documents[docHash]) return;
    ensureDoc(docHash, { kind, totalBlocks, totalParagraphs, totalLetters, durationSec });
    schedulePersist(false);
  }

  /* ==================== 2. TRADUCCIONES (CONSULTA PREVIA ESTRICTA) ==================== */
  async function hydrateTranslationsFromFolder(doc, sourceLang, targetLang) {
    const pair = `${sourceLang}->${targetLang}`;
    const trFile = doc.files?.translations || baseNameOf(doc.fileName) + '.traducciones.json';
    const d = await readJsonFromFolder(trFile);
    if (!d || d.origen !== sourceLang || d.destino !== targetLang || !Array.isArray(d.traducciones)) return 0;
    const bucket = doc.translations[pair] ||= {
      sourceLang,
      targetLang,
      fileName: trFile,
      model: d.modelo || '',
      updatedAt: d.actualizado || new Date().toISOString(),
      ranges: [],
      items: {},
      lookups: {}
    };
    let added = 0;
    for (const row of d.traducciones) {
      if (!row?.texto || !row?.traduccion) continue;
      const th = hashText(row.texto);
      if (!bucket.items[th]) {
        bucket.items[th] = {
          text: row.texto,
          translation: row.traduccion,
          blockIndex: Number.isInteger(row.bloque) ? row.bloque : -1,
          paraIndex: Number.isInteger(row.parrafo) ? row.parrafo : -1,
          start: Number(row.desdeTiempo) || 0,
          end: Number(row.hastaTiempo) || 0,
          updatedAt: d.actualizado || new Date().toISOString()
        };
        added++;
      }
    }
    if (Array.isArray(d.rangos)) bucket.ranges = d.rangos;
    return added;
  }

  async function getTranslations(docCtx, sourceLang, targetLang, blocks = [], legacyTrc = {}) {
    await init(deps);
    const doc = findDocByAny(docCtx);
    const pair = `${sourceLang}->${targetLang}`;
    if (doc) await hydrateTranslationsFromFolder(doc, sourceLang, targetLang);

    const bucket = doc?.translations?.[pair];
    const items = bucket?.items || {};
    const byBlock = new Map();
    for (const it of Object.values(items)) {
      if (Number.isInteger(it.blockIndex) && it.blockIndex >= 0 && it.translation) {
        byBlock.set(it.blockIndex, it);
      }
    }

    const foundMap = new Map();
    const missingIndices = [];

    blocks.forEach((bl, bi) => {
      const th = hashText(bl.text);
      const hit = items[th] || byBlock.get(bi);
      if (hit?.translation) {
        foundMap.set(bi, hit.translation);
        return;
      }
      if (legacyTrc && legacyTrc[bl.text]) {
        foundMap.set(bi, legacyTrc[bl.text]);
        return;
      }
      missingIndices.push(bi);
    });

    return {
      foundMap,
      missingIndices,
      ranges: bucket?.ranges || [],
      fileName: bucket?.fileName || doc?.files?.translations || ''
    };
  }

  async function saveTranslations(docCtx, sourceLang, targetLang, entries, { blocks = [], paras = [], totalLetters = 0, model = '' } = {}) {
    await init(deps);
    const doc = findDocByAny(docCtx) || (docCtx?.docHash ? ensureDoc(docCtx.docHash, docCtx) : null);
    if (!doc) return null;
    const pair = `${sourceLang}->${targetLang}`;
    const trFile = doc.files?.translations || baseNameOf(doc.fileName) + '.traducciones.json';
    const now = new Date().toISOString();

    const bucket = doc.translations[pair] ||= {
      sourceLang,
      targetLang,
      fileName: trFile,
      model,
      updatedAt: now,
      ranges: [],
      items: {},
      lookups: {}
    };
    if (model) bucket.model = model;
    bucket.updatedAt = now;

    for (const e of entries) {
      if (!e?.text || !e?.translation) continue;
      const th = hashText(e.text);
      bucket.items[th] = {
        text: e.text,
        translation: e.translation,
        blockIndex: Number.isInteger(e.blockIndex) ? e.blockIndex : -1,
        paraIndex: Number.isInteger(e.paraIndex) ? e.paraIndex : -1,
        start: Number(e.start) || 0,
        end: Number(e.end) || 0,
        updatedAt: now
      };
    }

    // Recalcular rangos exactos cubiertos en el documento actual
    const coveredBlocks = [];
    blocks.forEach((bl, bi) => {
      const th = hashText(bl.text);
      if (bucket.items[th]?.translation) coveredBlocks.push(bi);
    });
    bucket.ranges = computeRanges(coveredBlocks, blocks, paras, totalLetters || doc.totalLetters);

    await schedulePersist(false);

    // Escribir archivo detallado de traducciones en la carpeta local si está conectada
    const orderedItems = blocks.length
      ? blocks.map((bl, bi) => {
          const it = bucket.items[hashText(bl.text)];
          if (!it?.translation) return null;
          const p0 = paras[bl.from];
          const p1 = paras[bl.to];
          return {
            bloque: bi,
            parrafoDesde: bl.from,
            parrafoHasta: bl.to,
            desdeTiempo: Number(p0?.start) || 0,
            hastaTiempo: Number(p1?.end) || 0,
            texto: bl.text,
            traduccion: it.translation
          };
        }).filter(Boolean)
      : Object.values(bucket.items).map(it => ({
          bloque: it.blockIndex,
          parrafoDesde: it.paraIndex,
          parrafoHasta: it.paraIndex,
          desdeTiempo: it.start || 0,
          hastaTiempo: it.end || 0,
          texto: it.text,
          traduccion: it.translation
        }));

    await writeFileToFolder(trFile, JSON.stringify({
      version: 2,
      manifestoCentral: MANIFEST_FILE,
      docHash: doc.docHash,
      archivo: doc.fileName,
      origen: sourceLang,
      destino: targetLang,
      modelo: bucket.model,
      actualizado: now,
      rangos: bucket.ranges,
      traducciones: orderedItems
    }, null, 2));

    return bucket;
  }

  function getLookup(docCtx, sourceLang, targetLang, selection, paragraph) {
    const doc = findDocByAny(docCtx);
    const pair = `${sourceLang}->${targetLang}`;
    const key = `${hashText(selection)}|${hashText(paragraph || selection)}`;
    return doc?.translations?.[pair]?.lookups?.[key]?.translation || null;
  }

  async function saveLookup(docCtx, sourceLang, targetLang, selection, paragraph, translation) {
    await init(deps);
    const doc = findDocByAny(docCtx);
    if (!doc || !selection || !translation) return;
    const pair = `${sourceLang}->${targetLang}`;
    const bucket = doc.translations[pair] ||= {
      sourceLang,
      targetLang,
      fileName: doc.files?.translations || baseNameOf(doc.fileName) + '.traducciones.json',
      model: '',
      updatedAt: new Date().toISOString(),
      ranges: [],
      items: {},
      lookups: {}
    };
    const key = `${hashText(selection)}|${hashText(paragraph || selection)}`;
    bucket.lookups[key] = {
      selection,
      paragraphHash: hashText(paragraph || selection),
      translation,
      updatedAt: new Date().toISOString()
    };
    await schedulePersist(false);
  }

  /* ==================== 3. TRANSCRIPCIONES (CONSULTA PREVIA ESTRICTA) ==================== */
  async function getTranscription(docCtx, sourceLang, groupId = null) {
    await init(deps);
    const doc = findDocByAny(docCtx);
    const allFiles = (await deps.DB?.all()) || [];

    // 1. Buscar primero en el registro central por docHash + idioma
    const meta = doc?.transcriptions?.[sourceLang];
    if (meta) {
      if (meta.dbFileId) {
        const stored = allFiles.find(f => f.id === meta.dbFileId && f.blob);
        if (stored) {
          const cues = deps.parseSubs(await stored.blob.text());
          if (cues.length) {
            return { cues, record: meta, source: 'central-db', supFile: stored };
          }
        }
      }
      // Intentar recuperar desde la carpeta local
      for (const fname of [meta.jsonFileName, meta.srtFileName].filter(Boolean)) {
        const blob = await readBlobFromFolder(fname);
        if (blob) {
          const cues = deps.parseSubs(await blob.text());
          if (cues.length) {
            const sup = {
              id: meta.dbFileId || crypto.randomUUID(),
              groupId: groupId || doc.sourceId || crypto.randomUUID(),
              role: 'supplement',
              name: fname,
              size: blob.size,
              kind: fname.endsWith('.json') ? 'json' : 'subs',
              blob,
              docHash: doc.docHash,
              sourceLang,
              lastOpened: Date.now()
            };
            await deps.DB.put(sup);
            meta.dbFileId = sup.id;
            await schedulePersist(false);
            return { cues, record: meta, source: 'central-folder', supFile: sup };
          }
        }
      }
    }

    // 2. Buscar suplementos ya guardados en IndexedDB para este docHash o groupId
    const dbSup = allFiles.find(f =>
      f.role === 'supplement' &&
      f.blob &&
      ((doc?.docHash && f.docHash === doc.docHash && (!f.sourceLang || f.sourceLang === sourceLang)) ||
        (groupId && f.groupId === groupId && /transcripci[oó]n/i.test(f.name || '')))
    );
    if (dbSup) {
      const cues = deps.parseSubs(await dbSup.blob.text());
      if (cues.length) {
        if (doc) {
          await saveTranscription(docCtx, sourceLang, cues, {
            sttModel: dbSup.sttModel || '',
            existingDbId: dbSup.id,
            groupId: dbSup.groupId
          });
        }
        return { cues, record: doc?.transcriptions?.[sourceLang] || null, source: 'indexeddb-supplement', supFile: dbSup };
      }
    }

    // 3. Buscar archivos <base>.transcripcion.json / .srt directamente en la carpeta
    if (doc) {
      for (const fname of [doc.files?.transcriptionJson, doc.files?.transcriptionSrt].filter(Boolean)) {
        const blob = await readBlobFromFolder(fname);
        if (blob) {
          const cues = deps.parseSubs(await blob.text());
          if (cues.length) {
            const saved = await saveTranscription(docCtx, sourceLang, cues, {
              sttModel: '',
              groupId: groupId || doc.sourceId
            });
            return { cues, record: saved.record, source: 'folder-discovery', supFile: saved.supFile };
          }
        }
      }
    }

    return null;
  }

  async function saveTranscription(docCtx, sourceLang, cues, { sttModel = '', existingDbId = null, groupId = null } = {}) {
    await init(deps);
    const doc = findDocByAny(docCtx) || (docCtx?.docHash ? ensureDoc(docCtx.docHash, docCtx) : null);
    const base = baseNameOf(doc?.fileName || docCtx?.fileName || 'audio');
    const jsonFileName = doc?.files?.transcriptionJson || `${base}.transcripcion.json`;
    const srtFileName = doc?.files?.transcriptionSrt || `${base}.transcripcion.srt`;
    const now = new Date().toISOString();

    const fromTime = cues.length ? Math.max(0, Number(cues[0].start) || 0) : 0;
    const toTime = cues.length ? Math.max(fromTime, Number(cues.at(-1).end) || 0) : 0;
    const wordCount = cues.reduce((sum, c) => sum + (Array.isArray(c.words) ? c.words.length : (String(c.text || '').match(deps.WORD_RE) || []).length), 0);

    const payload = {
      version: 2,
      manifestoCentral: MANIFEST_FILE,
      docHash: doc?.docHash || null,
      archivo: doc?.fileName || '',
      idioma: sourceLang,
      modelo: sttModel,
      desdeTiempo: Math.round(fromTime * 100) / 100,
      hastaTiempo: Math.round(toTime * 100) / 100,
      actualizado: now,
      cues
    };

    const jsonBlob = new Blob([JSON.stringify(payload, null, 1)], { type: 'application/json' });
    const dbId = existingDbId || (doc?.docHash ? `tr:${doc.docHash}:${sourceLang}` : crypto.randomUUID());
    const supFile = {
      id: dbId,
      groupId: groupId || doc?.sourceId || crypto.randomUUID(),
      role: 'supplement',
      name: jsonFileName,
      size: jsonBlob.size,
      kind: 'json',
      blob: jsonBlob,
      docHash: doc?.docHash || null,
      sourceLang,
      sttModel,
      lastOpened: Date.now()
    };
    if (deps.DB) await deps.DB.put(supFile);

    const record = {
      sourceLang,
      sttModel,
      jsonFileName,
      srtFileName,
      dbFileId: dbId,
      fromTime: Math.round(fromTime * 100) / 100,
      toTime: Math.round(toTime * 100) / 100,
      fromPct: 0,
      toPct: 100,
      cueCount: cues.length,
      wordCount,
      complete: true,
      updatedAt: now
    };

    if (doc) {
      doc.transcriptions[sourceLang] = record;
      if (toTime > doc.durationSec) doc.durationSec = toTime;
      await schedulePersist(false);
    }

    await writeFileToFolder(jsonFileName, JSON.stringify(payload, null, 1));
    await writeFileToFolder(srtFileName, cuesToSrt(cues));

    return { record, supFile };
  }

  /* ==================== 4. VOZ ALTA + SUBTÍTULOS (CONSULTA PREVIA ESTRICTA) ==================== */
  const srtTimestamp = s => {
    const ms = Math.round(Math.max(0, Number(s) || 0) * 1000);
    const p = (n, l = 2) => String(n).padStart(l, '0');
    return `${p(Math.floor(ms / 3600000))}:${p(Math.floor((ms % 3600000) / 60000))}:${p(Math.floor((ms % 60000) / 1000))},${p(ms % 1000, 3)}`;
  };
  const cuesToSrt = cues => cues.map((c, i) => `${i + 1}\n${srtTimestamp(c.start)} --> ${srtTimestamp(c.end)}\n${c.text}\n`).join('\n');

  function narKey(lang, voice, fromBlock, toBlock) {
    return `${lang || ''}|${voice || ''}|${fromBlock}|${toBlock}`;
  }

  function wordsMatchLoosely(cues, sourceText) {
    const clean = t => [...String(t || '').matchAll(deps.WORD_RE)].map(m => deps.normKey(m[0])).filter(Boolean);
    const expected = clean(sourceText);
    const saved = clean((cues || []).map(c => c.text || '').join(' '));
    if (!expected.length || !saved.length) return false;
    if (expected.length === saved.length && expected.every((w, i) => w === saved[i])) return true;
    // Tolerancia mínima por división/unión de palabras con guion o apóstrofe al exportar SRT
    return expected.join('') === saved.join('');
  }

  async function hydrateNarrationFromFolder(doc) {
    if (!doc) return 0;
    const mfName = doc.files?.narrationManifest || baseNameOf(doc.fileName) + '.narracion.json';
    const man = await readJsonFromFolder(mfName);
    if (!man || !Array.isArray(man.partes)) return 0;
    let added = 0;
    for (const p of man.partes) {
      if (p.parcial || p.completa === false) continue;
      const fromB = p.bloques?.desde;
      const toB = p.bloques?.hasta;
      if (!Number.isInteger(fromB) || !Number.isInteger(toB)) continue;
      const key = narKey(p.idioma || '', p.voz || '', fromB, toB);
      if (doc.narrations[key]?.complete) continue;
      doc.narrations[key] = {
        key,
        segmentIndex: Number.isInteger(p.segmento) ? p.segmento : Math.max(0, (p.n || 1) - 1),
        fromBlock: fromB,
        toBlock: toB,
        fromPara: p.parrafos?.desde ?? fromB,
        toPara: p.parrafos?.hasta ?? toB,
        fromPct: p.porcentaje?.desde ?? 0,
        toPct: p.porcentaje?.hasta ?? 0,
        textHash: p.textHash || '',
        wordCount: p.palabras || 0,
        lang: p.idioma || '',
        voice: p.voz || '',
        sttModel: p.transcripcion || '',
        alignmentVersion: p.version || 3,
        audioFileName: p.audio,
        subsFileName: p.subtitulos,
        audioDbId: null,
        subsDbId: null,
        durationSec: Number(p.duracion) || 0,
        cues: Array.isArray(p.cues) ? p.cues : null,
        complete: true,
        updatedAt: p.fecha || new Date().toISOString()
      };
      added++;
    }
    if (added) await schedulePersist(false);
    return added;
  }

  async function getNarrationSegment(docCtx, seg, sourceText, { lang, voice, sttModel, alignmentVersion = 3 } = {}) {
    await init(deps);
    const doc = findDocByAny(docCtx);
    const textHash = hashText(sourceText);
    const allFiles = (await deps.DB?.all()) || [];

    if (doc) {
      await hydrateNarrationFromFolder(doc);
      const exactKey = narKey(lang, voice, seg.from, seg.to);
      // Buscar coincidencia exacta por rango+voz+idioma o por textHash+voz+idioma
      const candidates = [
        doc.narrations[exactKey],
        ...Object.values(doc.narrations).filter(n => n.textHash && n.textHash === textHash && n.lang === lang && n.voice === voice)
      ].filter(n => n && n.complete && (!n.alignmentVersion || n.alignmentVersion === alignmentVersion));

      for (const rec of candidates) {
        if (rec.textHash && rec.textHash !== textHash) continue;
        let audioEntry = rec.audioDbId ? allFiles.find(f => f.id === rec.audioDbId && f.blob) : null;
        let subsEntry = rec.subsDbId ? allFiles.find(f => f.id === rec.subsDbId && f.blob) : null;

        // Si no está el blob en IndexedDB, recuperarlo desde la carpeta local
        if (!audioEntry?.blob && rec.audioFileName) {
          const folderAudio = await readBlobFromFolder(rec.audioFileName);
          if (folderAudio) {
            const gid = `narration:central:${doc.docHash}:${seg.from}:${seg.to}:${voice}`;
            audioEntry = {
              id: rec.audioDbId || `${gid}:audio`,
              groupId: gid,
              role: 'main',
              name: rec.audioFileName,
              size: folderAudio.size,
              kind: 'audio',
              blob: folderAudio,
              generatedNarration: true,
              docHash: doc.docHash,
              complete: true,
              alignmentVersion,
              lastOpened: Date.now()
            };
            await deps.DB.put(audioEntry);
            rec.audioDbId = audioEntry.id;
          }
        }
        if (!subsEntry?.blob && rec.subsFileName) {
          const folderSubs = await readBlobFromFolder(rec.subsFileName);
          if (folderSubs) {
            const gid = `narration:central:${doc.docHash}:${seg.from}:${seg.to}:${voice}`;
            subsEntry = {
              id: rec.subsDbId || `${gid}:subs`,
              groupId: gid,
              role: 'supplement',
              name: rec.subsFileName,
              size: folderSubs.size,
              kind: 'subs',
              blob: folderSubs,
              generatedNarration: true,
              forId: audioEntry?.id,
              docHash: doc.docHash,
              complete: true,
              alignmentVersion,
              lastOpened: Date.now()
            };
            await deps.DB.put(subsEntry);
            rec.subsDbId = subsEntry.id;
          }
        }

        if (!audioEntry?.blob) continue;
        let cues = Array.isArray(rec.cues) && rec.cues.length ? rec.cues : null;
        if (!cues && subsEntry?.blob) {
          cues = deps.parseSubs(await subsEntry.blob.text());
        }
        if (!cues?.length || !wordsMatchLoosely(cues, sourceText)) continue;

        const dur = rec.durationSec > 0 ? rec.durationSec : await deps.narBlobDur(audioEntry.blob);
        if (!(dur > 0)) continue;

        rec.durationSec = dur;
        await schedulePersist(false);
        return {
          audioBlob: audioEntry.blob,
          cues,
          durationSec: dur,
          audioFileName: rec.audioFileName,
          subsFileName: rec.subsFileName,
          record: rec,
          source: 'central-memory'
        };
      }
    }

    // Compatibilidad con versiones anteriores (v3.3 - v3.7) guardadas en IndexedDB por sourceId o nombre
    const legacyGroups = [
      doc?.sourceId ? `narration:v${alignmentVersion}:${doc.sourceId}|${seg.from}|${seg.to}|${voice || ''}|${sttModel || ''}|${lang || ''}` : null,
      docCtx?.sourceId ? `narration:v${alignmentVersion}:${docCtx.sourceId}|${seg.from}|${seg.to}|${voice || ''}|${sttModel || ''}|${lang || ''}` : null
    ].filter(Boolean);

    for (const gid of legacyGroups) {
      const a = allFiles.find(x => x.groupId === gid && x.role === 'main' && x.blob && x.complete !== false && !x.partial);
      const s = allFiles.find(x => x.groupId === gid && x.role === 'supplement' && x.blob && x.complete !== false && !x.partial);
      if (!a?.blob || !s?.blob) continue;
      const cues = deps.parseSubs(await s.blob.text());
      if (!cues.length || !wordsMatchLoosely(cues, sourceText)) continue;
      const dur = await deps.narBlobDur(a.blob);
      if (!(dur > 0)) continue;
      // Migrar automáticamente al registro central para futuras consultas instantáneas
      if (doc) {
        await saveNarrationSegment(docCtx, {
          segmentIndex: seg.index ?? 0,
          fromBlock: seg.from,
          toBlock: seg.to,
          sourceText,
          audioBlob: a.blob,
          cues,
          durationSec: dur,
          lang,
          voice,
          sttModel,
          alignmentVersion,
          complete: true,
          existingAudioId: a.id,
          existingSubsId: s.id,
          skipFolderWrite: true
        });
      }
      return {
        audioBlob: a.blob,
        cues,
        durationSec: dur,
        audioFileName: a.name,
        subsFileName: s.name,
        source: 'legacy-migrated'
      };
    }

    return null;
  }

  async function saveNarrationSegment(docCtx, payload) {
    await init(deps);
    const {
      segmentIndex = 0,
      fromBlock,
      toBlock,
      fromPara = fromBlock,
      toPara = toBlock,
      fromPct = 0,
      toPct = 0,
      sourceText = '',
      audioBlob,
      cues = [],
      durationSec = 0,
      lang = '',
      voice = '',
      sttModel = '',
      alignmentVersion = 3,
      complete = true,
      existingAudioId = null,
      existingSubsId = null,
      skipFolderWrite = false
    } = payload;

    const doc = findDocByAny(docCtx) || (docCtx?.docHash ? ensureDoc(docCtx.docHash, docCtx) : null);
    const base = baseNameOf(doc?.fileName || docCtx?.fileName || 'contenido') + '.narracion';
    const stem = `${base}-${String(fromBlock + 1).padStart(3, '0')}`;
    const audioFileName = `${stem}.mp3`;
    const subsFileName = `${stem}.srt`;
    const textHash = hashText(sourceText);
    const wordCount = (String(sourceText || '').match(deps.WORD_RE) || []).length;
    const now = new Date().toISOString();

    const identity = `${doc?.docHash || docCtx?.sourceId || base}|${fromBlock}|${toBlock}|${lang}|${voice}`;
    const groupId = `narration:central:${identity}`;
    const audioId = existingAudioId || `${groupId}:audio`;
    const subsId = existingSubsId || `${groupId}:subs`;

    if (deps.DB && audioBlob) {
      const srtBlob = new Blob([cuesToSrt(cues)], { type: 'text/plain;charset=utf-8' });
      await deps.DB.put({
        id: audioId,
        groupId,
        role: 'main',
        name: audioFileName,
        size: audioBlob.size,
        kind: 'audio',
        blob: audioBlob,
        lastOpened: Date.now(),
        generatedNarration: true,
        docHash: doc?.docHash || null,
        sourceId: doc?.sourceId || docCtx?.sourceId || null,
        complete: !!complete,
        partial: !complete,
        alignmentVersion
      });
      await deps.DB.put({
        id: subsId,
        groupId,
        role: 'supplement',
        name: subsFileName,
        size: srtBlob.size,
        kind: 'subs',
        blob: srtBlob,
        lastOpened: Date.now(),
        generatedNarration: true,
        forId: audioId,
        docHash: doc?.docHash || null,
        complete: !!complete,
        partial: !complete,
        alignmentVersion
      });
    }

    const key = narKey(lang, voice, fromBlock, toBlock);
    const record = {
      key,
      segmentIndex,
      fromBlock,
      toBlock,
      fromPara,
      toPara,
      fromPct,
      toPct,
      textHash,
      wordCount,
      lang,
      voice,
      sttModel,
      alignmentVersion,
      audioFileName,
      subsFileName,
      audioDbId: audioId,
      subsDbId: subsId,
      durationSec: Math.round(durationSec * 100) / 100,
      cues: complete ? cues : null,
      complete: !!complete,
      updatedAt: now
    };

    if (doc) {
      doc.narrations[key] = record;
      await schedulePersist(false);
    }

    let exportedToFolder = false;
    if (!skipFolderWrite && audioBlob) {
      const wroteMp3 = await writeFileToFolder(audioFileName, audioBlob);
      const wroteSrt = await writeFileToFolder(subsFileName, cuesToSrt(cues));
      if (wroteMp3 && wroteSrt) {
        exportedToFolder = true;
        const mfName = base + '.json';
        const prevMan = (await readJsonFromFolder(mfName)) || {
          version: 4,
          manifestoCentral: MANIFEST_FILE,
          docHash: doc?.docHash || null,
          archivo: doc?.fileName || docCtx?.fileName || '',
          partes: []
        };
        const partes = Array.isArray(prevMan.partes) ? prevMan.partes.filter(p => !(p.bloques?.desde === fromBlock && p.bloques?.hasta === toBlock && p.voz === voice && p.idioma === lang)) : [];
        partes.push({
          n: segmentIndex + 1,
          segmento: segmentIndex,
          audio: audioFileName,
          subtitulos: subsFileName,
          bloques: { desde: fromBlock, hasta: complete ? toBlock : null },
          parrafos: { desde: fromPara, hasta: complete ? toPara : null },
          porcentaje: { desde: fromPct, hasta: toPct },
          textHash,
          palabras: wordCount,
          parcial: !complete,
          completa: !!complete,
          version: alignmentVersion,
          inicio: String(sourceText || '').slice(0, 60),
          duracion: Math.round(durationSec * 10) / 10,
          voz: voice,
          transcripcion: sttModel,
          idioma: lang,
          fecha: now
        });
        partes.sort((a, b) => (a.bloques?.desde ?? 0) - (b.bloques?.desde ?? 0));
        prevMan.partes = partes;
        prevMan.actualizado = now;
        await writeFileToFolder(mfName, JSON.stringify(prevMan, null, 2));
      }
    }

    return { record, audioFileName, subsFileName, exportedToFolder };
  }

  async function deleteNarrationSegment(docCtx, seg, { lang, voice } = {}) {
    await init(deps);
    const doc = findDocByAny(docCtx);
    const key = narKey(lang, voice, seg.from, seg.to);
    const rec = doc?.narrations?.[key];
    if (rec && deps.DB) {
      if (rec.audioDbId) await deps.DB.del(rec.audioDbId);
      if (rec.subsDbId) await deps.DB.del(rec.subsDbId);
    }
    if (doc?.narrations?.[key]) {
      delete doc.narrations[key];
      await schedulePersist(true);
    }
  }

  /* ==================== 5. INSPECCIÓN Y EXPORTACIÓN ==================== */
  function inspectAll() {
    return buildExportableManifest();
  }

  function inspectDocument(docCtx) {
    const doc = findDocByAny(docCtx);
    if (!doc) return null;
    const all = buildExportableManifest();
    return all.documentos[doc.docHash] || null;
  }

  return {
    MANIFEST_FILE,
    init,
    hashText,
    fingerprintBlob,
    registerDocument,
    updateDocumentStructure,
    getTranslations,
    saveTranslations,
    getLookup,
    saveLookup,
    getTranscription,
    saveTranscription,
    getNarrationSegment,
    saveNarrationSegment,
    deleteNarrationSegment,
    syncFromFolder: mergeFolderManifest,
    exportManifestToFolder,
    inspectDocument,
    inspectAll
  };
})();
