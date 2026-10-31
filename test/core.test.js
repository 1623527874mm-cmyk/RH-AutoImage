import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    isAiMessage, countAiUpTo, countAiMessages, shouldTrigger, hashText, hasGeneratedMedia,
    stripCodeFence, extractJsonObject, parsePositivePrompt,
    normalizeRhResponse, normalizeStatus, pickImageUrls, describeEmptyResults,
    guessImageFormat, buildRhPayload, parseExtraNodes, validateSettings, clampText,
    checkInputLimits, describeInputProblems, buildPromptUserContent, PROMPT_SECTION,
    migrateSettings, isSupportedChat, DEFAULT_POSITIVE_TEMPLATE, SETTINGS_VERSION,
    MAX_PERSONA_LEN, MAX_TEMPLATE_LEN, MAX_REPLY_LEN, MAX_PROMPT_LEN,
    assembleRhValues, CURRENT_RH_APP_ID, DEPRECATED_RH_APP_IDS, checkDeprecatedSettings,
    checkFieldNameHints,
} from '../lib/core.js';

const U = (mes) => ({ mes, is_user: true });
const A = (mes) => ({ mes, is_user: false, name: 'char' });
const S = (mes) => ({ mes, is_system: true });

test('只有 AI 回复计入楼层：用户消息不影响计数', () => {
    const chat = [A('a1'), U('u1'), A('a2'), U('u2'), A('a3')];
    assert.equal(countAiUpTo(chat, 0), 1);
    assert.equal(countAiUpTo(chat, 1), 1, '用户消息不增加计数');
    assert.equal(countAiUpTo(chat, 2), 2);
    assert.equal(countAiUpTo(chat, 4), 3);
    assert.equal(countAiMessages(chat), 3);
});

test('系统消息不计数', () => {
    const chat = [S('sys'), A('a1'), U('u'), A('a2')];
    assert.equal(countAiUpTo(chat, 0), 0);
    assert.equal(countAiUpTo(chat, 1), 1);
    assert.equal(countAiUpTo(chat, 3), 2);
    assert.equal(isAiMessage(S('x')), false);
});

test('间隔 N=3 时只在第 3、6、9 条 AI 回复触发', () => {
    const hits = [];
    for (let n = 1; n <= 10; n++) if (shouldTrigger(n, 3)) hits.push(n);
    assert.deepEqual(hits, [3, 6, 9]);
});

test('间隔非法值不触发', () => {
    for (const bad of [0, -1, NaN, Infinity, 'abc', null, undefined]) {
        assert.equal(shouldTrigger(3, bad), false, `interval=${bad}`);
    }
    assert.equal(shouldTrigger(0, 3), false);
});

test('间隔为字符串数字时按数字处理', () => {
    assert.equal(shouldTrigger(3, '3'), true);
    assert.equal(shouldTrigger(4, '3'), false);
});

test('删除消息后计数按现存顺序重算，而不是永久递增', () => {
    let chat = [A('a1'), U('u1'), A('a2'), U('u2'), A('a3')];
    assert.equal(countAiUpTo(chat, 4), 3);
    // 删除第 0 条 AI 消息
    chat = chat.slice(1);
    assert.equal(countAiUpTo(chat, 3), 2, '删掉一条后总数降为 2');
    // 再来一条 AI 回复 → 变成第 3 条 → 再次触发（这是设计上的「可校正」行为）
    chat.push(A('a4'));
    assert.equal(countAiUpTo(chat, 4), 3);
    assert.equal(shouldTrigger(countAiUpTo(chat, 4), 3), true);
});

test('楼层指纹：内容不同则指纹不同，内容相同则稳定', () => {
    assert.equal(hashText('abc'), hashText('abc'));
    assert.notEqual(hashText('abc'), hashText('abd'));
    assert.notEqual(hashText('abc'), hashText('abc '));
    assert.equal(hashText(null), hashText(''));
    // 指纹只用于「是否同一条」，不含任何状态字段
    assert.match(hashText('x'), /^\d+:[0-9a-z]+$/);
});

test('hasGeneratedMedia 只读 extra.media，不认任何任务状态字段', () => {
    assert.equal(hasGeneratedMedia({ mes: 'x' }), false);
    assert.equal(hasGeneratedMedia({ mes: 'x', extra: {} }), false);
    assert.equal(hasGeneratedMedia({ mes: 'x', extra: { media: [] } }), false);
    assert.equal(hasGeneratedMedia({ mes: 'x', extra: { media: [{ url: '/a.png' }] } }), true);
    // 旧实现的 rh_image_job 已不再是判定依据
    assert.equal(hasGeneratedMedia({ mes: 'x', extra: { rh_image_job: { status: 'success' } } }), false);
});

