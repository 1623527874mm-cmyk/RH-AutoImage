// settings.test.js — 三个输入项的默认值与迁移。纯离线，不触网。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DEFAULT_SETTINGS, PROMPT_INPUT_KEYS, resolveSettings, SETTINGS_VERSION } from '../lib/settings.js';
import {
    CURRENT_RH_APP_ID, DEFAULT_POSITIVE_TEMPLATE, DEFAULT_NEGATIVE_PROMPT, validateSettings,
} from '../lib/core.js';

test('三个多行输入项都在默认值里，且都是字符串', () => {
    for (const key of PROMPT_INPUT_KEYS) {
        assert.equal(typeof DEFAULT_SETTINGS[key], 'string', `${key} 必须是字符串`);
    }
    assert.equal(PROMPT_INPUT_KEYS.length, 3);
    assert.deepEqual([...PROMPT_INPUT_KEYS], ['characterPersona', 'positiveTemplate', 'negativePrompt']);
});

test('公开默认配置：人设刻意留空，模板与固定负面词自带通用内容', () => {
    assert.equal(DEFAULT_SETTINGS.characterPersona, '', '人设必须默认留空，由用户自己决定');
    assert.equal(DEFAULT_SETTINGS.negativePrompt, DEFAULT_NEGATIVE_PROMPT);
    assert.equal(DEFAULT_SETTINGS.positiveTemplate, DEFAULT_POSITIVE_TEMPLATE);
    assert.ok(DEFAULT_SETTINGS.positiveTemplate.length > 100);
    assert.ok(DEFAULT_SETTINGS.negativePrompt.length > 50);
    // 三项里都不得混入任何凭证字段名或 Key 形态
    for (const key of PROMPT_INPUT_KEYS) {
        assert.equal(/sk-|rh-|Bearer/i.test(DEFAULT_SETTINGS[key]), false, `${key} 不得含 Key 形态字符串`);
    }
});

test('人设示例只作为 README 的可选示例存在，绝不进代码默认值', () => {
    const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
    // README 里必须有一段可直接复制的人设示例（含 {{char}} / {{user}} 占位符）
    assert.match(readme, /\{\{char\}\}/, 'README 必须保留人设示例');
    assert.match(readme, /\{\{user\}\}/);
    // 示例必须明确标注为「可选」「复制粘贴」，不能让人误以为默认已填
    assert.match(readme, /示例/);
    // 代码里不得带任何默认人设正文
    const core = readFileSync(new URL('../lib/core.js', import.meta.url), 'utf8');
    const settingsSrc = readFileSync(new URL('../lib/settings.js', import.meta.url), 'utf8');
    assert.equal(core.includes('{{char}}'), false, 'core.js 不得内嵌人设示例正文');
    assert.equal(settingsSrc.includes('{{char}}'), false, 'settings.js 不得内嵌人设示例正文');
});

test('公开默认配置：节点映射对齐本项目应用，但 Key 必须为空', () => {
    assert.equal(DEFAULT_SETTINGS.positiveNodeId, '1195');
    assert.equal(DEFAULT_SETTINGS.positiveFieldName, 'text');
    assert.equal(DEFAULT_SETTINGS.negativeNodeId, '1018');
    assert.equal(DEFAULT_SETTINGS.negativeFieldName, 'text');
    assert.equal(DEFAULT_SETTINGS.deepseekApiKey, '');
    assert.equal(DEFAULT_SETTINGS.rhApiKey, '');
});

test('公开默认配置：enabled 关闭、interval 为 1', () => {
    assert.equal(DEFAULT_SETTINGS.enabled, false, '默认必须是关闭状态，绝不能一装就烧额度');
    assert.equal(DEFAULT_SETTINGS.interval, 1);
});

test('默认设置不含 settingsVersion（否则旧设置会被误判成已迁移）', () => {
    assert.equal('settingsVersion' in DEFAULT_SETTINGS, false);
});

