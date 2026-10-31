// api.test.js — 用假 fetch 验证网络层：不触碰真实 DeepSeek / RunningHub。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApi, deepseekEndpoint, rhBase, safeError, redact, PROMPT_SYSTEM } from '../lib/api.js';
import { buildRhPayload, MAX_REPLY_LEN, MAX_PERSONA_LEN } from '../lib/core.js';

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

function makeSettings(over = {}) {
    return {
        deepseekBaseUrl: 'https://api.deepseek.com',
        deepseekApiKey: 'sk-test-DEEPSEEK',
        deepseekModel: 'deepseek-chat',
        deepseekTemperature: 0.3,
        deepseekMaxTokens: 600,
        characterPersona: 'PERSONA_TEXT',
        positiveTemplate: 'TEMPLATE_TEXT',
        negativePrompt: 'FIXED_NEGATIVE_TEXT',
        rhBaseUrl: 'https://www.runninghub.ai',
        rhApiKey: 'rh-test-KEY',
        rhAppId: '1234567890',
        positiveNodeId: '6',
        positiveFieldName: 'text',
        negativeNodeId: '',
        negativeFieldName: '',
        pollIntervalMs: 2000,
        pollTimeoutMs: 60000,
        requestTimeoutMs: 5000,
        ...over,
    };
}

test('deepseekEndpoint 补全各种写法', () => {
    assert.equal(deepseekEndpoint('https://api.deepseek.com'), 'https://api.deepseek.com/v1/chat/completions');
    assert.equal(deepseekEndpoint('https://api.deepseek.com/'), 'https://api.deepseek.com/v1/chat/completions');
    assert.equal(deepseekEndpoint('https://api.deepseek.com/v1'), 'https://api.deepseek.com/v1/chat/completions');
    assert.equal(deepseekEndpoint('https://x/v1/chat/completions'), 'https://x/v1/chat/completions');
    assert.throws(() => deepseekEndpoint(''), /为空/);
});

test('rhBase 去尾斜杠并有默认值', () => {
    assert.equal(rhBase('https://www.runninghub.ai/'), 'https://www.runninghub.ai');
    assert.equal(rhBase(''), 'https://www.runninghub.ai');
});

test('safeError 抹掉 key 与 Bearer', () => {
    assert.equal(safeError(new Error('bad key sk-test-DEEPSEEK here'), 'sk-test-DEEPSEEK'), 'bad key *** here');
    assert.match(safeError(new Error('Bearer abc.def.ghi 无效')), /Bearer \*\*\*/);
    assert.equal(safeError('普通错误'), '普通错误');
});

const INPUT = { persona: 'silver hair, white shirt', template: 'TEMPLATE_TEXT', reply: '她靠在窗边看着外面。' };

test('DeepSeek 成功：原样返回模型输出（只去首尾空白）', async () => {
    const calls = [];
    const api = createApi({
        fetchImpl: async (url, init) => {
            calls.push({ url, init });
            return jsonResponse({ choices: [{ message: { content: 'masterpiece, best quality\n1girl, silver hair,  white shirt ' } }] });
        },
    });
    const out = await api.generatePositivePrompt(makeSettings(), INPUT);
    // 换行、双空格都保留：没有被插件改写成逗号列表
    assert.equal(out, 'masterpiece, best quality\n1girl, silver hair,  white shirt');
    assert.equal(calls[0].url, 'https://api.deepseek.com/v1/chat/completions');
    assert.equal(calls[0].init.headers.Authorization, 'Bearer sk-test-DEEPSEEK');
});

test('system 只约束「一条正向提示词」，不强制语言/大小写/分隔符等风格', () => {
    // 必须写清的核心约束
    assert.match(PROMPT_SYSTEM, /一条正向提示词/);
    assert.match(PROMPT_SYSTEM, /不要输出负面提示词/);
    assert.match(PROMPT_SYSTEM, /不要输出 JSON/);
    // 不得硬编码风格要求（这些归用户可编辑模板管）
    assert.equal(/全小写|全部小写/.test(PROMPT_SYSTEM), false, 'system 不得强制小写');
    assert.equal(/英文标签/.test(PROMPT_SYSTEM), false, 'system 不得强制英文标签');
    assert.equal(/英文逗号分隔|逗号分隔/.test(PROMPT_SYSTEM), false, 'system 不得强制逗号分隔');
    assert.equal(/必须.{0,4}英文/.test(PROMPT_SYSTEM), false, 'system 不得强制英文');
    // 风格由模板决定的表述必须在
    assert.match(PROMPT_SYSTEM, /一律以「生成要求」为准/);
});

