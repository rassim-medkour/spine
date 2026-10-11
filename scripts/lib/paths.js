'use strict';
const fs = require('node:fs');
const path = require('node:path');

// Resolves symlinks on both sides; returns null unless target lies strictly inside dir.
function realPathInside(dir, target) {
  let realDir;
  let realFile;
  try {
    realDir = fs.realpathSync(dir);
    realFile = fs.realpathSync(target);
  } catch {
    return null;
  }
  const rel = path.relative(realDir, realFile);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return { abs: realFile, rel };
}

module.exports = { realPathInside };
