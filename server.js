// Local dev server for Relic Run.
//   node server.js
// Serves the game over HTTP (for this computer) and HTTPS (for phones on the
// same Wi-Fi). Phones only expose the gyroscope / motion sensors to pages
// served over HTTPS, so open the https:// address on your phone and accept
// the self-signed certificate warning once.
const http = require('http');
const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = __dirname;
const HTTP_PORT = Number(process.env.PORT || 8080);
const HTTPS_PORT = Number(process.env.HTTPS_PORT || 8443);
const CERT_DIR = path.join(ROOT, '.cert');

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};

function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) out.push(a.address);
  }
  return out;
}

function ensureCert(ips) {
  const key = path.join(CERT_DIR, 'key.pem'), cert = path.join(CERT_DIR, 'cert.pem');
  if (fs.existsSync(key) && fs.existsSync(cert)) return { key: fs.readFileSync(key), cert: fs.readFileSync(cert) };
  fs.mkdirSync(CERT_DIR, { recursive: true });
  const base = ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '825', '-subj', '/CN=relic-run.local'];
  const san = ['DNS:localhost', 'IP:127.0.0.1', ...ips.map((ip) => `IP:${ip}`)].join(',');
  try {
    execFileSync('openssl', [...base, '-addext', `subjectAltName=${san}`], { stdio: 'ignore' });
  } catch {
    execFileSync('openssl', base, { stdio: 'ignore' });
  }
  return { key: fs.readFileSync(key), cert: fs.readFileSync(cert) };
}

function handler(req, res) {
  let urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  if (urlPath.endsWith('/')) urlPath += 'index.html';
  const file = path.normalize(path.join(ROOT, urlPath));
  if (!file.startsWith(ROOT) || file.includes(`${path.sep}.cert`)) { res.writeHead(403); res.end('Forbidden'); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

const ips = lanAddresses();
http.createServer(handler).listen(HTTP_PORT, () => {
  console.log(`\n  Relic Run is running\n`);
  console.log(`  On this computer:   http://localhost:${HTTP_PORT}`);
});
try {
  const creds = ensureCert(ips);
  https.createServer(creds, handler).listen(HTTPS_PORT, () => {
    for (const ip of ips) console.log(`  On your phone:      https://${ip}:${HTTPS_PORT}   (accept the certificate warning)`);
    if (!ips.length) console.log(`  HTTPS:              https://localhost:${HTTPS_PORT}`);
    console.log('');
  });
} catch (err) {
  console.warn('  Could not create an HTTPS certificate (is openssl installed?). Phone motion sensors need HTTPS.', err.message);
}