test('越界楼层返回 -1 而不是误触发', () => {
    const chat = [A('a1')];
    assert.equal(countAiUpTo(chat, -1), -1);
    assert.equal(countAiUpTo(chat, 5), -1);
    assert.equal(countAiUpTo(null, 0), -1);
});

test('剥掉 Markdown 围栏', () => {
    assert.equal(stripCodeFence('```json\n{"a":1}\n```'), '{"a":1}');
    assert.equal(stripCodeFence('{"a":1}'), '{"a":1}');
});

test('从带前后废话的文本中抠出 JSON', () => {
    const text = '好的，这是结果：\n{"positive":"cat","negative":"dog"}\n希望有帮助。';
    assert.equal(extractJsonObject(text), '{"positive":"cat","negative":"dog"}');
});

test('JSON 里有嵌套对象和字符串花括号时能正确闭合', () => {
    const text = '{"positive":"a {b} c","meta":{"k":"v"}}';
    const json = extractJsonObject(text);
    assert.equal(json, text);
    assert.equal(JSON.parse(json).positive, 'a {b} c');
});

test('正向解析：一行标签原样返回', () => {
    assert.equal(parsePositivePrompt('masterpiece, a girl, window light'), 'masterpiece, a girl, window light');
});

test('正向解析：只去首尾空白，不碰内部格式', () => {
    assert.equal(parsePositivePrompt('  a girl  '), 'a girl');
    assert.equal(parsePositivePrompt('\n\na girl\n\n'), 'a girl');
    // 内部多空格、多余逗号、换行都不许被「优化」
    assert.equal(parsePositivePrompt('a ,, b ,  c'), 'a ,, b ,  c');
    assert.equal(parsePositivePrompt('a   b'), 'a   b');
    assert.equal(parsePositivePrompt('masterpiece, best quality\n1girl, long hair'), 'masterpiece, best quality\n1girl, long hair');
});

test('正向解析：保留用户模板决定的风格（中文 / 分号 / 权重括号 / 多行）', () => {
    const zh = '少女，白色衬衫，窗边，午后阳光';
    assert.equal(parsePositivePrompt(zh), zh);
    const semicolon = 'masterpiece; 1girl; long hair';
    assert.equal(parsePositivePrompt(semicolon), semicolon);
    const weighted = '(masterpiece:1.2), (soft light:1.1), 1girl';
    assert.equal(parsePositivePrompt(weighted), weighted);
    const danbooru = 'masterpiece, best quality\n1girl, silver hair\nwhite shirt, window light';
    assert.equal(parsePositivePrompt(danbooru), danbooru);
});

test('正向解析：CRLF 统一成 LF（只此一项归一化）', () => {
    assert.equal(parsePositivePrompt('a\r\nb'), 'a\nb');
    assert.equal(parsePositivePrompt('a\rb'), 'a\nb');
});

test('正向解析：空内容一律报错', () => {
    assert.throws(() => parsePositivePrompt(''), /为空/);
    assert.throws(() => parsePositivePrompt('   \n  '), /为空/);
    assert.throws(() => parsePositivePrompt(null), /为空/);
    assert.throws(() => parsePositivePrompt(undefined), /为空/);
});

test('正向解析：Markdown 代码块视为格式不合规（不偷偷剥壳）', () => {
    assert.throws(() => parsePositivePrompt('```\nmasterpiece, a girl\n```'), /Markdown 代码块/);
    assert.throws(() => parsePositivePrompt('```text\na girl\n```'), /Markdown 代码块/);
});

test('正向解析：返回 JSON 视为不符合约定（即便内容合法）', () => {
    assert.throws(
        () => parsePositivePrompt('{"positive":"a girl","negative":"blurry"}'),
        /不符合「只返回一条正向提示词」/,
    );
    assert.throws(() => parsePositivePrompt('["a girl"]'), /不符合/);
});

test('正向解析：带负面段落视为不符合约定', () => {
    assert.throws(() => parsePositivePrompt('a girl\nnegative prompt: lowres'), /负面提示词段落/);
    assert.throws(() => parsePositivePrompt('a girl\n负面提示词：模糊'), /负面提示词段落/);
    // 正文里出现 negative 字样但没标号，不误杀
    assert.equal(parsePositivePrompt('a girl, negative space'), 'a girl, negative space');
});

