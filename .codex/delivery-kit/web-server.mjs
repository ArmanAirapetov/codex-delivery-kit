#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  cleanupRun,
  getReviewInbox,
  getRun,
  listRuns,
  readRunEvents,
  resolveWebRepo,
  resumeRun,
  saveReview,
  stopRun,
} from './lib/web-service.mjs';

const KIT_DIR = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = path.join(KIT_DIR, 'web');
const DIST_ROOT = path.join(WEB_ROOT, 'dist');
const MAX_BODY_BYTES = 512 * 1024;

function parseArgs(argv) {
  const options = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) {
      options._.push(token);
      continue;
    }
    const [rawKey, inlineValue] = token.slice(2).split('=', 2);
    const key = rawKey.replace(/-([a-z])/g, (_, char) => char.toUpperCase());
    if (inlineValue !== undefined) options[key] = inlineValue;
    else if (['dev', 'help', 'h'].includes(key)) options[key] = true;
    else if (argv[index + 1] && !argv[index + 1].startsWith('--')) options[key] = argv[++index];
    else options[key] = true;
  }
  return options;
}

function createToken() {
  return randomBytes(24).toString('base64url');
}

function tokenFromRequest(req, url) {
  const authorization = req.headers.authorization ?? '';
  if (authorization.startsWith('Bearer ')) return authorization.slice('Bearer '.length).trim();
  return url.searchParams.get('token') ?? '';
}

function assertAuthorized(req, url, token) {
  if (tokenFromRequest(req, url) !== token) {
    const error = new Error('Unauthorized');
    error.statusCode = 401;
    throw error;
  }
}

function sendJson(res, statusCode, payload) {
  const body = `${JSON.stringify(payload, null, 2)}\n`;
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(body);
}

function sendError(res, error) {
  const statusCode = Number(error?.statusCode ?? error?.status ?? 500);
  sendJson(res, statusCode >= 400 && statusCode < 600 ? statusCode : 500, {
    error: statusCode >= 500 ? 'Internal server error' : error?.message ?? 'Request failed',
    detail: statusCode >= 500 ? error?.message ?? String(error) : undefined,
  });
}

async function readJsonBody(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      const error = new Error('Request body is too large.');
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    const error = new Error('Request body must be valid JSON.');
    error.statusCode = 400;
    throw error;
  }
}

function routeRun(pathname) {
  const match = pathname.match(/^\/api\/runs\/([^/]+)(?:\/([^/]+))?$/);
  if (!match) return null;
  return {
    runId: decodeURIComponent(match[1]),
    action: match[2] ?? null,
  };
}

async function handleApi(req, res, url, { repo, token }) {
  assertAuthorized(req, url, token);
  const method = req.method ?? 'GET';
  if (method === 'GET' && url.pathname === '/api/health') {
    sendJson(res, 200, { ok: true, repo, at: new Date().toISOString() });
    return;
  }
  if (method === 'GET' && url.pathname === '/api/runs') {
    sendJson(res, 200, await listRuns(repo, { limit: url.searchParams.get('limit') ?? 50 }));
    return;
  }
  const runRoute = routeRun(url.pathname);
  if (!runRoute) {
    const error = new Error('Not found');
    error.statusCode = 404;
    throw error;
  }

  const tail = url.searchParams.has('tail') ? Number(url.searchParams.get('tail')) : undefined;
  if (method === 'GET' && runRoute.action === null) {
    sendJson(res, 200, await getRun(repo, runRoute.runId, { eventTail: tail ?? 300 }));
    return;
  }
  if (method === 'GET' && runRoute.action === 'events') {
    sendJson(res, 200, { runId: runRoute.runId, events: await readRunEvents(repo, runRoute.runId, { tail: tail ?? 300 }) });
    return;
  }
  if (method === 'GET' && runRoute.action === 'review-inbox') {
    sendJson(res, 200, await getReviewInbox(repo, runRoute.runId));
    return;
  }
  if (method === 'GET' && runRoute.action === 'stream') {
    await handleRunStream(req, res, repo, runRoute.runId, { tail: tail ?? 80 });
    return;
  }
  if (method === 'POST' && runRoute.action === 'review') {
    sendJson(res, 200, await saveReview(repo, runRoute.runId, await readJsonBody(req)));
    return;
  }
  if (method === 'POST' && runRoute.action === 'resume') {
    sendJson(res, 200, await resumeRun(repo, runRoute.runId, await readJsonBody(req)));
    return;
  }
  if (method === 'POST' && runRoute.action === 'stop') {
    sendJson(res, 200, await stopRun(repo, runRoute.runId));
    return;
  }
  if (method === 'POST' && runRoute.action === 'cleanup') {
    sendJson(res, 200, await cleanupRun(repo, runRoute.runId, await readJsonBody(req)));
    return;
  }

  const error = new Error('Not found');
  error.statusCode = 404;
  throw error;
}

