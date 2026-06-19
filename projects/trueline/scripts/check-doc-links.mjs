#!/usr/bin/env node
// Verify every in-file Markdown anchor link in the trueline docs resolves to a real
// heading, using GitHub's heading-slug rules. Exits non-zero if any anchor is broken.
// Run with: node scripts/check-doc-links.mjs  (or `npm run check:docs`).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const files = [
  "README.md",
  "docs/OVERVIEW.md",
  "docs/ARCHITECTURE.md",
  "docs/API.md",
  "docs/WALKTHROUGH.md",
  "docs/DEPLOYMENT.md",
  "docs/spec/spec.md",
  "docs/spec/development-plan.md",
];

const slug = (s) =>
  s.trim().toLowerCase().replace(/[^\w\s-]/g, "").replace(/\s/g, "-");

let broken = 0;
for (const rel of files) {
  let text;
  try {
    text = readFileSync(join(root, rel), "utf8");
  } catch {
    continue; // file may not exist in every checkout
  }
  // collect heading anchors (with GitHub's -1/-2 disambiguation for duplicates)
  const anchors = new Set();
  const seen = Object.create(null);
  for (const line of text.split("\n")) {
    const m = line.match(/^#{1,6}\s+(.*)/);
    if (!m) continue;
    const base = slug(m[1]);
    const a = base in seen ? `${base}-${++seen[base]}` : ((seen[base] = 0), base);
    anchors.add(a);
  }
  // check every in-file anchor link  ](#...)
  for (const m of text.matchAll(/\]\((#[^)]+)\)/g)) {
    const target = m[1].slice(1);
    if (!anchors.has(target)) {
      console.error(`BROKEN  ${rel}  ->  ${m[1]}`);
      broken++;
    }
  }
}

if (broken) {
  console.error(`\n${broken} broken doc anchor(s).`);
  process.exit(1);
}
console.log("All trueline doc anchors resolve.");