test('正向解析：带「正面提示词：」前缀标签视为不符合约定', () => {
    assert.throws(() => parsePositivePrompt('正面提示词：a girl'), /标签/);
    assert.throws(() => parsePositivePrompt('Positive prompt: a girl'), /标签/);
    assert.equal(parsePositivePrompt('a girl in positive light'), 'a girl in positive light');
});

test('正向解析：不是合法 JSON 的花括号文本按普通文本处理', () => {
    assert.equal(parsePositivePrompt('{not json} a girl'), '{not json} a girl');
});

test('正向解析：超长直接报错，不静默截断', () => {
    const long = 'x'.repeat(MAX_PROMPT_LEN + 1);
    assert.throws(() => parsePositivePrompt(long), /过长/);
    const exact = 'x'.repeat(MAX_PROMPT_LEN);
    assert.equal(parsePositivePrompt(exact).length, MAX_PROMPT_LEN);
});

test('应用 ID：当前值不是作废值，旧值只警告不改设置', () => {
    assert.equal(CURRENT_RH_APP_ID, '2116435600285958146');
    assert.equal(DEPRECATED_RH_APP_IDS.includes(CURRENT_RH_APP_ID), false);
    assert.ok(DEPRECATED_RH_APP_IDS.includes('2116336611532275714'));

    assert.deepEqual(checkDeprecatedSettings({ rhAppId: CURRENT_RH_APP_ID }), []);
    assert.deepEqual(checkDeprecatedSettings({ rhAppId: '' }), []);
    assert.deepEqual(checkDeprecatedSettings({}), []);

    const w = checkDeprecatedSettings({ rhAppId: '2116336611532275714' });
    assert.equal(w.length, 1);
    assert.match(w[0], /已作废/);
    assert.match(w[0], new RegExp(CURRENT_RH_APP_ID), '提示里要给出当前有效值');

    // 只警告，绝不改传进来的设置
    const s = { rhAppId: '2116336611532275714' };
    checkDeprecatedSettings(s);
    assert.equal(s.rhAppId, '2116336611532275714');
});

test('输入长度检查：只返回字段名/长度/上限，不含任何原文', () => {
    const secret = 'SENSITIVE_CONTENT_不该出现在提示里';
    const problems = checkInputLimits({
        persona: secret + 'x'.repeat(MAX_PERSONA_LEN),
        template: 'ok',
        reply: 'ok',
    });
    assert.equal(problems.length, 1);
    assert.equal(problems[0].field, '角色人设关键词');
    assert.equal(problems[0].max, MAX_PERSONA_LEN);
    const desc = describeInputProblems(problems);
    assert.ok(desc.includes('角色人设关键词'));
    assert.ok(desc.includes(String(MAX_PERSONA_LEN)));
    assert.equal(desc.includes(secret), false, '错误提示不得包含原文');
    assert.equal(desc.includes('SENSITIVE_CONTENT'), false);
});

test('输入长度检查：三项各自的上限', () => {
    assert.deepEqual(checkInputLimits({ persona: 'a', template: 'b', reply: 'c' }), []);
    assert.equal(checkInputLimits({ template: 'x'.repeat(MAX_TEMPLATE_LEN + 1) })[0].field, '正向生成模板');
    assert.equal(checkInputLimits({ reply: 'x'.repeat(MAX_REPLY_LEN + 1) })[0].field, '回复正文');
    // 恰好等于上限不报
    assert.deepEqual(checkInputLimits({ reply: 'x'.repeat(MAX_REPLY_LEN) }), []);
});

test('请求结构：模板 / 人设 / 正文 三段都带固定标题', () => {
    const content = buildPromptUserContent({
        template: 'TEMPLATE_BODY',
        persona: 'PERSONA_BODY',
        reply: 'REPLY_BODY',
    });
    assert.ok(content.includes(PROMPT_SECTION.TEMPLATE));
    assert.ok(content.includes(PROMPT_SECTION.PERSONA));
    assert.ok(content.includes(PROMPT_SECTION.REPLY));
    assert.ok(content.indexOf('TEMPLATE_BODY') < content.indexOf('PERSONA_BODY'));
    assert.ok(content.indexOf('PERSONA_BODY') < content.indexOf('REPLY_BODY'));
});

