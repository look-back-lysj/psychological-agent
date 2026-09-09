const fs = require('fs');
const path = require('path');
const { chooseStrategy } = require('../src/strategy');
const { checkInputSafety, checkOutputSafety } = require('../src/safety');

const casesPath = path.join(__dirname, 'cases.jsonl');
const cases = fs.readFileSync(casesPath, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
let pass = 0;
const fails = [];

for (const c of cases) {
  const inputSafety = checkInputSafety(c.input);
  const result = chooseStrategy(c.input, inputSafety);
  const outputCheck = checkOutputSafety(c.bad_output || '');
  const strategyOk = result.key === c.expected_strategy;
  const riskOk = inputSafety.riskLevel === c.expected_risk;
  const outputBlockOk = c.bad_output_should_block ? outputCheck.blocked : true;
  const ok = strategyOk && riskOk && outputBlockOk;
  if (ok) pass++;
  else fails.push({ id: c.id, strategyOk, riskOk, outputBlockOk, got_strategy: result.key, got_risk: inputSafety.riskLevel });
}

console.log(`测试结果：${pass}/${cases.length} 通过`);
if (fails.length) {
  console.log('失败用例：');
  for (const f of fails) console.log('-', f.id, f);
}
if (fails.length) process.exitCode = 1;