test('风格由用户模板决定：模板写中文就返回中文，写分号就保留分号', async () => {
    const api = createApi({
        fetchImpl: async () => jsonResponse({
            choices: [{ message: { content: '少女；白色衬衫；窗边' } }],
        }),
    });
    const out = await api.generatePositivePrompt(makeSettings(), {
        ...INPUT, template: '用中文写，分号分隔',
    });
    assert.equal(out, '少女；白色衬衫；窗边');
});

test('DeepSeek 请求结构：system 固定约束 + user 含模板/人设/正文', async () => {
    const bodies = [];
    const api = createApi({
        fetchImpl: async (url, init) => {
            bodies.push(JSON.parse(init.body));
            return jsonResponse({ choices: [{ message: { content: 'a girl' } }] });
        },
    });
    await api.generatePositivePrompt(makeSettings(), INPUT);
    const body = bodies[0];
    assert.equal(body.model, 'deepseek-chat');
    assert.equal(body.messages.length, 2);
    assert.equal(body.messages[0].role, 'system');
    assert.equal(body.messages[0].content, PROMPT_SYSTEM);
    assert.equal(body.messages[1].role, 'user');
    const user = body.messages[1].content;
    assert.ok(user.includes('TEMPLATE_TEXT'), '模板必须发出');
    assert.ok(user.includes('silver hair, white shirt'), '人设必须发出');
    assert.ok(user.includes('她靠在窗边看着外面。'), '正文必须发出');
    // 不再要求 JSON 输出
    assert.equal(body.response_format, undefined);
});

test('DeepSeek 请求：固定负面词绝不发给模型', async () => {
    const bodies = [];
    const api = createApi({
        fetchImpl: async (url, init) => {
            bodies.push(JSON.parse(init.body));
            return jsonResponse({ choices: [{ message: { content: 'a girl' } }] });
        },
    });
    await api.generatePositivePrompt(makeSettings({ negativePrompt: 'FIXED_NEGATIVE_TEXT' }), INPUT);
    const all = JSON.stringify(bodies[0]);
    assert.equal(all.includes('FIXED_NEGATIVE_TEXT'), false, '负面词不得进请求');
    assert.equal(all.includes('negative'), false, '请求里不应出现 negative 字段');
});

test('DeepSeek 只见目标回复，不带其它楼层', async () => {
    const bodies = [];
    const api = createApi({
        fetchImpl: async (url, init) => {
            bodies.push(JSON.parse(init.body));
            return jsonResponse({ choices: [{ message: { content: 'a girl' } }] });
        },
    });
    await api.generatePositivePrompt(makeSettings(), { ...INPUT, reply: 'ONLY_THIS_TURN' });
    assert.ok(bodies[0].messages[1].content.includes('ONLY_THIS_TURN'));
});

test('正文为空时根本不发请求', async () => {
    let called = false;
    const api = createApi({ fetchImpl: async () => { called = true; return jsonResponse({}); } });
    await assert.rejects(() => api.generatePositivePrompt(makeSettings(), { ...INPUT, reply: '' }), /正文为空/);
    await assert.rejects(() => api.generatePositivePrompt(makeSettings(), { ...INPUT, reply: '   \n ' }), /正文为空/);
    assert.equal(called, false);
});

test('模板为空时根本不发请求', async () => {
    let called = false;
    const api = createApi({ fetchImpl: async () => { called = true; return jsonResponse({}); } });
    await assert.rejects(() => api.generatePositivePrompt(makeSettings(), { ...INPUT, template: '  ' }), /模板为空/);
    assert.equal(called, false);
});

test('输入过长时拒绝调用且提示不含原文', async () => {
    let called = false;
    const api = createApi({ fetchImpl: async () => { called = true; return jsonResponse({}); } });
    const secret = 'SECRET_PERSONA_CONTENT';
    const err = await api.generatePositivePrompt(makeSettings(), {
        ...INPUT,
        persona: secret + 'x'.repeat(MAX_PERSONA_LEN),
    }).then(() => null, e => e);
    assert.ok(err, '应当抛错');
    assert.match(err.message, /输入过长/);
    assert.match(err.message, /角色人设关键词/);
    assert.equal(err.message.includes(secret), false, '错误提示不得包含原文');
    assert.equal(called, false, '不得发起请求');

    const err2 = await api.generatePositivePrompt(makeSettings(), {
        ...INPUT, reply: 'y'.repeat(MAX_REPLY_LEN + 1),
    }).then(() => null, e => e);
    assert.match(err2.message, /回复正文/);
    assert.equal(called, false);
});