test('请求结构：人设留空时给出占位，不产生空洞标题', () => {
    const content = buildPromptUserContent({ template: 'T', persona: '', reply: 'R' });
    assert.ok(content.includes('（未填写）'));
    assert.ok(content.includes('R'));
});

test('默认模板可见、可编辑，且写明关键规则', () => {
    assert.ok(DEFAULT_POSITIVE_TEMPLATE.length > 100);
    assert.match(DEFAULT_POSITIVE_TEMPLATE, /pov/i);
    assert.match(DEFAULT_POSITIVE_TEMPLATE, /质量词/);
    assert.match(DEFAULT_POSITIVE_TEMPLATE, /不要输出 JSON|不写/);
    // 默认模板里不应该预置任何真实人设或负面词
    assert.equal(/lowres|watermark/i.test(DEFAULT_POSITIVE_TEMPLATE), false);
});

test('设置迁移：旧正/负前缀原样保留到 legacy 字段并从旧键移除', () => {
    const s = { positivePrefix: 'masterpiece, best quality', negativePrefix: 'lowres, watermark', interval: 3 };
    const r = migrateSettings(s);
    assert.equal(r.migrated, true);
    assert.deepEqual(r.preserved.sort(), ['legacyNegativePrefix', 'legacyPositivePrefix']);
    assert.equal(s.legacyPositivePrefix, 'masterpiece, best quality');
    assert.equal(s.legacyNegativePrefix, 'lowres, watermark');
    assert.equal('positivePrefix' in s, false, '旧键必须删除，不能继续被当成生效值');
    assert.equal('negativePrefix' in s, false);
    assert.equal(s.settingsVersion, SETTINGS_VERSION);
    assert.equal(s.interval, 3, '其它设置不受影响');
});

test('设置迁移：空旧值不产生 legacy 内容，但仍标记为新版本', () => {
    const s = { positivePrefix: '   ', negativePrefix: '' };
    const r = migrateSettings(s);
    assert.equal(r.migrated, true);
    assert.deepEqual(r.preserved, []);
    assert.equal(s.legacyPositivePrefix, '');
    assert.equal(s.legacyNegativePrefix, '');
    assert.equal(s.settingsVersion, SETTINGS_VERSION);
});

test('设置迁移：从不猜测旧值含义（不写入新的三个字段）', () => {
    const s = { positivePrefix: 'masterpiece', negativePrefix: 'lowres' };
    migrateSettings(s);
    assert.equal('characterPersona' in s, false);
    assert.equal('positiveTemplate' in s, false);
    assert.equal('negativePrompt' in s, false);
});

test('设置迁移：幂等，重复调用不覆盖已存在的 legacy 值', () => {
    const s = { positivePrefix: 'OLD', settingsVersion: SETTINGS_VERSION, legacyPositivePrefix: 'USER_EDITED' };
    const r = migrateSettings(s);
    assert.equal(r.migrated, false);
    assert.equal(s.legacyPositivePrefix, 'USER_EDITED');
});

test('设置迁移：新装（无任何旧键）只打版本号', () => {
    const s = {};
    const r = migrateSettings(s);
    assert.equal(r.migrated, true);
    assert.equal(s.settingsVersion, SETTINGS_VERSION);
    assert.deepEqual(r.removed, []);
});

test('聊天类型：只有单人聊天受支持，群聊一律不支持', () => {
    assert.equal(isSupportedChat({ groupId: null }), true);
    assert.equal(isSupportedChat({ groupId: undefined }), true);
    assert.equal(isSupportedChat({ groupId: '' }), true);
    assert.equal(isSupportedChat({ groupId: 0 }), true);
    assert.equal(isSupportedChat({ groupId: 'g-123' }), false);
    assert.equal(isSupportedChat({ groupId: 42 }), false);
    assert.equal(isSupportedChat(null), false);
    assert.equal(isSupportedChat(undefined), false);
});

test('状态归一化覆盖各类写法', () => {
    assert.equal(normalizeStatus('SUCCESS'), 'SUCCESS');
    assert.equal(normalizeStatus('success'), 'SUCCESS');
    assert.equal(normalizeStatus('COMPLETED'), 'SUCCESS');
    assert.equal(normalizeStatus('FAILED'), 'FAILED');
    assert.equal(normalizeStatus('CANCELED'), 'FAILED');
    assert.equal(normalizeStatus('RUNNING'), 'RUNNING');
    assert.equal(normalizeStatus('QUEUED'), 'QUEUED');
    assert.equal(normalizeStatus('WEIRD'), 'UNKNOWN');
    assert.equal(normalizeStatus(''), 'UNKNOWN');
});

