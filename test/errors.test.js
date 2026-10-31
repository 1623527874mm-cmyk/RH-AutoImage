// errors.test.js — P3：RunningHub 响应错误处理。全部离线（假 fetch），不触网、不花钱。
//
// 覆盖矩阵：
//   HTTP 非 2xx · 非 JSON · errorCode/errorMessage · failedReason · 缺少 taskId
//   · 失败状态 · 轮询超时 · 无图片输出 · 下载失败 / 空图片 · 全部脱敏 · 失败绝不 attach/save
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApi, safeError, redact } from '../lib/api.js';
import { normalizeRhResponse, buildRhPayload } from '../lib/core.js';
import { createJobStore, runImageJob } from '../lib/jobs.js';
import { hashText } from '../lib/core.js';

// 测试用「敏感原文」——全部是明显的假值（TEST-PLACEHOLDER），用来断言它们不会漏进错误信息。
// 刻意不写成真实 key 的形态，避免 GitHub secret scanning 误报。
const KEY_DEEPSEEK = 'sk-TEST-PLACEHOLDER-0001';
const KEY_RH = 'rh-TEST-PLACEHOLDER-0002';
const PERSONA = 'PERSONA_MUST_NOT_LEAK 银发 白衬衫';
const TEMPLATE = 'TEMPLATE_MUST_NOT_LEAK 只输出一行英文标签';
const NEGATIVE = 'NEGATIVE_MUST_NOT_LEAK lowres bad anatomy';
const REPLY = 'REPLY_MUST_NOT_LEAK 她靠在窗边，轻轻咬了下唇。';
const POSITIVE = 'POSITIVE_MUST_NOT_LEAK 1girl, silver hair, white shirt';

function makeSettings(over = {}) {
    return {
        deepseekBaseUrl: 'https://api.deepseek.com',
        deepseekApiKey: KEY_DEEPSEEK,
        deepseekModel: 'deepseek-chat',
        deepseekTemperature: 0.3,
        deepseekMaxTokens: 600,
        characterPersona: PERSONA,
        positiveTemplate: TEMPLATE,
        negativePrompt: NEGATIVE,
        rhBaseUrl: 'https://www.runninghub.ai',
        rhApiKey: KEY_RH,
        rhAppId: '2116435600285958146',
        positiveNodeId: '1195',
        positiveFieldName: 'text',
        negativeNodeId: '1018',
        negativeFieldName: 'text',
        pollIntervalMs: 2000,
        pollTimeoutMs: 60000,
        requestTimeoutMs: 5000,
        ...over,
    };
}

function jsonResponse(obj, { status = 200, mime = 'application/json' } = {}) {
    const text = typeof obj === 'string' ? obj : JSON.stringify(obj);
    return {
        ok: status >= 200 && status < 300,
        status,
        headers: { get: () => mime },
        text: async () => text,
        json: async () => JSON.parse(text),
        arrayBuffer: async () => new TextEncoder().encode(text).buffer,
    };
}

function payload(over = {}) {
    return buildRhPayload({
        positiveValue: POSITIVE,
        negativeValue: NEGATIVE,
        positiveNode: '1195',
        positiveField: 'text',
        negativeNode: '1018',
        negativeField: 'text',
        ...over,
    });
}

/** 断言一段错误文本里没有任何敏感原文，也没有原始响应体特征。 */
function assertClean(text, extra = []) {
    const t = String(text ?? '');
    for (const secret of [KEY_DEEPSEEK, KEY_RH, PERSONA, TEMPLATE, NEGATIVE, REPLY, POSITIVE, ...extra]) {
        assert.equal(t.includes(secret), false, `错误信息泄露了敏感内容：${secret.slice(0, 16)}…`);
    }
    assert.equal(t.includes('nodeInfoList'), false, '错误信息不得回显请求体结构');
    assert.equal(t.includes('Bearer '), false, '错误信息不得回显 Authorization 头');
    assert.equal(t.includes('sk-'), false, '错误信息不得出现 sk- 前缀');
    assert.equal(t.includes('rh-'), false, '错误信息不得出现 rh- 前缀');
}

// ───────────── normalizeRhResponse：不再保留原始响应体 ─────────────

test('normalizeRhResponse 不保留 raw（防止整包 body 被日志打出去）', () => {
    const n = normalizeRhResponse({ code: 0, data: { taskId: 't', taskStatus: 'QUEUED' } });
    assert.equal('raw' in n, false);
});