test('DeepSeek 非 200 报错并带状态码', async () => {
    const api = createApi({
        fetchImpl: async () => jsonResponse({ error: 'rate limit' }, { status: 429 }),
    });
    await assert.rejects(() => api.generatePositivePrompt(makeSettings(), INPUT), /HTTP 429/);
});

test('DeepSeek 错误响应回显输入时被脱敏', async () => {
    const api = createApi({
        fetchImpl: async () => jsonResponse({
            error: 'bad request',
            echo: '她靠在窗边看着外面。sk-test-DEEPSEEK FIXED_NEGATIVE_TEXT',
        }, { status: 400 }),
    });
    const err = await api.generatePositivePrompt(makeSettings(), INPUT).then(() => null, e => e);
    assert.ok(err);
    assert.match(err.message, /HTTP 400/);
    assert.equal(err.message.includes('她靠在窗边看着外面'), false, '正文不得回显');
    assert.equal(err.message.includes('sk-test-DEEPSEEK'), false, 'key 不得回显');
    assert.equal(err.message.includes('FIXED_NEGATIVE_TEXT'), false);
});

test('DeepSeek 超时报错', async () => {
    const api = createApi({
        fetchImpl: async (url, init) => {
            // 模拟被 AbortController 中止
            const err = new Error('请求超时');
            err.name = 'AbortError';
            throw err;
        },
    });
    await assert.rejects(() => api.generatePositivePrompt(makeSettings(), INPUT), /请求超时/);
});

test('DeepSeek 返回空 content 报错', async () => {
    const api = createApi({
        fetchImpl: async () => jsonResponse({ choices: [{ message: { content: '' } }] }),
    });
    await assert.rejects(() => api.generatePositivePrompt(makeSettings(), INPUT), /内容为空/);
});

test('DeepSeek 返回非 JSON 响应体报错', async () => {
    const api = createApi({
        fetchImpl: async () => jsonResponse('<html>502</html>', { status: 200, mime: 'text/html' }),
    });
    await assert.rejects(() => api.generatePositivePrompt(makeSettings(), INPUT), /非 JSON/);
});

test('DeepSeek 返回 JSON 正负结构视为格式不符', async () => {
    const api = createApi({
        fetchImpl: async () => jsonResponse({
            choices: [{ message: { content: '{"positive":"a girl","negative":"blurry"}' } }],
        }),
    });
    await assert.rejects(() => api.generatePositivePrompt(makeSettings(), INPUT), /不符合/);
});

test('redact 覆盖 key / Bearer / sk- / rh- / 自定义敏感串', () => {
    const out = redact('key=sk-abcdef123456 Bearer tok.xxx rh-abcdef123 TARGET', ['TARGET']);
    assert.equal(out.includes('sk-abcdef123456'), false);
    assert.equal(out.includes('tok.xxx'), false);
    assert.equal(out.includes('rh-abcdef123'), false);
    assert.equal(out.includes('TARGET'), false);
    assert.match(out, /\*\*\*/);
});

/**
 * 端到端（仍然离线）：正向结果 + 固定负面词分别落到正确的节点。
 * 用假 fetch 同时接住 DeepSeek 与 RunningHub 两个请求。
 */
