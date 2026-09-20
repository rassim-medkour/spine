const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { lintWorkflow } = require('../scripts/lib/workflow-lint');

const WF = ['review'];

test('lintWorkflow rejects a bad meta and forbidden calls', () => {
  assert.deepEqual(lintWorkflow('const x = 1'), ['file must start with export const meta = {']);
  const bad = "export const meta = {\n  name: 'a', description: 'b', phases: [{ title: t }]\n};\nDate.now()";
  const errors = lintWorkflow(bad);
  assert.ok(errors.some((e) => /meta must be a pure literal/.test(e)));
  assert.ok(errors.some((e) => /Date\\.now/.test(e)));
});

for (const name of WF) {
  test(`${name}.workflow.js passes lint and declares its phases`, () => {
    const file = path.join(__dirname, '..', 'workflows', `${name}.workflow.js`);
    assert.ok(fs.existsSync(file), `${file} missing`);
    const text = fs.readFileSync(file, 'utf8');
    assert.deepEqual(lintWorkflow(text), []);
    const metaSrc = /export const meta = (\{[\s\S]*?\n\});/.exec(text)[1];
    const meta = new Function(`return ${metaSrc}`)();
    assert.equal(meta.name, `spine-${name}`);
    for (const p of meta.phases) {
      assert.ok(text.includes(`phase('${p.title}')`) || text.includes(`phase: '${p.title}'`), `phase ${p.title} not used`);
    }
  });
}
