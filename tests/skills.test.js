const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseFrontmatter } = require('../scripts/lib/validate');

const SKILLS = ['record-contract', 'gap-check', 'spine'];

for (const name of SKILLS) {
  test(`${name} skill has name and description frontmatter`, () => {
    const file = path.join(__dirname, '..', 'skills', name, 'SKILL.md');
    assert.ok(fs.existsSync(file), `${file} missing`);
    const fm = parseFrontmatter(fs.readFileSync(file, 'utf8'));
    assert.equal(fm.name, name);
    assert.ok(fm.description.length > 40);
  });
}

test('gap-check lists the seven absence questions', () => {
  const text = fs.readFileSync(path.join(__dirname, '..', 'skills', 'gap-check', 'SKILL.md'), 'utf8');
  for (const needle of ['Acceptance criteria', 'Error paths', 'migration', 'Non-functional', 'Test anchors', 'Out of scope', 'User impact']) {
    assert.match(text, new RegExp(needle));
  }
});

test('spine skill defines the Workflow-tool fallback', () => {
  const text = fs.readFileSync(path.join(__dirname, '..', 'skills', 'spine', 'SKILL.md'), 'utf8');
  assert.match(text, /^### When the Workflow tool is unavailable$/m);
  assert.match(text, /workflow tool unavailable, ran inline/);
  assert.match(text, /size S path/);
});

test('spine skill calls workflows by registered name, never by a <root> scriptPath', () => {
  const text = fs.readFileSync(path.join(__dirname, '..', 'skills', 'spine', 'SKILL.md'), 'utf8');
  assert.doesNotMatch(text, /scriptPath:\s*"<root>/);
  for (const stage of ['spec', 'implement', 'review']) {
    const script = fs.readFileSync(path.join(__dirname, '..', 'workflows', `${stage}.workflow.js`), 'utf8');
    const metaName = script.match(/name:\s*'([^']+)'/)[1];
    assert.equal(metaName, `spine-internal-${stage}`);
    assert.ok(text.includes(`name: "spine:${metaName}"`), `SKILL.md must call spine:${metaName} by name`);
  }
});

test('both gap-check skills list seven questions and name User impact', () => {
  for (const dir of ['skills', 'cursor/skills']) {
    const text = fs.readFileSync(path.join(__dirname, '..', dir, 'gap-check', 'SKILL.md'), 'utf8');
    assert.match(text, /^## The seven absence questions$/m);
    assert.match(text, /^7\. \*\*User impact\.\*\*/m);
    assert.doesNotMatch(text, /six/);
  }
});

const SPINE_SKILLS = ['skills/spine/SKILL.md', 'cursor/skills/spine/SKILL.md'];
const readSkill = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8').replace(/\r\n/g, '\n');

test('both spine skills name the product entry point, bootstrap call, --decide call, ux_finder skip claim and both agent files (T-13)', () => {
  for (const rel of SPINE_SKILLS) {
    const t = readSkill(rel);
    assert.match(t, /^- `product`/m, `${rel} entry point`);
    assert.ok(t.includes('scripts/product-context.js --run <run> --files'), `${rel} bootstrap call`);
    assert.ok(t.includes('scripts/product-context.js --run <run> --decide --record <R-id> --answer'), `${rel} decide call`);
    assert.ok(t.includes('ux_finder skipped: no user-facing or key-flow file'), `${rel} skip claim`);
    assert.ok(t.includes('agents/product-lens.md'), `${rel} product-lens agent`);
    assert.ok(t.includes('agents/ux-finder.md'), `${rel} ux-finder agent`);
    assert.ok(t.includes('(unconfirmed, from <file>)'), `${rel} unconfirmed marker`);
    assert.ok(t.includes('.spine/decisions.md merge=union'), `${rel} gitattributes hint`);
    assert.ok(t.includes('cap_line'), `${rel} DONE cap line`);
    assert.ok(t.includes('click through'), `${rel} STATE suffix`);
  }
});

test('both spine skills dispatch product-lens with --model-role product_lens and ux-find with ux_finder (T-13)', () => {
  for (const rel of SPINE_SKILLS) {
    const t = readSkill(rel);
    assert.match(t, /--model-role product_lens/, rel);
    assert.match(t, /--model-role ux_finder/, rel);
    assert.match(t, /productText/, rel);
    assert.match(t, /uxFinder: true/, rel);
    assert.match(t, /spine:product-lens/, rel);
    assert.match(t, /spine:ux-finder/, rel);
  }
});

test('both spine skills write the ux_finder skip INFO only when product context loaded (T-15a)', () => {
  for (const rel of SPINE_SKILLS) {
    const t = readSkill(rel).replace(/\s+/g, ' ');
    assert.ok(t.includes('only when `<run>/product.json` `state` is `ok` or `trimmed`, write one `INFO`'), `${rel} skip condition`);
    assert.ok(t.includes('write no skip record'), `${rel} absent case`);
  }
});

test('both spine skills pass productSections, productPath and repoDocs from product.json to the workflows (R-0129)', () => {
  for (const rel of SPINE_SKILLS) {
    const text = readSkill(rel).replace(/\s+/g, ' ');
    for (const needle of ['`productSections` (`product.json` `sections`)', '`productPath`', '`repoDocs` (`product.json` `repo_docs`)', 'never re-parse the product text']) {
      assert.ok(text.includes(needle), rel + ' ' + needle);
    }
  }
});

test('T-15c: both spine skills pass flowsTouched and repoDocsTruncated from product.json to the workflows (R-0221, R-0227)', () => {
  for (const rel of SPINE_SKILLS) {
    const text = readSkill(rel).replace(/\s+/g, ' ');
    for (const needle of ['`flowsTouched` (`product.json` `flows_touched`)', '`repoDocsTruncated` (`product.json` `repo_docs_truncated`)']) {
      assert.ok(text.includes(needle), rel + ' ' + needle);
    }
  }
});