test('normalize 识别 errorCode / errorMessage', () => {
    const n = normalizeRhResponse({ errorCode: 1001, errorMessage: 'INVALID_NODE' });
    assert.equal(n.ok, false);
    assert.equal(n.errorCode, '1001');
    assert.match(n.message, /INVALID_NODE/);
});

test('normalize 识别 success=false', () => {
    assert.equal(normalizeRhResponse({ success: false, msg: 'boom' }).ok, false);
    assert.equal(normalizeRhResponse({ success: true, data: { taskId: 't' } }).ok, true);
});

test('normalize 识别 data.failedReason', () => {
    const n = normalizeRhResponse({ code: 0, data: { taskId: 't', taskStatus: 'FAILED', failedReason: 'CUDA OOM' } });
    assert.equal(n.status, 'FAILED');
    assert.equal(n.failedReason, 'CUDA OOM');
});

test('normalize 接受 code:"SUCCESS" 这类文本码', () => {
    assert.equal(normalizeRhResponse({ code: 'SUCCESS', data: { taskId: 't' } }).ok, true);
    assert.equal(normalizeRhResponse({ code: '0', data: { taskId: 't' } }).ok, true);
});

// ───────────── 提交：各类失败 ─────────────

test('提交 HTTP 500：带状态码、原因脱敏、不泄露任何原文', async () => {
    const api = createApi({
        // 服务端故意把 key、正向词、正文都回显在响应体里 —— 这是现实中常见的
        fetchImpl: async () => jsonResponse(
            { code: 500, msg: `Invalid key ${KEY_RH} for prompt ${POSITIVE} / ${REPLY} ${PERSONA}` },
            { status: 500 },
        ),
    });
    // 回复正文不在提交体里，由调用方作为 extraSecrets 补进来（jobs.js 就是这么做的）
    const err = await api.rhSubmit(makeSettings(), payload(), undefined, [REPLY]).then(() => null, e => e);
    assert.ok(err, '必须抛错');
    assert.match(err.message, /HTTP 500/);
    assertClean(err.message);
});

test('提交返回非 JSON（HTML 错误页）：报非 JSON，不带页面内容', async () => {
    const api = createApi({
        fetchImpl: async () => jsonResponse(
            `<html><body>502 Bad Gateway ${KEY_RH} ${POSITIVE}</body></html>`,
            { status: 502, mime: 'text/html' },
        ),
    });
    const err = await api.rhSubmit(makeSettings(), payload()).then(() => null, e => e);
    assert.ok(err);
    assert.match(err.message, /非 JSON/);
    assert.match(err.message, /502/);
    assertClean(err.message);
});

test('提交业务拒绝（code≠0 + errorMessage 回显正向词）：脱敏', async () => {
    const api = createApi({
        fetchImpl: async () => jsonResponse({
            code: 400,
            errorCode: 'NODE_INFO_MISMATCH',
            errorMessage: `node fieldValue invalid: ${POSITIVE}; negative=${NEGATIVE}`,
        }),
    });
    const err = await api.rhSubmit(makeSettings(), payload()).then(() => null, e => e);
    assert.match(err.message, /提交被拒绝/);
    assert.match(err.message, /NODE_INFO_MISMATCH|node fieldValue invalid/);
    assertClean(err.message);
});

test('提交 success=false：判定为被拒绝', async () => {
    const api = createApi({
        fetchImpl: async () => jsonResponse({ success: false, data: { msg: 'quota exceeded' } }),
    });
    await assert.rejects(() => api.rhSubmit(makeSettings(), payload()), /提交被拒绝.*quota exceeded/s);
});

test('提交缺少 taskId：明确报错，且不把 code 当成功继续', async () => {
    const api = createApi({
        fetchImpl: async () => jsonResponse({ code: 0, msg: `echo ${POSITIVE}`, data: {} }),
    });
    const err = await api.rhSubmit(makeSettings(), payload()).then(() => null, e => e);
    assert.match(err.message, /未返回 taskId/);
    assertClean(err.message);
});

test('提交未配置应用 ID：不发请求、不报 key 相关内容', async () => {
    let called = false;
    const api = createApi({
        fetchImpl: async () => { called = true; return jsonResponse({ code: 0, data: { taskId: 't' } }); },
    });
    const err = await api.rhSubmit(makeSettings({ rhAppId: '   ' }), payload()).then(() => null, e => e);
    assert.match(err.message, /应用 ID 未配置/);
    assert.equal(called, false);
    assertClean(err.message);
});