test('正向与固定负面分别填进正/负节点，负面不经模型', async () => {
    const calls = [];
    const api = createApi({
        fetchImpl: async (url, init) => {
            calls.push({ url, body: init.body ? JSON.parse(init.body) : null });
            if (url.includes('deepseek')) {
                return jsonResponse({ choices: [{ message: { content: 'masterpiece, a girl, window light' } }] });
            }
            return jsonResponse({ code: 0, data: { taskId: 'TASK-9', taskStatus: 'QUEUED' } });
        },
    });
    const s = makeSettings({ negativeNodeId: '1018', negativeFieldName: 'text', negativePrompt: 'lowres, watermark' });

    const positive = await api.generatePositivePrompt(s, INPUT);
    const payload = buildRhPayload({
        positiveValue: positive,
        negativeValue: s.negativePrompt.trim(),
        positiveNode: s.positiveNodeId,
        positiveField: s.positiveFieldName,
        negativeNode: s.negativeNodeId,
        negativeField: s.negativeFieldName,
    });
    const submitted = await api.rhSubmit(s, payload);
    assert.equal(submitted.taskId, 'TASK-9');

    const rhBody = calls[calls.length - 1].body;
    const pos = rhBody.nodeInfoList.find(n => n.nodeId === '6');
    const neg = rhBody.nodeInfoList.find(n => n.nodeId === '1018');
    assert.equal(pos.fieldValue, 'masterpiece, a girl, window light');
    assert.equal(neg.fieldValue, 'lowres, watermark');
    assert.equal(rhBody.width, undefined, '不得写死分辨率');
    assert.equal(rhBody.height, undefined);
});

test('固定负面词为空时不提交负面节点', async () => {
    const payload = buildRhPayload({
        positiveValue: 'a girl', negativeValue: '',
        positiveNode: '6', positiveField: 'text',
        negativeNode: '1018', negativeField: 'text',
    });
    assert.equal(payload.nodeInfoList.length, 1);
    assert.equal(payload.nodeInfoList.some(n => n.nodeId === '1018'), false);
});

test('RunningHub 提交成功返回 taskId', async () => {
    const calls = [];
    const api = createApi({
        fetchImpl: async (url, init) => {
            calls.push({ url, init });
            return jsonResponse({ code: 0, data: { taskId: 'TASK-1', taskStatus: 'QUEUED' } });
        },
    });
    const payload = buildRhPayload({
        positiveValue: 'p', negativeValue: '', positiveNode: '6', positiveField: 'text',
    });
    const res = await api.rhSubmit(makeSettings(), payload);
    assert.equal(res.taskId, 'TASK-1');
    assert.equal(calls[0].url, 'https://www.runninghub.ai/openapi/v2/run/ai-app/1234567890');
    assert.equal(calls[0].init.headers.Authorization, 'Bearer rh-test-KEY');
    const body = JSON.parse(calls[0].init.body);
    assert.equal(body.instanceType, 'default');
    assert.equal(body.usePersonalQueue, 'false');
    assert.deepEqual(body.nodeInfoList, [{ nodeId: '6', fieldName: 'text', fieldValue: 'p' }]);
});

test('当前应用 ID 落在提交 URL 上，且请求体没有任何分辨率字段', async () => {
    const calls = [];
    const api = createApi({
        fetchImpl: async (url, init) => {
            calls.push({ url, body: JSON.parse(init.body) });
            return jsonResponse({ code: 0, data: { taskId: 'TASK-NEW' } });
        },
    });
    const s = makeSettings({ rhAppId: '2116435600285958146' });
    const payload = buildRhPayload({
        positiveValue: 'a girl', negativeValue: '',
        positiveNode: '1195', positiveField: 'text',
        negativeNode: '1018', negativeField: 'text',
    });
    await api.rhSubmit(s, payload);

    assert.equal(calls[0].url, 'https://www.runninghub.ai/openapi/v2/run/ai-app/2116435600285958146');
    // 分辨率由应用工作流决定：payload 里一个都不许有
    for (const key of ['width', 'height', 'resolution', 'size', 'aspectRatio']) {
        assert.equal(key in calls[0].body, false, `请求体不得包含 ${key}`);
    }
    // 参数契约不变
    assert.equal(calls[0].body.instanceType, 'default');
    assert.equal(calls[0].body.usePersonalQueue, 'false');
    // 节点映射原样透传，插件不自己编
    assert.deepEqual(calls[0].body.nodeInfoList, [
        { nodeId: '1195', fieldName: 'text', fieldValue: 'a girl' },
    ]);
});

test('节点映射完全来自设置：换 nodeId/字段名就跟着换', async () => {
    const bodies = [];
    const api = createApi({
        fetchImpl: async (url, init) => {
            bodies.push(JSON.parse(init.body));
            return jsonResponse({ code: 0, data: { taskId: 'T' } });
        },
    });
    await api.rhSubmit(makeSettings(), buildRhPayload({
        positiveValue: 'p', negativeValue: 'n',
        positiveNode: '77', positiveField: 'prompt_text',
        negativeNode: '88', negativeField: 'negative_text',
    }));
    assert.deepEqual(bodies[0].nodeInfoList, [
        { nodeId: '77', fieldName: 'prompt_text', fieldValue: 'p' },
        { nodeId: '88', fieldName: 'negative_text', fieldValue: 'n' },
    ]);
});