test('默认设置只差两个 API Key 就能通过配置校验', () => {
    const missing = validateSettings(DEFAULT_SETTINGS);
    assert.equal(missing.includes('正向生成模板'), false, '默认模板不应被当成缺失');
    assert.equal(missing.includes('RunningHub 应用 ID'), false, '应用 ID 默认已填当前值');
    assert.equal(missing.includes('正面提示词节点 ID'), false, '节点映射默认已填本项目应用的值');
    assert.ok(missing.includes('DeepSeek API Key'), 'Key 默认必须为空，等用户填');
    assert.ok(missing.includes('RunningHub API Key'));
    assert.deepEqual(missing.sort(), ['DeepSeek API Key', 'RunningHub API Key'].sort(), '除两个 Key 之外不应缺任何项');
});

test('默认应用 ID 是当前有效值，且不含任何分辨率字段', () => {
    assert.equal(DEFAULT_SETTINGS.rhAppId, CURRENT_RH_APP_ID);
    assert.equal(CURRENT_RH_APP_ID, '2116435600285958146');
    // 分辨率由应用工作流决定，设置项里不应存在这类字段
    for (const key of ['width', 'height', 'resolution', 'size']) {
        assert.equal(key in DEFAULT_SETTINGS, false, `设置里不应有 ${key}`);
    }
});

test('空的应用 ID 会被补成当前默认值（老版本存的是空串）', () => {
    const raw = { rhAppId: '' };
    const { settings, seeded } = resolveSettings(raw);
    assert.equal(settings.rhAppId, CURRENT_RH_APP_ID);
    assert.ok(seeded.includes('rhAppId'));
});

test('用户自己填的应用 ID 不会被默认值覆盖（含已作废的那个）', () => {
    const custom = '9999999999999999999';
    assert.equal(resolveSettings({ rhAppId: custom }).settings.rhAppId, custom);
    assert.deepEqual(resolveSettings({ rhAppId: custom }).seeded, []);
    // 旧 ID 也不覆盖：只警告，不擅自改用户配置
    const old = '2116336611532275714';
    assert.equal(resolveSettings({ rhAppId: old }).settings.rhAppId, old);
});

test('新装：补齐全部默认值并打上版本号', () => {
    const raw = {};
    const { settings, migrated } = resolveSettings(raw);
    assert.equal(migrated, true);
    assert.equal(settings.settingsVersion, SETTINGS_VERSION);
    assert.equal(settings.positiveTemplate, DEFAULT_POSITIVE_TEMPLATE);
    assert.equal(settings.characterPersona, '', '新装人设必须是空串');
    assert.equal(settings.negativePrompt, DEFAULT_NEGATIVE_PROMPT);
    assert.equal(settings.positiveNodeId, '1195');
    assert.equal(settings.negativeNodeId, '1018');
    assert.equal(settings.deepseekApiKey, '');
    assert.equal(settings.rhApiKey, '');
    // 原地修改：返回的就是传入的那个对象（与 extension_settings 共用引用）
    assert.equal(settings, raw);
});

test('已存值不会被默认值覆盖', () => {
    const raw = {
        characterPersona: '我的角色：银发，白衬衫',
        positiveTemplate: '我的自定义模板',
        negativePrompt: 'lowres, watermark',
        interval: 5,
        positiveNodeId: '777',
        positiveFieldName: 'prompt_text',
        negativeNodeId: '888',
        negativeFieldName: 'negative_text',
    };
    const { settings } = resolveSettings(raw);
    assert.equal(settings.characterPersona, '我的角色：银发，白衬衫');
    assert.equal(settings.positiveTemplate, '我的自定义模板');
    assert.equal(settings.negativePrompt, 'lowres, watermark');
    assert.equal(settings.interval, 5);
    // 节点映射同样不许被新默认值顶掉（换过应用的人靠这几项活着）
    assert.equal(settings.positiveNodeId, '777');
    assert.equal(settings.positiveFieldName, 'prompt_text');
    assert.equal(settings.negativeNodeId, '888');
    assert.equal(settings.negativeFieldName, 'negative_text');
});