test('归一化扁平响应', () => {
    const n = normalizeRhResponse({ code: 0, taskId: 't1', status: 'RUNNING', results: [] });
    assert.equal(n.ok, true);
    assert.equal(n.taskId, 't1');
    assert.equal(n.status, 'RUNNING');
});

test('归一化 data 包裹响应', () => {
    const n = normalizeRhResponse({ code: 0, data: { taskId: 't2', taskStatus: 'SUCCESS', results: [{ url: 'http://x/a.png', outputType: 'image' }] } });
    assert.equal(n.ok, true);
    assert.equal(n.taskId, 't2');
    assert.equal(n.status, 'SUCCESS');
    assert.equal(n.results.length, 1);
});

test('归一化错误响应：code 非 0', () => {
    const n = normalizeRhResponse({ code: 400, msg: 'NODE_INFO_MISMATCH' });
    assert.equal(n.ok, false);
    assert.equal(n.message, 'NODE_INFO_MISMATCH');
});

test('挑图片：多结果、混合类型、非 png 都要处理', () => {
    const results = [
        { url: 'http://x/1.png', outputType: 'image' },
        { url: 'http://x/2.webp', outputType: 'IMAGE' },
        { url: 'http://x/3.txt', outputType: 'txt' },
        { url: 'http://x/4.jpg' },
        'http://x/5.jpeg',
    ];
    const urls = pickImageUrls(results);
    assert.deepEqual(urls, ['http://x/1.png', 'http://x/2.webp', 'http://x/4.jpg', 'http://x/5.jpeg']);
});

test('挑图片：去重', () => {
    const urls = pickImageUrls([{ url: 'http://x/a.png' }, { url: 'http://x/a.png' }]);
    assert.deepEqual(urls, ['http://x/a.png']);
});

test('没有图片时给出明确说明', () => {
    assert.match(describeEmptyResults([]), /没有返回任何结果/);
    assert.match(describeEmptyResults([{ url: 'http://x/a.txt', outputType: 'txt' }]), /没有图片结果.*txt/);
});

test('推断图片格式', () => {
    assert.equal(guessImageFormat('image/jpeg', ''), 'jpg');
    assert.equal(guessImageFormat('image/webp', ''), 'webp');
    assert.equal(guessImageFormat('', 'http://x/a.png?sig=1'), 'png');
    assert.equal(guessImageFormat('', 'http://x/a.JPEG'), 'jpg');
    assert.equal(guessImageFormat('application/octet-stream', 'http://x/noext'), 'png');
});

test('提交体只带配置的节点，不擅自覆盖工作流参数', () => {
    const payload = buildRhPayload({
        positiveValue: 'p',
        negativeValue: 'n',
        positiveNode: '6',
        positiveField: 'text',
        negativeNode: '7',
        negativeField: 'text',
    });
    assert.deepEqual(payload, {
        nodeInfoList: [
            { nodeId: '6', fieldName: 'text', fieldValue: 'p' },
            { nodeId: '7', fieldName: 'text', fieldValue: 'n' },
        ],
        instanceType: 'default',
        usePersonalQueue: 'false',
    });
});

test('无负面节点时不提交负面字段', () => {
    const payload = buildRhPayload({
        positiveValue: 'p', negativeValue: 'n',
        positiveNode: '6', positiveField: 'text',
        negativeNode: '', negativeField: '',
    });
    assert.equal(payload.nodeInfoList.length, 1);
});

test('负面值为空时不提交负面节点', () => {
    const payload = buildRhPayload({
        positiveValue: 'p', negativeValue: '   ',
        positiveNode: '6', positiveField: 'text',
        negativeNode: '7', negativeField: 'text',
    });
    assert.equal(payload.nodeInfoList.length, 1);
});

test('附加节点被追加', () => {
    const payload = buildRhPayload({
        positiveValue: 'p', negativeValue: '',
        positiveNode: '6', positiveField: 'text',
        extraNodes: [{ nodeId: '145', fieldName: 'value', fieldValue: '5' }],
    });
    assert.deepEqual(payload.nodeInfoList[1], { nodeId: '145', fieldName: 'value', fieldValue: '5' });
});

