'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shouan-models-'));
process.env.XINYU_DATA_DIR = tmp;
process.env.LLM_BASE_URL = 'https://fixture.example/v1';
process.env.LLM_API_KEY = 'fixture-key-not-a-real-secret';
const { listModels } = require('../src/infra/llm');
const config = require('../src/infra/config');
const realFetch = global.fetch;
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
test.after(() => { global.fetch = realFetch; fs.rmSync(tmp, { recursive: true, force: true }); });

test('模型发现与设置集成', async t => {
  await t.test('目录去重排序，过滤非法条目，携带鉴权且不跟随跳转', async () => {
    global.fetch = async (url, opts) => {
      assert.equal(url, 'https://fixture.example/v1/models');
      assert.equal(opts.headers.Authorization, 'Bearer fixture-key-not-a-real-secret');
      assert.equal(opts.redirect, 'error');
      return json({ data: [{ id: 'z-chat' }, { id: 'a-chat' }, { id: 'z-chat' }, {}, { id: 3 }] });
    };
    const result = await listModels();
    assert.deepEqual(result.models, [{ id: 'a-chat' }, { id: 'z-chat' }]);
    assert.equal(result.baseUrl, 'https://fixture.example/v1');
    assert.equal(JSON.stringify(result).includes('fixture-key'), false);
  });
  await t.test('域名根地址遇 404 自动尝试 /v1，返回聊天共用地址', async () => {
    const urls = [];
    global.fetch = async url => { urls.push(url); return urls.length === 1 ? json({}, 404) : json({ data: [{ id: 'vendor-chat' }] }); };
    const result = await listModels({ baseUrl: 'https://vendor.example', apiKey: 'fixture-vendor-key' });
    assert.equal(result.baseUrl, 'https://vendor.example/v1');
    assert.deepEqual(urls, ['https://vendor.example/models', 'https://vendor.example/v1/models']);
  });
  await t.test('完整 chat/completions 地址与尾斜杠自动归一化', async () => {
    global.fetch = async url => { assert.equal(url, 'https://fixture.example/v1/models'); return json({ models: ['custom-chat'] }); };
    const result = await listModels({ baseUrl: 'https://fixture.example/v1/chat/completions/' });
    assert.equal(result.models[0].id, 'custom-chat');
  });
  await t.test('新服务地址不得收到原服务的 Key', async () => {
    global.fetch = async () => { throw Error('must not call upstream'); };
    assert.equal((await listModels({ baseUrl: 'https://other.example/v1' })).code, 'no_key');
    assert.throws(() => config.saveConfig({ baseUrl: 'https://other.example/v1' }), /同时填写/);
  });
  await t.test('401/403 明确报鉴权错误且不发计费试聊请求', async () => {
    for (const status of [401, 403]) {
      let calls = 0;
      global.fetch = async () => { calls++; return json({ error: 'upstream-secret-not-to-be-exposed' }, status); };
      const result = await listModels();
      assert.equal(result.code, 'model_auth'); assert.equal(calls, 1);
      assert.equal(JSON.stringify(result).includes('upstream-secret'), false);
    }
  });
  await t.test('没有目录、空目录与畸形 JSON 支持手填回退', async () => {
    for (const [reply, code] of [[() => json({}, 404), 'model_list_unsupported'], [() => json({ data: [] }), 'model_list_empty'], [() => new Response('<html>oops</html>'), 'model_list_network']]) {
      global.fetch = async () => reply();
      assert.equal((await listModels()).code, code);
    }
  });
  await t.test('非法 URL 参数被拒绝，不发网络请求', async () => {
    for (const baseUrl of ['file:///secret', 'https://x.example/v1?key=bad', 'https://user:pass@x.example/v1'])
      await assert.rejects(listModels({ baseUrl, apiKey: 'fixture' }));
  });
  await t.test('未保存草稿检测不覆盖原配置，选定模型持久化', async () => {
    config.saveConfig({ apiKey: 'fixture-saved-key', baseUrl: 'https://saved.example/v1', model: 'saved-chat' });
    const file = path.join(tmp, 'config.json');
    const before = fs.readFileSync(file, 'utf8');
    global.fetch = async () => json({ data: [{ id: 'new-chat' }] });
    await listModels({ apiKey: 'fixture-preview-key', baseUrl: 'https://preview.example/v1' });
    assert.equal(fs.readFileSync(file, 'utf8'), before);
    config.saveConfig({ model: 'picked-chat' });
    assert.equal(config.getConfig().model, 'picked-chat');
  });
  await t.test('POST /api/config/models 与配置保存端点完整对接', async () => {
    const express = require('express');
    const { configRouter } = require('../src/api/routes');
    const app = express(); app.use(express.json()); app.use('/api/config', configRouter);
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    try {
      const base = 'http://127.0.0.1:' + server.address().port + '/api/config';
      global.fetch = async () => json({ data: [{ id: 'picked-chat' }] });
      const response = await realFetch(base + '/models', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const data = await response.json();
      assert.equal(data.ok, true); assert.equal(data.data.models[0].id, 'picked-chat');
      assert.equal(JSON.stringify(data).includes('fixture-saved-key'), false);
      const saved = await realFetch(base, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'picked-chat' }) });
      assert.equal((await saved.json()).data.model, 'picked-chat');
    } finally { await new Promise(resolve => server.close(resolve)); }
  });
});
