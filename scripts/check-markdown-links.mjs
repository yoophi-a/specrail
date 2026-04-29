#!/usr/bin/env node
import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ignoredDirs = new Set(['.git', 'node_modules', 'dist', 'coverage', '.specrail-data']);
const markdownFiles = [];

function walk(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (ignoredDirs.has(entry.name)) continue;
      walk(resolve(directory, entry.name));
      continue;
    }

    if (entry.isFile() && entry.name.endsWith('.md')) {
      markdownFiles.push(resolve(directory, entry.name));
    }
  }
}

function isExternalLink(target) {
  return /^(?:https?:|mailto:|tel:|#)/i.test(target);
}

function stripFragmentAndQuery(target) {
  return target.split('#', 1)[0].split('?', 1)[0];
}

function decodeTarget(target) {
  try {
    return decodeURIComponent(target);
  } catch {
    return target;
  }
}

walk(root);

const markdownLinkPattern = /(?<!!)(?:\[[^\]\n]*(?:\][^\[\]\n]*)*\]|\[[^\]\n]*\])\((?<target>[^)\s]+)(?:\s+"[^"]*")?\)/g;
const missing = [];

for (const file of markdownFiles) {
  const text = await import('node:fs').then(({ readFileSync }) => readFileSync(file, 'utf8'));
  for (const match of text.matchAll(markdownLinkPattern)) {
    const rawTarget = match.groups?.target;
    if (!rawTarget || isExternalLink(rawTarget)) continue;

    const target = decodeTarget(stripFragmentAndQuery(rawTarget));
    if (!target) continue;

    const resolvedTarget = resolve(dirname(file), target);
    if (!existsSync(resolvedTarget)) {
      missing.push({ file, target: rawTarget });
    }
  }
}

if (missing.length > 0) {
  console.error('Missing local Markdown link targets:');
  for (const item of missing) {
    console.error(`- ${item.file.slice(root.length + 1)} -> ${item.target}`);
  }
  process.exit(1);
}

console.log(`Checked ${markdownFiles.length} Markdown files; local links ok.`);