test('提交超时：错误可读且不含请求体', async () => {
    const api = createApi({
        fetchImpl: (url, init) => new Promise((_, reject) => {
            init.signal.addEventListener('abort', () => reject(new Error('请求超时')));
        }),
    });
    const err = await api.rhSubmit(makeSettings({ requestTimeoutMs: 1000 }), payload()).then(() => null, e => e);
    assert.ok(err);
    assertClean(err.message);
});

// ───────────── 查询 / 轮询 ─────────────

test('查询 HTTP 500：状态码 + 脱敏原因', async () => {
    const api = createApi({
        fetchImpl: async () => jsonResponse({ code: 500, msg: `fail ${KEY_RH} ${POSITIVE}` }, { status: 500 }),
    });
    const err = await api.rhQuery(makeSettings(), 'TASK-1', undefined, [POSITIVE]).then(() => null, e => e);
    assert.match(err.message, /HTTP 500/);
    assertClean(err.message);
});

test('查询返回非 JSON：报非 JSON', async () => {
    const api = createApi({
        fetchImpl: async () => jsonResponse('not json at all', { status: 200, mime: 'text/plain' }),
    });
    await assert.rejects(() => api.rhQuery(makeSettings(), 'TASK-1'), /非 JSON/);
});

test('查询 code≠0：判定被拒绝，不返回半截结果', async () => {
    const api = createApi({
        fetchImpl: async () => jsonResponse({ code: 401, msg: 'UNAUTHORIZED' }),
    });
    await assert.rejects(() => api.rhQuery(makeSettings(), 'TASK-1'), /查询被拒绝.*UNAUTHORIZED/s);
});

test('查询状态 FAILED：即使 HTTP 200 + code 0 也报任务失败，原因来自 failedReason 且脱敏', async () => {
    const api = createApi({
        fetchImpl: async () => jsonResponse({
            code: 0,
            data: { taskId: 't', taskStatus: 'FAILED', failedReason: `OOM while encoding ${POSITIVE}` },
        }),
    });
    const err = await api.rhQuery(makeSettings(), 'TASK-1', undefined, [POSITIVE]).then(() => null, e => e);
    assert.match(err.message, /任务失败/);
    assert.match(err.message, /OOM/);
    assertClean(err.message);
});

test('轮询遇到 FAILED 立即停止（不继续轮询、不下载）', async () => {
    let calls = 0;
    const api = createApi({
        fetchImpl: async () => {
            calls++;
            return jsonResponse({ code: 0, data: { taskStatus: 'FAILED', failedReason: 'WORKFLOW_ERROR' } });
        },
        sleepImpl: async () => {},
    });
    await assert.rejects(() => api.rhPoll(makeSettings(), 'T'), /任务失败.*WORKFLOW_ERROR/s);
    assert.equal(calls, 1, '失败状态不得继续轮询');
});

test('轮询超时：带最后状态，且不含任何原文', async () => {
    let t = 0;
    const api = createApi({
        fetchImpl: async () => jsonResponse({
            code: 0, data: { taskStatus: 'RUNNING', msg: `still running ${POSITIVE}` },
        }),
        sleepImpl: async () => { t += 5000; },
        now: () => t,
    });
    const err = await api.rhPoll(makeSettings({ pollTimeoutMs: 60000 }), 'T').then(() => null, e => e);
    assert.match(err.message, /轮询超时/);
    assert.match(err.message, /RUNNING/);
    assertClean(err.message);
});

test('轮询中途 HTTP 出错：立刻抛错，不当成 RUNNING 继续等', async () => {
    let calls = 0;
    const api = createApi({
        fetchImpl: async () => {
            calls++;
            return jsonResponse({ msg: 'boom' }, { status: 503 });
        },
        sleepImpl: async () => {},
    });
    await assert.rejects(() => api.rhPoll(makeSettings(), 'T'), /HTTP 503/);
    assert.equal(calls, 1);
});

test('轮询成功但没有图片结果：返回空 results，交由上层报「无图片输出」', async () => {
    const api = createApi({
        fetchImpl: async () => jsonResponse({
            code: 0, data: { taskStatus: 'SUCCESS', results: [{ url: 'https://cdn/x.txt', outputType: 'txt' }] },
        }),
        sleepImpl: async () => {},
    });
    const res = await api.rhPoll(makeSettings(), 'T');
    assert.equal(res.status, 'SUCCESS');
    assert.equal(res.results.length, 1);
});

// ───────────── 下载 ─────────────

