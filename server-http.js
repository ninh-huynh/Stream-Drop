const http = require('http');
const fs = require('fs');
const path = require('path');
const pino = require('pino');

const UPLOAD_DIR = path.join(__dirname, 'upload');
const MAX_UPLOAD_SIZE = 200 * 1024 * 1024; // 200MB limit

if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

const logger = pino({
  transport: {
    target: 'pino-pretty',
    options: {
      colorize: true,
      translateTime: 'SYS:standard',
      ignore: 'pid,hostname'
    }
  }
});

function generateFileName() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `received_${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}.mp4`;
}

function parseRange(range, fileSize) {
  if (!range) return null;

  const parts = range.replace(/bytes=/, '').split('-');
  const start = parseInt(parts[0], 10);
  const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;

  return { start, end, isValid: start < fileSize && end < fileSize && start <= end };
}

function sanitizeFileName(fileName) {
  const sanitized = fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
  return sanitized.length > 100 ? sanitized.substring(0, 100) : sanitized;
}

function handleGetRequest(req, res) {
  const fileName = sanitizeFileName(req.url.replace('/upload/', ''));
  const filePath = path.join(UPLOAD_DIR, fileName);

  logger.info({ fileName }, 'GET request received');

  if (!fs.existsSync(filePath)) {
    logger.warn({ filePath }, 'File not found');
    res.writeHead(404, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'FILE_NOT_FOUND', message: 'File not found' }));
  }

  const stat = fs.statSync(filePath);
  const fileSize = stat.size;
  const rangeHeader = req.headers.range;
  const range = parseRange(rangeHeader, fileSize);

  logger.info({ filePath, fileSize, range: rangeHeader ?? 'none' }, 'Streaming file');

  if (range) {
    if (!range.isValid) {
      logger.warn({ range: rangeHeader }, 'Invalid range request');
      res.writeHead(416, { 'Content-Range': `bytes */${fileSize}` });
      return res.end();
    }

    const chunkSize = range.end - range.start + 1;

    res.writeHead(206, {
      'Content-Type': 'video/mp4',
      'Content-Length': chunkSize,
      'Content-Range': `bytes ${range.start}-${range.end}/${fileSize}`,
      'Accept-Ranges': 'bytes'
    });

    logger.info({ start: range.start, end: range.end, size: chunkSize }, 'Sending partial content');

    fs.createReadStream(filePath, { start: range.start, end: range.end }).pipe(res);
  } else {
    res.writeHead(200, {
      'Content-Type': 'video/mp4',
      'Content-Length': fileSize,
      'Accept-Ranges': 'bytes'
    });

    logger.info({ size: fileSize }, 'Sending full content');

    fs.createReadStream(filePath).pipe(res);
  }
}

function handlePostRequest(req, res) {
  logger.info('Upload request received');

  const fileName = generateFileName();
  const filePath = path.join(UPLOAD_DIR, fileName);
  const writeStream = fs.createWriteStream(filePath);

  let bytesReceived = 0;
  let isFirstChunk = true;
  let firstChunkTime = null;

  req.on('data', (chunk) => {
    bytesReceived += chunk.length;

    if (bytesReceived > MAX_UPLOAD_SIZE) {
      logger.error({ maxSize: MAX_UPLOAD_SIZE }, 'Upload size exceeded limit');
      req.destroy();
      writeStream.destroy();
      res.writeHead(413, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'FILE_TOO_LARGE', message: 'File exceeds maximum size' }));
    }

    if (isFirstChunk) {
      isFirstChunk = false;
      firstChunkTime = Date.now();
      logger.info({ size: chunk.length }, 'First chunk received');
    }

    writeStream.write(chunk);
  });

  req.on('end', () => {
    writeStream.end();

    const host = req.headers.host || `localhost:${PORT}`;
    const protocol = req.socket.encrypted ? 'https' : 'http';

    const filePath = `${protocol}://${host}/upload/${fileName}`

    if (firstChunkTime) {
      const durationMs = Date.now() - firstChunkTime;
      const durationSec = (durationMs / 1000).toFixed(3);
      logger.info({ fileName, durationSec, bytesReceived, filePath }, 'Upload completed');
    } else {
      logger.warn('Upload completed but no data received');
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: true,
      fileName,
      filePath: filePath
    }));
  });

  req.on('error', (err) => {
    logger.error({ error: err.message }, 'Request error');
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'REQUEST_ERROR', message: err.message }));
  });

  writeStream.on('error', (err) => {
    logger.error({ error: err.message }, 'Write stream error');
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'WRITE_ERROR', message: err.message }));
    }
  });
}

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url.startsWith('/upload/')) {
    handleGetRequest(req, res);
  } else if (req.method === 'POST' && req.url === '/upload') {
    handlePostRequest(req, res);
  } else {
    logger.warn({ method: req.method, url: req.url }, 'Unknown request');
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  }
});

const PORT = 3000;
server.listen(PORT, '0.0.0.0', () => {
  logger.info({ host: '0.0.0.0', port: PORT, uploadEndpoint: `http://localhost:${PORT}/upload` }, 'Server started');
});
