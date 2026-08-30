/**
 * System health snapshot for the admin dashboard.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { getSetting } = require('../db');

const STARTED_AT = Date.now();
const dataDir = path.join(__dirname, '..', '..', 'data');
const dbPath = path.join(dataDir, 'firmledger.db');

function fmtBytes(n) {
  const x = Number(n) || 0;
  if (x < 1024) return x + ' B';
  if (x < 1048576) return (x / 1024).toFixed(1) + ' KB';
  if (x < 1073741824) return (x / 1048576).toFixed(1) + ' MB';
  return (x / 1073741824).toFixed(2) + ' GB';
}

function dirSize(root) {
  let total = 0;
  function walk(d) {
    let ents;
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const fp = path.join(d, e.name);
      try {
        if (e.isDirectory()) walk(fp);
        else total += fs.statSync(fp).size;
      } catch { /* skip unreadable */ }
    }
  }
  walk(root);
  return total;
}

function fmtUptime(sec) {
  sec = Math.max(0, Math.floor(sec));
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d) return `${d}d ${h}h ${m}m`;
  if (h) return `${h}h ${m}m`;
  return `${m}m ${sec % 60}s`;
}

function diskOf(p) {
  try {
    if (typeof fs.statfsSync === 'function') {
      const s = fs.statfsSync(p);
      const bsize = s.bsize || s.frsize || 4096;
      return { total: s.blocks * bsize, free: (s.bavail || s.bfree) * bsize };
    }
  } catch { /* fall through */ }
  try {
    const { execSync } = require('child_process');
    const line = execSync(`df -k "${p}"`, { encoding: 'utf8' }).trim().split('\n')[1] || '';
    const parts = line.split(/\s+/);
    const total = Number(parts[1]) * 1024;
    const free = Number(parts[3]) * 1024;
    if (total) return { total, free };
  } catch { /* ignore */ }
  return { total: 0, free: 0 };
}

function snapshot() {
  let dbSize = 0;
  try { dbSize = fs.statSync(dbPath).size; } catch { /* missing */ }
  const dataBytes = dirSize(dataDir);
  const disk = diskOf(dataDir);
  const mem = process.memoryUsage();
  const usedPct = disk.total ? Math.round(((disk.total - disk.free) / disk.total) * 100) : 0;
  const lastBackup = getSetting('last_backup_at', '');
  const mailer = require('./mailer');
  return {
    node: process.version,
    platform: `${os.type()} ${os.release()} (${os.arch()})`,
    hostname: os.hostname(),
    pid: process.pid,
    startedAt: new Date(STARTED_AT).toISOString(),
    uptimeSec: process.uptime(),
    uptime: fmtUptime(process.uptime()),
    hostUptime: fmtUptime(os.uptime()),
    memory: {
      rss: mem.rss, heapUsed: mem.heapUsed, heapTotal: mem.heapTotal, external: mem.external,
      rssLabel: fmtBytes(mem.rss), heapLabel: fmtBytes(mem.heapUsed) + ' / ' + fmtBytes(mem.heapTotal),
      systemTotal: os.totalmem(), systemFree: os.freemem(),
      systemLabel: fmtBytes(os.totalmem() - os.freemem()) + ' / ' + fmtBytes(os.totalmem()),
    },
    db: { path: dbPath, bytes: dbSize, label: fmtBytes(dbSize) },
    data: { path: dataDir, bytes: dataBytes, label: fmtBytes(dataBytes) },
    disk: {
      total: disk.total, free: disk.free, usedPct,
      totalLabel: fmtBytes(disk.total), freeLabel: fmtBytes(disk.free),
    },
    lastBackup,
    lastBackupAgo: lastBackup ? fmtUptime((Date.now() - Date.parse(lastBackup)) / 1000) : '',
    mail: mailer.accountStatus ? mailer.accountStatus() : { configured: mailer.mailConfigured() },
  };
}

module.exports = { snapshot, fmtBytes, STARTED_AT };
