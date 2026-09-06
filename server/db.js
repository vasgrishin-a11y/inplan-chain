'use strict';
/* ═══════════════════════════════════════════════════════════════════
   Хранилище ревизий модели.

   Никаких зависимостей и никакой СУБД: каждая заливка — отдельный
   JSON-файл в server/data/revisions/. Файлы никогда не перезаписываются
   и не удаляются, поэтому «кто-то залил кривую книгу» перестаёт быть
   катастрофой: предыдущая ревизия лежит рядом и доступна по id.

   Индекс (server/data/index.json) — компактный список метаданных
   ревизий, чтобы отдавать историю не читая все файлы модели.
   ═══════════════════════════════════════════════════════════════════ */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const REV_DIR = path.join(DATA_DIR, 'revisions');
const INDEX_FILE = path.join(DATA_DIR, 'index.json');

const KINDS = ['sku', 'res', 'prodsource', 'tlane'];

function ensureDirs() {
  fs.mkdirSync(REV_DIR, { recursive: true });
}

function readIndex() {
  try {
    const raw = fs.readFileSync(INDEX_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && Array.isArray(parsed.revisions)) return parsed;
  } catch (e) {
    void e; // индекса ещё нет либо он повреждён — начинаем с чистого
  }
  return { lastId: 0, revisions: [] };
}

/* Запись индекса через временный файл: при падении процесса на середине
   записи целым останется старый индекс, а не обрубок нового. */
function writeIndex(index) {
  ensureDirs();
  const tmp = INDEX_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(index, null, 2), 'utf8');
  fs.renameSync(tmp, INDEX_FILE);
}

function revFile(id) {
  return path.join(REV_DIR, String(id) + '.json');
}

const countRows = (model) => KINDS.reduce((sum, k) => sum + (Array.isArray(model[k]) ? model[k].length : 0), 0);

/* Приводим присланное к четырём известным разделам. Всё лишнее
   отбрасывается: сервер не обязан доверять телу запроса. */
function normalizeModel(raw) {
  const model = {};
  KINDS.forEach((k) => {
    model[k] = Array.isArray(raw && raw[k]) ? raw[k] : [];
  });
  return model;
}

/* Создать новую ревизию. Возвращает её метаданные. */
function saveRevision(rawModel, meta) {
  ensureDirs();
  const index = readIndex();
  const id = index.lastId + 1;
  const model = normalizeModel(rawModel);
  const info = {
    id,
    savedAt: Date.now(),
    author: String((meta && meta.author) || 'anonymous').slice(0, 80),
    note: String((meta && meta.note) || '').slice(0, 300),
    counts: KINDS.reduce((acc, k) => { acc[k] = model[k].length; return acc; }, {}),
    rows: countRows(model)
  };

  const tmp = revFile(id) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ ...info, model }), 'utf8');
  fs.renameSync(tmp, revFile(id));

  index.lastId = id;
  index.revisions.push(info);
  writeIndex(index);
  return info;
}

/* Метаданные ревизий, свежие первыми. */
function listRevisions(limit) {
  const index = readIndex();
  const all = index.revisions.slice().sort((a, b) => b.id - a.id);
  return limit ? all.slice(0, limit) : all;
}

function latestId() {
  return readIndex().lastId || null;
}

/* Полная ревизия вместе с моделью. null — если такой нет. */
function getRevision(id) {
  const num = Number(id);
  if (!Number.isInteger(num) || num < 1) return null;
  try {
    return JSON.parse(fs.readFileSync(revFile(num), 'utf8'));
  } catch (e) {
    void e;
    return null;
  }
}

function getLatest() {
  const id = latestId();
  return id ? getRevision(id) : null;
}

module.exports = { KINDS, saveRevision, listRevisions, getRevision, getLatest, latestId, normalizeModel, DATA_DIR };