async function handleRunStream(req, res, repo, runId, { tail }) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
    'x-content-type-options': 'nosniff',
  });
  let closed = false;
  req.on('close', () => {
    closed = true;
  });
  const send = (event, payload) => {
    if (closed) return;
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };
  const tick = async () => {
    try {
      const run = await getRun(repo, runId, { eventTail: tail, includeInbox: true });
      send('snapshot', run);
    } catch (error) {
      send('error', { error: error?.message ?? String(error) });
    }
  };
  await tick();
  const timer = setInterval(tick, 1000);
  req.on('close', () => clearInterval(timer));
}

const CONTENT_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

async function serveStatic(req, res, url) {
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === '/') pathname = '/index.html';
  const candidate = path.resolve(DIST_ROOT, `.${pathname}`);
  if (!candidate.startsWith(DIST_ROOT)) {
    const error = new Error('Forbidden');
    error.statusCode = 403;
    throw error;
  }
  const file = await stat(candidate).catch(() => null);
  const target = file?.isFile() ? candidate : path.join(DIST_ROOT, 'index.html');
  await access(target);
  const ext = path.extname(target);
  res.writeHead(200, {
    'content-type': CONTENT_TYPES[ext] ?? 'application/octet-stream',
    'cache-control': target.endsWith('index.html') ? 'no-store' : 'public, max-age=31536000, immutable',
    'x-content-type-options': 'nosniff',
  });
  createReadStream(target).pipe(res);
}

export async function createWebServer({
  repo,
  token = createToken(),
  dev = false,
} = {}) {
  const resolvedRepo = await resolveWebRepo(repo ?? process.cwd());
  let vite = null;
  if (dev) {
    const { createServer } = await import('vite');
    vite = await createServer({
      root: WEB_ROOT,
      appType: 'spa',
      server: { middlewareMode: true },
    });
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    try {
      if (url.pathname.startsWith('/api/')) {
        await handleApi(req, res, url, { repo: resolvedRepo, token });
        return;
      }
      if (vite) {
        vite.middlewares(req, res, (error) => {
          if (error) sendError(res, error);
          else sendError(res, Object.assign(new Error('Not found'), { statusCode: 404 }));
        });
        return;
      }
      await serveStatic(req, res, url);
    } catch (error) {
      sendError(res, error);
    }
  });
  server.on('close', () => {
    void vite?.close();
  });
  return { server, repo: resolvedRepo, token };
}

export async function startWebUi(options = {}) {
  if (options.help || options.h) {
    process.stdout.write('Usage: node .codex/delivery-kit/web-server.mjs [--repo <path>] [--host 127.0.0.1] [--port 0] [--dev]\n');
    return null;
  }
  const host = String(options.host ?? '127.0.0.1');
  const port = Number(options.port ?? 0);
  const token = typeof options.token === 'string' ? options.token : createToken();
  const { server, repo } = await createWebServer({ repo: options.repo, token, dev: Boolean(options.dev) });
  await new Promise((resolve) => server.listen(port, host, resolve));
  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : port;
  const url = `http://${host}:${actualPort}/?token=${encodeURIComponent(token)}`;
  process.stdout.write(`[codex-delivery] Web UI serving ${repo}\n`);
  process.stdout.write(`[codex-delivery] ${url}\n`);
  return { server, repo, token, url };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startWebUi(parseArgs(process.argv.slice(2))).catch((error) => {
    process.stderr.write(`[codex-delivery-web] ${error?.stack ?? error?.message ?? String(error)}\n`);
    process.exitCode = 1;
  });
}