test('已存空值不会被新默认值偷偷写满（除 rhAppId 这一项外）', () => {
    // 刻意留空的用户值：老版本里「空 = 不填」，新版本不能替他做主
    const raw = { positiveNodeId: '', positiveFieldName: '', negativeNodeId: '', negativeFieldName: '' };
    const { settings } = resolveSettings(raw);
    assert.equal(settings.positiveNodeId, '', '空字符串是用户的选择，不覆盖');
    assert.equal(settings.positiveFieldName, '');
    assert.equal(settings.negativeNodeId, '');
    assert.equal(settings.negativeFieldName, '');
    // 唯一例外：rhAppId 空串会被补成当前默认值（老版本默认就是空串，不补则永远到不了界面）
    assert.equal(settings.rhAppId, CURRENT_RH_APP_ID);
});

test('保存语义：三项写入后能被完整读回（含换行的多行文本）', () => {
    const raw = {};
    resolveSettings(raw);
    const persona = '第一行人设\n第二行人设\n\n第四行';
    const template = '要求一\n要求二\n要求三';
    const negative = 'lowres,\nbad anatomy\nwatermark';
    raw.characterPersona = persona;
    raw.positiveTemplate = template;
    raw.negativePrompt = negative;

    // 再解析一次（模拟重新加载扩展设置）
    const { settings, migrated } = resolveSettings(raw);
    assert.equal(migrated, false, '第二次不应再迁移');
    assert.equal(settings.characterPersona, persona);
    assert.equal(settings.positiveTemplate, template);
    assert.equal(settings.negativePrompt, negative);
});

test('旧设置迁移：正/负前缀搬到 legacy，三项新字段不被猜测填充', () => {
    const raw = { positivePrefix: 'masterpiece, best quality', negativePrefix: 'lowres' };
    const { settings, migrated, preserved } = resolveSettings(raw);
    assert.equal(migrated, true);
    assert.deepEqual(preserved.sort(), ['legacyNegativePrefix', 'legacyPositivePrefix']);
    assert.equal(settings.legacyPositivePrefix, 'masterpiece, best quality');
    assert.equal(settings.legacyNegativePrefix, 'lowres');
    // 不猜测：新字段保持各自默认值，绝不把旧前缀塞进模板或负面词
    assert.equal(settings.positiveTemplate, DEFAULT_POSITIVE_TEMPLATE);
    assert.equal(settings.characterPersona, '', '迁移不得凭空给人设填内容');
    assert.equal(settings.negativePrompt, DEFAULT_NEGATIVE_PROMPT);
    assert.notEqual(settings.positiveTemplate, 'masterpiece, best quality');
    assert.notEqual(settings.negativePrompt, 'lowres');
    // 旧键必须消失，杜绝「界面看不见但仍在生效」
    assert.equal('positivePrefix' in settings, false);
    assert.equal('negativePrefix' in settings, false);
});

test('旧设置迁移：空前缀不制造 legacy 内容', () => {
    const raw = { positivePrefix: '', negativePrefix: '   ' };
    const { settings, preserved } = resolveSettings(raw);
    assert.deepEqual(preserved, []);
    assert.equal(settings.legacyPositivePrefix, '');
    assert.equal(settings.legacyNegativePrefix, '');
});

test('旧设置迁移：重复解析保持幂等，不覆盖用户后来编辑的 legacy 值', () => {
    const raw = { positivePrefix: 'OLD', negativePrefix: 'OLDNEG' };
    resolveSettings(raw);
    raw.legacyPositivePrefix = 'USER_EDITED';
    const { settings, migrated } = resolveSettings(raw);
    assert.equal(migrated, false);
    assert.equal(settings.legacyPositivePrefix, 'USER_EDITED');
    assert.equal(settings.legacyNegativePrefix, 'OLDNEG');
});
