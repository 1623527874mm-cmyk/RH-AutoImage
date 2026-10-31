// settings.js — 设置默认值与结构迁移。纯逻辑，不 import 酒馆模块，可在 node 下直接单测。
// index.js 只负责把它接到 extension_settings 与界面上。

import {
    CURRENT_RH_APP_ID, DEFAULT_POSITIVE_TEMPLATE, DEFAULT_NEGATIVE_PROMPT,
    migrateSettings, SETTINGS_VERSION,
} from './core.js';

/**
 * 全部设置项的默认值。
 * 注意：**不包含** settingsVersion —— 它由 migrateSettings 写入，
 * 若放进默认值会让「旧设置」被误判成已迁移，从而丢掉旧前缀。
 */
export const DEFAULT_SETTINGS = Object.freeze({
    enabled: false,
    interval: 1,

    deepseekBaseUrl: 'https://api.deepseek.com',
    deepseekApiKey: '',
    deepseekModel: 'deepseek-chat',
    deepseekTemperature: 0.3,
    deepseekMaxTokens: 600,

    // 三个独立输入项（都是用户可见、可编辑的纯文本，插件不自动读写角色卡）。
    // 人设**刻意留空**：它由用户自己决定，README 里给了一段可选示例供复制粘贴。
    // 模板与固定负面词是通用内容，随公开仓库发布，朋友装完即可用。
    characterPersona: '',
    positiveTemplate: DEFAULT_POSITIVE_TEMPLATE,
    // 固定负面词：只进 RunningHub 负面节点，从不进 DeepSeek
    negativePrompt: DEFAULT_NEGATIVE_PROMPT,

    // 旧版 positivePrefix / negativePrefix 的原文搬运目标，只用于界面展示，不参与任何拼接
    legacyPositivePrefix: '',
    legacyNegativePrefix: '',

    rhBaseUrl: 'https://www.runninghub.ai',
    rhApiKey: '',
    rhAppId: CURRENT_RH_APP_ID,
    // 节点映射：默认值对齐「本项目所用 RunningHub 应用」的实际工作流（1195/1018，字段名 text）。
    // 换了自己的应用就要照着自己的工作流改，填错会 NODE_INFO_MISMATCH。
    positiveNodeId: '1195',
    positiveFieldName: 'text',
    negativeNodeId: '1018',
    negativeFieldName: 'text',
    extraNodesJson: '',

    pollIntervalMs: 5000,
    pollTimeoutMs: 600000,
    requestTimeoutMs: 60000,
    maxPendingJobs: 5,
});

/** 三个新输入项的 key，供界面与测试共用。 */
export const PROMPT_INPUT_KEYS = Object.freeze(['characterPersona', 'positiveTemplate', 'negativePrompt']);

/**
 * 这些键在「空字符串」时也补默认值。
 * 只给 rhAppId 用：老版本默认就是空串，若只按 undefined 补，升级后仍然是空，
 * 新应用 ID 永远到不了界面。用户换自己的 ID 时非空，不会被覆盖。
 */
const SEED_WHEN_BLANK = Object.freeze(['rhAppId']);

/**
 * 补齐默认值 + 执行一次迁移。会**原地修改**传入对象（与 extension_settings 共用引用），
 * 返回迁移结果，便于调用方决定是否持久化。
 * @param {object} raw extension_settings[MODULE_NAME]
 */
export function resolveSettings(raw) {
    const settings = (raw && typeof raw === 'object') ? raw : {};
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
        if (settings[key] === undefined) settings[key] = value;
    }
    const seeded = [];
    for (const key of SEED_WHEN_BLANK) {
        if (String(settings[key] ?? '').trim() === '') {
            settings[key] = DEFAULT_SETTINGS[key];
            seeded.push(key);
        }
    }
    const migration = migrateSettings(settings);
    return { settings, seeded, ...migration };
}

export { SETTINGS_VERSION };
