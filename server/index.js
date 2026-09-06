'use strict';
/* ═══════════════════════════════════════════════════════════════════
   In.Plan · сервер синхронизации модели (прототип).

   Только стандартная библиотека Node.js: ни зависимостей, ни сборки,
   ни package.json. `node server/index.js` — и всё работает.

   Сервер опционален: дашборд без него живёт на localStorage.
   Подробности API — в server/README.md.
   ═══════════════════════════════════════════════════════════════════ */

const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const db = require('./db');

const PORT = Number(process.env.PORT) || 8137;
const HOST = process.env.HOST || '0.0.0.0';
const MAX_BODY = 32 * 1024 * 1024; // 32 МБ: книга на десятки тысяч строк влезает
const ROOT = path.join(__dirname, '..');

function sendJson(res, code, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*'
  });
  res.end(body);
}

/* Чтение тела с жёстким лимитом: без него один большой POST
   способен съесть память процесса. */
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('тело запроса больше ' + Math.round(MAX_BODY / 1048576) + ' МБ'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const STATIC_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.md': 'text/markdown; charset=utf-8'
};

/* Раздача дашборда с того же порта — чтобы не ловить CORS и не держать
   второй сервер. Путь нормализуется и проверяется на выход за корень. */
function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  const file = path.resolve(ROOT, rel);
  if (file !== ROOT && !file.startsWith(ROOT + path.sep)) {
    sendJson(res, 403, { ok: false, error: 'доступ запрещён' });
    return;
  }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) {
      sendJson(res, 404, { ok: false, error: 'не найдено: ' + pathname });
      return;
    }
    res.writeHead(200, {
      'Content-Type': STATIC_TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': 'no-cache'
    });
    fs.createReadStream(file).pipe(res);
  });
}

async function handleApi(req, res, pathname, query) {
  if (pathname === '/api/health' && req.method === 'GET') {
    sendJson(res, 200, { ok: true, service: 'inplan-sync', latest: db.latestId(), revisions: db.listRevisions().length });
    return;
  }

  if (pathname === '/api/revisions' && req.method === 'GET') {
    const limit = Number(query.limit) > 0 ? Number(query.limit) : 0;
    sendJson(res, 200, { ok: true, revisions: db.listRevisions(limit) });
    return;
  }

  if (pathname === '/api/model' && req.method === 'GET') {
    // Без id — последняя ревизия; с id — конкретная, включая давно перекрытые.
    const rev = query.id ? db.getRevision(query.id) : db.getLatest();
    if (!rev) {
      sendJson(res, 404, { ok: false, error: query.id ? 'ревизия ' + query.id + ' не найдена' : 'на сервере ещё нет ни одной ревизии' });
      return;
    }
    sendJson(res, 200, { ok: true, revision: { id: rev.id, savedAt: rev.savedAt, author: rev.author, note: rev.note, counts: rev.counts, rows: rev.rows }, model: rev.model });
    return;
  }

  if (pathname === '/api/model' && req.method === 'POST') {
    let payload;
    try {
      payload = JSON.parse(await readBody(req) || '{}');
    } catch (e) {
      sendJson(res, 400, { ok: false, error: 'некорректный JSON: ' + e.message });
      return;
    }
    const raw = payload && payload.model ? payload.model : payload;
    if (!raw || typeof raw !== 'object') {
      sendJson(res, 400, { ok: false, error: 'ожидается объект модели с разделами ' + db.KINDS.join(', ') });
      return;
    }
    const model = db.normalizeModel(raw);
    if (!db.KINDS.some((k) => model[k].length)) {
      sendJson(res, 400, { ok: false, error: 'модель пуста — сохранять нечего' });
      return;
    }
    try {
      const info = db.saveRevision(model, { author: payload.author, note: payload.note });
      console.log('[' + new Date().toISOString() + '] ревизия ' + info.id + ' · ' + info.rows + ' строк · ' + info.author);
      sendJson(res, 201, { ok: true, revision: info });
    } catch (e) {
      sendJson(res, 500, { ok: false, error: 'не удалось сохранить: ' + e.message });
    }
    return;
  }

  sendJson(res, 404, { ok: false, error: 'неизвестный метод API: ' + req.method + ' ' + pathname });
}

const server = http.createServer((req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname || '/';

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400'
    });
    res.end();
    return;
  }

  if (pathname.startsWith('/api/')) {
    handleApi(req, res, pathname, parsed.query).catch((e) => sendJson(res, 500, { ok: false, error: String(e && e.message || e) }));
    return;
  }

  if (req.method === 'GET' || req.method === 'HEAD') {
    serveStatic(req, res, pathname);
    return;
  }

  sendJson(res, 405, { ok: false, error: 'метод не поддерживается' });
});

server.listen(PORT, HOST, () => {
  console.log('In.Plan sync server → http://localhost:' + PORT);
  console.log('Данные: ' + db.DATA_DIR + ' · ревизий сейчас: ' + db.listRevisions().length);
});