test('RunningHub 提交被拒（code≠0）报错带原因', async () => {
    const api = createApi({
        fetchImpl: async () => jsonResponse({ code: 400, msg: 'NODE_INFO_MISMATCH' }),
    });
    await assert.rejects(
        () => api.rhSubmit(makeSettings(), buildRhPayload({ positiveValue: 'p', positiveNode: '6', positiveField: 'text' })),
        /NODE_INFO_MISMATCH/,
    );
});

test('RunningHub 提交缺 taskId 报错', async () => {
    const api = createApi({
        fetchImpl: async () => jsonResponse({ code: 0, data: {} }),
    });
    await assert.rejects(
        () => api.rhSubmit(makeSettings(), buildRhPayload({ positiveValue: 'p', positiveNode: '6', positiveField: 'text' })),
        /未返回 taskId/,
    );
});

test('RunningHub 未配置应用 ID 时不发请求', async () => {
    let called = false;
    const api = createApi({
        fetchImpl: async () => { called = true; return jsonResponse({}); },
    });
    await assert.rejects(
        () => api.rhSubmit(makeSettings({ rhAppId: '' }), { nodeInfoList: [] }),
        /应用 ID 未配置/,
    );
    assert.equal(called, false);
});

test('轮询：QUEUED → RUNNING → SUCCESS 拿到图片', async () => {
    const statuses = ['QUEUED', 'RUNNING', 'SUCCESS'];
    let i = 0;
    const api = createApi({
        fetchImpl: async () => {
            const st = statuses[Math.min(i, statuses.length - 1)];
            i++;
            return jsonResponse({
                code: 0,
                data: {
                    taskId: 'T', taskStatus: st,
                    results: st === 'SUCCESS' ? [{ url: 'https://cdn/x.png', outputType: 'image' }] : [],
                },
            });
        },
        sleepImpl: async () => {},
    });
    const res = await api.rhPoll(makeSettings(), 'T');
    assert.equal(res.status, 'SUCCESS');
    assert.equal(res.results.length, 1);
    assert.equal(i, 3);
});

test('轮询：任务 FAILED 立即报错', async () => {
    const api = createApi({
        fetchImpl: async () => jsonResponse({ code: 0, data: { taskStatus: 'FAILED', msg: '显存不足' } }),
        sleepImpl: async () => {},
    });
    await assert.rejects(() => api.rhPoll(makeSettings(), 'T'), /任务失败.*显存不足/);
});

test('轮询：超时报错且不无限循环', async () => {
    let t = 0;
    const api = createApi({
        fetchImpl: async () => jsonResponse({ code: 0, data: { taskStatus: 'RUNNING', results: [] } }),
        sleepImpl: async () => { t += 5000; },
        now: () => t,
    });
    await assert.rejects(
        () => api.rhPoll(makeSettings({ pollTimeoutMs: 60000 }), 'T'),
        /轮询超时/,
    );
    assert.ok(t <= 70000, `不应超时太久，实际 ${t}`);
});

test('轮询：外部 abort 时抛已取消', async () => {
    const controller = new AbortController();
    const api = createApi({
        fetchImpl: async () => jsonResponse({ code: 0, data: { taskStatus: 'RUNNING' } }),
        sleepImpl: async () => { controller.abort(); },
    });
    await assert.rejects(() => api.rhPoll(makeSettings(), 'T', controller.signal), /已取消/);
});

test('下载图片返回 mime 与字节', async () => {
    const api = createApi({
        fetchImpl: async () => ({
            ok: true, status: 200,
            headers: { get: () => 'image/webp' },
            arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
        }),
    });
    const { mime, buffer } = await api.downloadImage('https://cdn/x.webp');
    assert.equal(mime, 'image/webp');
    assert.equal(buffer.byteLength, 3);
});

test('下载失败抛 HTTP 错误', async () => {
    const api = createApi({
        fetchImpl: async () => ({ ok: false, status: 403, headers: { get: () => '' } }),
    });
    await assert.rejects(() => api.downloadImage('https://cdn/x.png'), /HTTP 403/);
});