test('附加节点解析：空文本返回空数组，坏 JSON 报错', () => {
    assert.deepEqual(parseExtraNodes(''), []);
    assert.deepEqual(parseExtraNodes('  '), []);
    assert.throws(() => parseExtraNodes('{oops'), /不是合法 JSON/);
    assert.throws(() => parseExtraNodes('{"nodeId":1}'), /必须是数组/);
    assert.deepEqual(
        parseExtraNodes('[{"nodeId":"1","fieldName":"v"},{"bad":1}]'),
        [{ nodeId: '1', fieldName: 'v' }],
    );
});

test('配置校验列出缺失项', () => {
    const missing = validateSettings({});
    assert.ok(missing.includes('DeepSeek API Key'));
    assert.ok(missing.includes('正向生成模板'));
    assert.ok(missing.includes('RunningHub 应用 ID'));
    assert.ok(missing.includes('正面提示词节点 ID'));
    assert.equal(validateSettings({
        deepseekBaseUrl: 'x', deepseekApiKey: 'x', deepseekModel: 'x', positiveTemplate: 'x',
        rhApiKey: 'x', rhAppId: 'x', positiveNodeId: 'x', positiveFieldName: 'x',
    }).length, 0);
    // 模板只有空白也算缺失
    assert.ok(validateSettings({
        deepseekBaseUrl: 'x', deepseekApiKey: 'x', deepseekModel: 'x', positiveTemplate: '   ',
        rhApiKey: 'x', rhAppId: 'x', positiveNodeId: 'x', positiveFieldName: 'x',
    }).includes('正向生成模板'));
});

test('提交值装配：正面只用模型关键词，负面只用固定词（不经模型）', () => {
    const out = assembleRhValues({
        positive: '  masterpiece, a girl  ',
        settings: { negativePrompt: '  lowres, watermark  ' },
    });
    assert.deepEqual(out, {
        positiveValue: 'masterpiece, a girl',
        negativeValue: 'lowres, watermark',
    });
});

test('提交值装配：负面固定词为空时是空串（交给 buildRhPayload 跳过节点）', () => {
    const out = assembleRhValues({ positive: 'a girl', settings: { negativePrompt: '   ' } });
    assert.equal(out.negativeValue, '');
    assert.equal(out.positiveValue, 'a girl');
    const missing = assembleRhValues({ positive: 'a girl', settings: {} });
    assert.equal(missing.negativeValue, '');
});

test('提交值装配：负面词不会从模型输出里推导出来', () => {
    const out = assembleRhValues({
        positive: 'a girl, lowres, watermark',
        settings: { negativePrompt: '' },
    });
    // 即使模型在正面里混进了负面词，负面字段依然保持用户设定（空）
    assert.equal(out.negativeValue, '');
    assert.equal(out.positiveValue, 'a girl, lowres, watermark');
});

test('提交值装配：正面为空时保持空串，交给调用方报错', () => {
    assert.equal(assembleRhValues({ positive: '   ', settings: { negativePrompt: 'x' } }).positiveValue, '');
    assert.equal(assembleRhValues({}).positiveValue, '');
});

test('clampText 截断与空值', () => {
    assert.equal(clampText('abc', 10), 'abc');
    assert.equal(clampText('abcdef', 3), 'abc');
    assert.equal(clampText(null, 3), '');
});

test('字段名软提示：默认应用 + prompt 才提醒，且不改任何值', () => {
    const s = { rhAppId: CURRENT_RH_APP_ID, positiveFieldName: 'prompt' };
    const hints = checkFieldNameHints(s);
    assert.equal(hints.length, 1);
    assert.match(hints[0], /text/);
    // 只读：对象不得被改动
    assert.deepEqual(s, { rhAppId: CURRENT_RH_APP_ID, positiveFieldName: 'prompt' });
});

test('字段名软提示：已改成 text / 换了应用 ID 都不打扰', () => {
    assert.deepEqual(checkFieldNameHints({ rhAppId: CURRENT_RH_APP_ID, positiveFieldName: 'text' }), []);
    assert.deepEqual(checkFieldNameHints({ rhAppId: CURRENT_RH_APP_ID, positiveFieldName: 'PROMPT_TEMPLATE' }), []);
    assert.deepEqual(checkFieldNameHints({ rhAppId: '9999999999999999999', positiveFieldName: 'prompt' }), []);
    assert.deepEqual(checkFieldNameHints({}), []);
});