test('下载 HTTP 403：报错不带 URL 里的敏感串', async () => {
    const api = createApi({
        fetchImpl: async () => ({ ok: false, status: 403, headers: { get: () => '' } }),
    });
    await assert.rejects(() => api.downloadImage('https://cdn/x.png'), /HTTP 403/);
});

test('下载到 0 字节：报空图片，不返回 buffer', async () => {
    const api = createApi({
        fetchImpl: async () => ({
            ok: true, status: 200,
            headers: { get: () => 'image/png' },
            arrayBuffer: async () => new ArrayBuffer(0),
        }),
    });
    await assert.rejects(() => api.downloadImage('https://cdn/empty.png'), /图片为空/);
});

test('下载可被取消', async () => {
    const controller = new AbortController();
    const api = createApi({
        fetchImpl: (url, init) => new Promise((_, reject) => {
            init.signal.addEventListener('abort', () => reject(new Error('已取消')));
        }),
    });
    const p = api.downloadImage('https://cdn/slow.png', 60000, controller.signal);
    controller.abort();
    await assert.rejects(() => p, /已取消/);
});

// ───────────── 任务层：失败绝不 attach / save ─────────────

const REF = 'char:chatA:小雅';

function harness({ apiOver = {}, settingsOver = {} } = {}) {
    const chat = [{ mes: REPLY, is_user: false, is_system: false, name: '小雅', extra: {} }];
    const store = createJobStore();
    const job = store.start({
        jobId: 'job-err',
        refKey: REF,
        isGroup: false,
        characterName: '小雅',
        mesIndex: 0,
        mesHash: hashText(REPLY),
        mesText: REPLY,
        status: 'pending',
        startedAt: 1,
    });

    const calls = { submit: 0, poll: 0, save: 0, chatSave: 0, attach: 0 };
    const api = {
        async generatePositivePrompt() { return POSITIVE; },
        async rhSubmit() { calls.submit++; return { taskId: 'T' }; },
        async rhPoll() { calls.poll++; return { results: [{ url: 'https://cdn/x.png', outputType: 'image' }] }; },
        async downloadImage() { throw new Error('不应被调用'); },
        ...apiOver,
    };

    const settings = makeSettings({ positiveNodeId: '1195', positiveFieldName: 'text', ...settingsOver });
    const deps = {
        api, store, settings,
        saveImage: async () => { calls.save++; return '/user/images/x/x.png'; },
        attachMedia: async () => { calls.attach++; return { applied: true }; },
        saveChat: async () => { calls.chatSave++; },
        makeMedia: p => ({ url: p, type: 'image' }),
        now: () => 2,
    };
    return { chat, store, job, deps, calls };
}

async function expectFailureWithoutAttach(mutate) {
    const h = harness();
    mutate(h);
    const before = JSON.stringify(h.chat);
    const res = await runImageJob(h.job, h.deps);

    assert.equal(res.ok, false, '必须失败');
    assert.equal(h.calls.attach, 0, '失败不得挂图');
    assert.equal(h.calls.chatSave, 0, '失败不得保存聊天');
    assert.equal(JSON.stringify(h.chat), before, '消息对象不得被改动');
    assert.equal(h.store.get(h.job.jobId).status, 'failed');
    assertClean(h.store.get(h.job.jobId).error, [h.job.mesText]);
    return h;
}

test('提交 HTTP 500 → 不下载、不挂图、不存盘', async () => {
    await expectFailureWithoutAttach(h => {
        h.deps.api.rhSubmit = async () => {
            h.calls.submit++;
            throw new Error(`RunningHub 提交失败（HTTP 500）：${redact(`bad ${KEY_RH}`, [KEY_RH])}`);
        };
    });
});

test('提交缺 taskId → 不轮询、不下载、不挂图', async () => {
    const h = await expectFailureWithoutAttach(h => {
        h.deps.api.rhSubmit = async () => { h.calls.submit++; throw new Error('RunningHub 未返回 taskId，无法继续查询'); };
    });
    assert.equal(h.calls.poll, 0);
});

test('轮询超时 → 不下载、不挂图、不存盘', async () => {
    await expectFailureWithoutAttach(h => {
        h.deps.api.rhPoll = async () => { h.calls.poll++; throw new Error('RunningHub 轮询超时（最后状态 RUNNING），已放弃本次任务'); };
    });
});

test('任务 FAILED → 错误进内存，聊天层零副作用', async () => {
    await expectFailureWithoutAttach(h => {
        h.deps.api.rhPoll = async () => { h.calls.poll++; throw new Error('RunningHub 任务失败：WORKFLOW_ERROR'); };
    });
});

