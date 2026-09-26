const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { findVerifySkills } = require('../scripts/find-verify');

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'spine-verify-'));
}

function writeSkill(root, relDir, { name = 'verify', features = [] } = {}) {
  const dir = path.join(root, relDir, '.claude', 'skills', 'verify');
  fs.mkdirSync(path.join(dir, 'features'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: test\n---\n# Verify\n`);
  fs.writeFileSync(path.join(dir, 'features', 'README.md'), '# index\n');
  for (const f of features) fs.writeFileSync(path.join(dir, 'features', `${f}.md`), `# ${f}\n`);
}

test('returns no skills when the repo has no verify skill', () => {
  const root = tmp();
  assert.deepEqual(findVerifySkills(['src/a.py'], root), []);
});

test('a root verify skill covers every changed file', () => {
  const root = tmp();
  writeSkill(root, '.', { features: ['login'] });
  const skills = findVerifySkills(['src/a.py', 'docs/b.md'], root);
  assert.equal(skills.length, 1);
  assert.equal(skills[0].skillDir, '.claude/skills/verify');
  assert.deepEqual(skills[0].covers, ['src/a.py', 'docs/b.md']);
  assert.deepEqual(skills[0].features, ['login']);
});

test('the nearest skill wins and files are grouped per skill', () => {
  const root = tmp();
  writeSkill(root, '.');
  writeSkill(root, 'services/intake', { features: ['patient-form', 'sign-in'] });
  const skills = findVerifySkills(['services/intake/backend/app.py', 'services/main/x.py'], root);
  const byDir = Object.fromEntries(skills.map((s) => [s.skillDir, s]));
  assert.deepEqual(byDir['services/intake/.claude/skills/verify'].covers, ['services/intake/backend/app.py']);
  assert.deepEqual(byDir['services/intake/.claude/skills/verify'].features, ['patient-form', 'sign-in']);
  assert.deepEqual(byDir['.claude/skills/verify'].covers, ['services/main/x.py']);
});

test('files outside every skill are not covered', () => {
  const root = tmp();
  writeSkill(root, 'services/intake');
  const skills = findVerifySkills(['services/main/x.py'], root);
  assert.deepEqual(skills, []);
});

test('a skill whose frontmatter name is not verify is ignored', () => {
  const root = tmp();
  writeSkill(root, '.', { name: 'something-else' });
  assert.deepEqual(findVerifySkills(['src/a.py'], root), []);
});

test('backslash paths are normalized and paths escaping the repo are ignored', () => {
  const root = tmp();
  writeSkill(root, '.');
  const skills = findVerifySkills(['src\\a.py', '../outside.py', '/etc/passwd'], root);
  assert.equal(skills.length, 1);
  assert.deepEqual(skills[0].covers, ['src/a.py']);
});