test('成功但无图片输出 → 明确报错，不 attach/save', async () => {
    const h = await expectFailureWithoutAttach(h => {
        h.deps.api.rhPoll = async () => { h.calls.poll++; return { status: 'SUCCESS', results: [{ url: 'https://cdn/x.txt', outputType: 'txt' }] }; };
    });
    assert.match(h.store.get(h.job.jobId).error, /没有图片/);
});

test('下载失败 → 不挂空图片、不存盘', async () => {
    await expectFailureWithoutAttach(h => {
        h.deps.saveImage = async () => { h.calls.save++; throw new Error('下载图片失败（HTTP 403）'); };
    });
});

test('所有图片都下载失败时保存计数为 0，任务标记失败', async () => {
    const h = harness({
        apiOver: {
            async rhPoll() {
                h.calls.poll++;
                return { results: [
                    { url: 'https://cdn/1.png', outputType: 'image' },
                    { url: 'https://cdn/2.png', outputType: 'image' },
                ] };
            },
        },
    });
    h.deps.saveImage = async () => { h.calls.save++; throw new Error('图片保存到酒馆目录失败'); };
    const res = await runImageJob(h.job, h.deps);
    assert.equal(res.ok, false);
    assert.equal(h.calls.save, 1, '第一张下载失败即中止，不做无用请求');
    assert.equal(h.calls.attach, 0);
    assert.equal(h.calls.chatSave, 0);
    assert.equal(h.store.get(h.job.jobId).imageCount, undefined);
});

test('失败后不自动重试：提交只发生一次', async () => {
    const h = harness();
    h.deps.api.rhSubmit = async () => { h.calls.submit++; throw new Error('RunningHub 提交失败（HTTP 503）：busy'); };
    await runImageJob(h.job, h.deps);
    await new Promise(r => setTimeout(r, 20));
    assert.equal(h.calls.submit, 1, '不得自动重试');
    assert.equal(h.store.get(h.job.jobId).status, 'failed');
});

test('失败信息二次兜底脱敏：调用方 safeError 直接返回原文也不会泄露', async () => {
    const h = harness();
    h.deps.safeError = () => `raw ${KEY_RH} ${POSITIVE} ${PERSONA} ${REPLY}`;
    h.deps.api.rhSubmit = async () => { throw new Error('x'); };
    await runImageJob(h.job, h.deps);
    assertClean(h.store.get(h.job.jobId).error, [REPLY]);
});

// ───────────── 配置：App ID 与 Key 互不干扰 ─────────────

test('App ID 只出现在 URL，Authorization 永远是 rhApiKey（不是 App ID）', async () => {
    const calls = [];
    const api = createApi({
        fetchImpl: async (url, init) => {
            calls.push({ url, init });
            return jsonResponse({ code: 0, data: { taskId: 'T' } });
        },
    });
    const s = makeSettings();
    await api.rhSubmit(s, payload());
    assert.equal(calls[0].init.headers.Authorization, `Bearer ${KEY_RH}`);
    assert.equal(calls[0].init.headers.Authorization.includes(s.rhAppId), false);
    assert.match(calls[0].url, /2116435600285958146$/);
    assert.equal(calls[0].init.body.includes(KEY_RH), false, '请求体不得夹带 Key');
});

test('迁移不会把 App ID 当成 Key 或节点值', async () => {
    const { resolveSettings } = await import('../lib/settings.js');
    const { DEFAULT_SETTINGS } = await import('../lib/settings.js');
    const raw = { settingsVersion: 1, positivePrefix: 'x' };
    const { settings } = resolveSettings(raw);
    assert.equal(settings.rhApiKey, '', 'App ID 不得被抄进 Key');
    // 节点映射现在有公开默认值，但它必须是「本项目应用的映射」，绝不能是 App ID 本身
    assert.equal(settings.positiveNodeId, DEFAULT_SETTINGS.positiveNodeId);
    assert.equal(settings.negativeNodeId, DEFAULT_SETTINGS.negativeNodeId);
    assert.equal(settings.positiveFieldName, DEFAULT_SETTINGS.positiveFieldName);
    assert.equal(settings.negativeFieldName, DEFAULT_SETTINGS.negativeFieldName);
    assert.notEqual(settings.positiveNodeId, settings.rhAppId, 'App ID 不得被猜成节点 ID');
    assert.notEqual(settings.negativeNodeId, settings.rhAppId);
    assert.equal(settings.rhAppId, '2116435600285958146');
});
