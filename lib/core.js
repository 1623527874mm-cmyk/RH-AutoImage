// core.js — 纯逻辑层。不 import 任何酒馆模块，可在 node 下直接单测。
// 覆盖：楼层计数、触发判定、提示词拼接与解析、RunningHub 状态归一化、图片结果筛选。

export const MAX_PROMPT_LEN = 4000;
/** 三个输入各自的上限：超过一律拒绝本次调用，绝不静默截断。 */
export const MAX_PERSONA_LEN = 4000;
export const MAX_TEMPLATE_LEN = 4000;
export const MAX_REPLY_LEN = 8000;
/** 设置结构版本。旧版只有 positivePrefix / negativePrefix。 */
export const SETTINGS_VERSION = 2;

/**
 * 正向关键词生成模板的默认值。
 * 刻意做成**用户可见、可编辑**的文本，而不是藏在代码里的隐形提示词：
 * 质量词、视角、定格规则全部写在这段模板里。
 */
export const DEFAULT_POSITIVE_TEMPLATE = [
    '把下面的「角色人设关键词」和「本次回复正文」当作参考资料，输出一条可用于文生图的正向英文关键词。',
    '',
    '硬性要求：',
    '1. 只输出一行英文标签，全部小写（评分词如 score_9 除外），用英文逗号分隔；不要编号、不要解释、不要 JSON、不要代码块。',
    '2. 一张图只定格「一秒」——选这段回复里最后能停住的静止瞬间，不要试图表现动态过程。',
    '3. 视角固定为男主第一人称 POV；写 pov，且不要描写观看者自己的身体部位，用 one hand reaching down out of frame 这类写法代替。',
    '4. 只写参考资料里确实出现过的要素。衣服不能凭空编造，宁可少写；环境可以在合理范围内补充。',
    '5. 不写负面词、不写画风词、不写画面文字。',
    '6. 质量词固定放在最前面：masterpiece, best quality, highly detailed',
    '',
    '如果参考资料不足，就按能看到的内容尽量少写，不要编。',
].join('\n');

/**
 * 默认固定负面词（随公开仓库发布，属于**非密钥公开配置**）。
 * 只提交给 RunningHub 负面节点，永不送 DeepSeek。
 */
export const DEFAULT_NEGATIVE_PROMPT = 'worst quality, low quality, score_1, score_2, score_3, artist name, simple background, lowres, (bad), text, error, fewer, extra, missing, worst quality, jpeg artifacts, low quality, watermark, unfinished, displeasing, oldest, early, signature, artistic error, username, scan, [abstract], english text, shiny hair, extra toes';

/** 该楼层是否算作「AI 回复」（用户消息、系统消息不计）。 */
export function isAiMessage(msg) {
    return !!msg && !msg.is_user && !msg.is_system;
}

/** 统计 chat[0..index] 区间内的 AI 回复条数（含 index）。越界返回 -1。 */
export function countAiUpTo(chat, index) {
    if (!Array.isArray(chat) || !Number.isInteger(index) || index < 0 || index >= chat.length) {
        return -1;
    }
    let n = 0;
    for (let i = 0; i <= index; i++) {
        if (isAiMessage(chat[i])) n++;
    }
    return n;
}

/** 当前聊天里 AI 回复的总数。 */
export function countAiMessages(chat) {
    if (!Array.isArray(chat)) return 0;
    return chat.reduce((n, m) => n + (isAiMessage(m) ? 1 : 0), 0);
}

/** 间隔 N 是否命中：第 N、2N、3N…… 条 AI 回复触发。N 非法时永不触发。 */
export function shouldTrigger(aiCount, interval) {
    const n = Math.trunc(Number(interval));
    if (!Number.isFinite(n) || n < 1) return false;
    if (!Number.isInteger(aiCount) || aiCount < 1) return false;
    return aiCount % n === 0;
}

/**
 * 正文的稳定指纹：长度 + djb2 哈希。
 * 用途只有一个 —— 判断「楼层内容是否还是同一条」，与任务状态、去重无关。
 */
export function hashText(text) {
    const s = String(text ?? '');
    let h = 5381;
    for (let i = 0; i < s.length; i++) {
        h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    }
    return `${s.length}:${(h >>> 0).toString(36)}`;
}

/** 是否已有酒馆原生的图片媒体条目（只读判断，不写任何东西）。 */
export function hasGeneratedMedia(msg) {
    const media = msg?.extra?.media;
    return Array.isArray(media) && media.length > 0;
}

/**
 * 该楼层此刻是否具备「触发候选」资格（尚未涉及 DOM 与正文内容）。
 * 只做结构判断：必须是最末一条、非用户/系统、当前 swipe 为第 0 条。
 */
export function isTriggerableMessage(msg, mesId, chatLength) {
    if (!msg || typeof msg !== 'object') return false;
    if (!Number.isInteger(mesId) || mesId < 0) return false;
    if (!Number.isInteger(chatLength) || chatLength <= 0) return false;
    if (mesId !== chatLength - 1) return false;
    if (msg.is_user) return false;
    if (msg.is_system) return false;
    if (Number(msg.swipe_id ?? 0) !== 0) return false;
    return isAiMessage(msg);
}

/**
 * 渲染后正文的最小规范化。只做三件事，不删除、不改写任何可见内容：
 *   1) \r\n → \n
 *   2) \r   → \n
 *   3) trim()
 * 刻意不压缩连续空行、不去段落、不动空白以外的字符。
 */
export function normalizeRenderedText(raw) {
    if (typeof raw !== 'string') return '';
    return raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
}

/**
 * 三个输入的长度检查。只返回字段名/长度/上限，**不携带任何原文**，便于安全地放进错误提示。
 * @returns {Array<{field: string, length: number, max: number}>}
 */
export function checkInputLimits({ persona, template, reply } = {}) {
    const problems = [];
    const check = (field, value, max) => {
        const length = String(value ?? '').length;
        if (length > max) problems.push({ field, length, max });
    };
    check('角色人设关键词', persona, MAX_PERSONA_LEN);
    check('正向生成模板', template, MAX_TEMPLATE_LEN);
    check('回复正文', reply, MAX_REPLY_LEN);
    return problems;
}

/** 把长度问题描述成一句提示，不含任何原文。 */
export function describeInputProblems(problems) {
    if (!Array.isArray(problems) || problems.length === 0) return '';
    return problems.map(p => `${p.field} ${p.length} 字符，超过上限 ${p.max}`).join('；');
}

/** 请求正文的三个分节标题。固定不变，便于测试与用户对照。 */
export const PROMPT_SECTION = Object.freeze({
    TEMPLATE: '【生成要求】',
    PERSONA: '【角色人设关键词】',
    REPLY: '【本次回复正文】',
});

/**
 * 拼出 DeepSeek 请求里的 user content：模板 + 人设 + 正文，三段带标题分隔。
 * 纯字符串拼接，不做任何截断与清洗——长度由 checkInputLimits 单独把关。
 */
export function buildPromptUserContent({ template, persona, reply } = {}) {
    return [
        PROMPT_SECTION.TEMPLATE,
        String(template ?? '').trim(),
        '',
        PROMPT_SECTION.PERSONA,
        String(persona ?? '').trim() || '（未填写）',
        '',
        PROMPT_SECTION.REPLY,
        String(reply ?? '').trim(),
    ].join('\n');
}

/**
 * 旧设置迁移。
 * 旧版只有 positivePrefix（正面前缀）与 negativePrefix（负面前缀），新版是
 * characterPersona / positiveTemplate / negativePrompt 三项，语义不能一一对应，
 * 所以**不做猜测性映射**：只把旧值原样搬到 legacyPositivePrefix / legacyNegativePrefix
 * 供界面显式展示，旧键删除，绝不参与任何拼接。
 * 幂等：settingsVersion 已是新版本时直接返回，不覆盖任何已有值。
 */
export function migrateSettings(s) {
    const src = (s && typeof s === 'object') ? s : {};
    const version = Number(src.settingsVersion ?? 0) || 0;
    if (version >= SETTINGS_VERSION) {
        return { migrated: false, from: version, to: version, preserved: [], removed: [] };
    }
    const preserved = [];
    const removed = [];
    const moveToLegacy = (from, to) => {
        if (!(from in src)) return;
        const value = src[from];
        if (typeof value === 'string' && value.trim()) {
            // 目标已有内容时不覆盖，避免把用户后来手动填的值冲掉
            if (!String(src[to] ?? '').trim()) src[to] = value;
            preserved.push(to);
        }
        delete src[from];
        removed.push(from);
    };
    moveToLegacy('positivePrefix', 'legacyPositivePrefix');
    moveToLegacy('negativePrefix', 'legacyNegativePrefix');
    // 两个 legacy 字段始终存在（就算旧值为空），界面判断更简单
    if (typeof src.legacyPositivePrefix !== 'string') src.legacyPositivePrefix = '';
    if (typeof src.legacyNegativePrefix !== 'string') src.legacyNegativePrefix = '';
    src.settingsVersion = SETTINGS_VERSION;
    return { migrated: true, from: version, to: SETTINGS_VERSION, preserved, removed };
}

/**
 * 当前上下文是否属于本阶段支持的聊天类型。
 * getContext().groupId === selected_group（group-chats.js），单人聊天为 null/undefined。
 * v1 只支持单人聊天：群聊里 regenerate 会被 group-chats.js 提前归一成 'normal'，
 * 意图闸无法区分，所以直接不触发，而不是用启发式去猜。
 */
export function isSupportedChat(context) {
    if (!context || typeof context !== 'object') return false;
    if (context.groupId) return false;
    return true;
}

/** 从文本中剥掉 Markdown 围栏。 */
export function stripCodeFence(text) {
    let s = String(text ?? '').trim();
    const fence = /^```[a-zA-Z]*\s*\n?([\s\S]*?)\n?```$/;
    const m = s.match(fence);
    if (m) s = m[1].trim();
    return s;
}

/** 从自由文本里抠出第一个平衡的 JSON 对象。失败返回 null。 */
export function extractJsonObject(text) {
    const s = stripCodeFence(text);
    const start = s.indexOf('{');
    if (start < 0) return null;
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = start; i < s.length; i++) {
        const ch = s[i];
        if (inStr) {
            if (esc) { esc = false; }
            else if (ch === '\\') { esc = true; }
            else if (ch === '"') { inStr = false; }
            continue;
        }
        if (ch === '"') { inStr = true; continue; }
        if (ch === '{') depth++;
        else if (ch === '}') {
            depth--;
            if (depth === 0) return s.slice(start, i + 1);
        }
    }
    return null;
}

/** 模型把负面提示词塞进同一条回复时，用这个粗筛拦住（结构化标号，不猜内容）。 */
const LABELED_NEGATIVE = /(^|\n)\s*(negative\s*prompt|negative|负面提示词|负面关键词|负面)\s*[:：]/i;
/** 以标签开头（"Positive prompt: ..."）同样是「不止一条提示词」的信号。 */
const LEADING_LABEL = /^\s*(positive\s*prompt|positive|正面提示词|正向提示词|正向关键词)\s*[:：]/i;

/**
 * 解析 DeepSeek 返回内容：只做「必要的结构检查 + 首尾空白处理」。
 *
 * 刻意**不做**的事（本阶段的硬性要求）：
 * - 不按逗号切分重组，不合并多行，不收敛内部空白 —— 输出风格完全交给用户可编辑模板决定，
 *   模型写成什么样就原样提交，避免插件擅自改写有效提示词。
 * - 不静默截断超长结果，直接报错。
 *
 * 只在「结构不合规」时抛错：空内容、Markdown 代码块、JSON、带负面段落、带前缀标签、超长。
 * @returns {string} 去掉首尾空白后的正向提示词
 */
export function parsePositivePrompt(text) {
    if (typeof text !== 'string' || !text.trim()) throw new Error('模型返回为空');

    // 只统一换行符 + 去掉首尾空白，内部格式一字不改
    const s = text.replace(/\r\n?/g, '\n').trim();
    if (!s) throw new Error('模型返回为空');

    if (s.includes('```')) {
        throw new Error('模型返回了 Markdown 代码块，不符合「只返回一条正向提示词」的约定');
    }
    if (s.startsWith('{') || s.startsWith('[')) {
        let isJson = false;
        try {
            JSON.parse(s);
            isJson = true;
        } catch { /* 不是合法 JSON，按普通文本处理 */ }
        if (isJson) throw new Error('模型返回了 JSON，不符合「只返回一条正向提示词」的约定');
    }
    if (LABELED_NEGATIVE.test(s)) {
        throw new Error('模型返回里带有负面提示词段落，不符合「只返回一条正向提示词」的约定');
    }
    if (LEADING_LABEL.test(s)) {
        throw new Error('模型返回带有「正面提示词：」之类的标签，不符合「只返回一条正向提示词」的约定');
    }
    if (s.length > MAX_PROMPT_LEN) {
        throw new Error(`模型返回的正向关键词过长（${s.length} 字符，上限 ${MAX_PROMPT_LEN}）`);
    }
    return s;
}

/** 按字符数截断，超长时保留头部并加省略标记由调用方决定是否提示。 */
export function clampText(text, max) {
    const s = String(text ?? '').trim();
    if (!Number.isFinite(max) || max <= 0) return s;
    return s.length <= max ? s : s.slice(0, max);
}

/**
 * 脱敏：抹掉调用方声明的敏感原文（Key、人设、模板、正向词、负面词、正文）
 * 以及常见的 Bearer / sk- / rh- 痕迹。长串优先替换，避免短串先替换破坏长串匹配。
 *
 * 放在 core 里是因为 api 与 jobs 两层都要用：错误信息无论从哪一层冒出来都不允许带原文。
 */
export function redact(text, secrets = []) {
    let msg = String(text ?? '');
    const list = (Array.isArray(secrets) ? secrets : [])
        .filter(x => typeof x === 'string' && x.trim().length >= 4)
        .sort((a, b) => b.length - a.length);
    for (const secret of list) msg = msg.split(secret).join('***');
    msg = msg.replace(/Bearer\s+[A-Za-z0-9._\-]+/gi, 'Bearer ***');
    msg = msg.replace(/\bsk-[A-Za-z0-9._\-]{6,}/g, 'sk-***');
    msg = msg.replace(/\brh-[A-Za-z0-9._\-]{6,}/g, 'rh-***');
    return msg;
}

/** 取第一个非空字符串（用于在多种响应字段名之间兜底）。 */
function firstText(...values) {
    for (const v of values) {
        if (v === undefined || v === null) continue;
        const s = String(v).trim();
        if (s) return s;
    }
    return '';
}

/** RunningHub 的 code 可能是数字、数字字符串，或 'SUCCESS' 这类文本。 */
function isOkCode(code) {
    if (code === undefined || code === null) return true;
    const s = String(code).trim();
    if (!s) return true;
    const n = Number(s);
    if (Number.isFinite(n)) return n === 0;
    return ['SUCCESS', 'OK', 'TRUE'].includes(s.toUpperCase());
}

/**
 * 归一化 RunningHub 提交/查询响应（兼容 data 包裹与扁平两种形态）。
 *
 * 明确识别这些失败信号：
 *   · code / errorCode 非 0
 *   · success === false
 *   · errorMessage / msg / message / failedReason 有内容（仅在 code 失败或状态失败时作为原因）
 *
 * **刻意不保留原始响应体**：一旦留了 raw，任何一处日志或错误都可能把整个 body 打出去。
 * 调用方只能拿到下面这几个已收窄的字段。
 */
export function normalizeRhResponse(payload) {
    const body = (payload && typeof payload === 'object') ? payload : {};
    const data = (body.data && typeof body.data === 'object' && !Array.isArray(body.data)) ? body.data : body;

    const code = body.code ?? data.code;
    const errorCode = firstText(body.errorCode, body.error_code, data.errorCode, data.error_code);
    const errorMessage = firstText(body.errorMessage, body.error_message, data.errorMessage, data.error_message);
    const failedReason = firstText(data.failedReason, data.failed_reason, body.failedReason, body.failed_reason);
    const message = firstText(
        body.msg, body.message, data.msg, data.message,
        errorMessage, failedReason,
    );

    const taskId = data.taskId ?? data.task_id ?? body.taskId ?? '';
    const statusRaw = data.taskStatus ?? data.task_status ?? data.status ?? body.status ?? '';
    const results = Array.isArray(data.results) ? data.results
        : Array.isArray(body.results) ? body.results
            : Array.isArray(data.taskOutputs) ? data.taskOutputs
                : Array.isArray(data.outputs) ? data.outputs
                    : [];

    const codeOk = isOkCode(code);
    const errorCodeOk = !errorCode || isOkCode(errorCode);
    const flagOk = body.success !== false && data.success !== false;
    const ok = codeOk && errorCodeOk && flagOk;

    return {
        ok,
        code,
        errorCode,
        message,
        failedReason,
        taskId: String(taskId ?? ''),
        status: normalizeStatus(statusRaw),
        results,
    };
}

/** 状态归一化到 QUEUED / RUNNING / SUCCESS / FAILED / UNKNOWN。 */
export function normalizeStatus(status) {
    const s = String(status ?? '').trim().toUpperCase();
    if (!s) return 'UNKNOWN';
    if (['SUCCESS', 'SUCCEEDED', 'SUCCESSFUL', 'COMPLETED', 'FINISHED'].includes(s)) return 'SUCCESS';
    if (['FAILED', 'FAIL', 'ERROR', 'CANCELED', 'CANCELLED'].includes(s)) return 'FAILED';
    if (['QUEUED', 'PENDING', 'WAITING', 'CREATE', 'CREATED', 'QUEUING'].includes(s)) return 'QUEUED';
    if (['RUNNING', 'PROCESSING', 'EXECUTING', 'IN_PROGRESS'].includes(s)) return 'RUNNING';
    return 'UNKNOWN';
}

const IMAGE_EXT = /\.(png|jpe?g|webp|gif|avif|bmp)(\?|#|$)/i;

/** 从 results 里挑出图片 URL（不假设只有一张、不假设只有 png）。 */
export function pickImageUrls(results) {
    if (!Array.isArray(results)) return [];
    const urls = [];
    for (const item of results) {
        if (!item) continue;
        if (typeof item === 'string') {
            if (IMAGE_EXT.test(item)) urls.push(item);
            continue;
        }
        const type = String(item.outputType ?? item.type ?? '').toLowerCase();
        const url = String(item.url ?? item.fileUrl ?? item.file_url ?? '');
        if (!url) continue;
        const isImageByType = type.includes('image') || type === 'png' || type === 'jpg';
        if (isImageByType || IMAGE_EXT.test(url)) urls.push(url);
    }
    return [...new Set(urls)];
}

/** results 里是否有非图片输出（比如 txt），用于给出更清楚的错误。 */
export function describeEmptyResults(results) {
    if (!Array.isArray(results) || results.length === 0) return '任务成功但没有返回任何结果';
    const types = results
        .map(r => String(r?.outputType ?? r?.type ?? '').trim())
        .filter(Boolean);
    return types.length
        ? `任务成功但没有图片结果（返回类型：${[...new Set(types)].join(', ')}）`
        : '任务成功但没有可识别的图片链接';
}

/** 由 base64/mime/url 推断图片格式，兜底 png。 */
export function guessImageFormat(mimeType, url) {
    const mime = String(mimeType ?? '').toLowerCase();
    if (mime.includes('jpeg') || mime.includes('jpg')) return 'jpg';
    if (mime.includes('webp')) return 'webp';
    if (mime.includes('gif')) return 'gif';
    if (mime.includes('png')) return 'png';
    const m = String(url ?? '').match(IMAGE_EXT);
    if (m) {
        const ext = m[1].toLowerCase();
        return ext === 'jpeg' ? 'jpg' : ext;
    }
    return 'png';
}

/**
 * 组装真正提交给 RunningHub 的正/负值。
 * 正：只用 DeepSeek 返回的那一条关键词，不拼任何前缀；
 * 负：只用用户设定的固定负面词，不受模型输出影响（模型根本不生成负面）。
 * 集中在这里是为了让「负面不经过模型」这个契约可被单测盯住。
 */
export function assembleRhValues({ positive, settings } = {}) {
    return {
        positiveValue: String(positive ?? '').trim(),
        negativeValue: String(settings?.negativePrompt ?? '').trim(),
    };
}

/** 构造 RunningHub 提交请求体：只带用户配置的节点，不动工作流其它参数。 */
export function buildRhPayload({ positiveValue, negativeValue, positiveNode, positiveField, negativeNode, negativeField, extraNodes }) {
    const nodeInfoList = [];
    if (positiveNode && positiveField) {
        nodeInfoList.push({ nodeId: String(positiveNode), fieldName: String(positiveField), fieldValue: String(positiveValue ?? '') });
    }
    if (negativeNode && negativeField && String(negativeValue ?? '').trim()) {
        nodeInfoList.push({ nodeId: String(negativeNode), fieldName: String(negativeField), fieldValue: String(negativeValue ?? '') });
    }
    if (Array.isArray(extraNodes)) {
        for (const item of extraNodes) {
            if (item && item.nodeId != null && item.fieldName) {
                nodeInfoList.push({ nodeId: String(item.nodeId), fieldName: String(item.fieldName), fieldValue: String(item.fieldValue ?? '') });
            }
        }
    }
    return { nodeInfoList, instanceType: 'default', usePersonalQueue: 'false' };
}

/** 解析「额外节点」JSON 文本，返回数组；空文本返回 []。 */
export function parseExtraNodes(text) {
    const s = String(text ?? '').trim();
    if (!s) return [];
    let data;
    try {
        data = JSON.parse(s);
    } catch {
        throw new Error('附加节点不是合法 JSON');
    }
    if (!Array.isArray(data)) throw new Error('附加节点必须是数组');
    return data.filter(x => x && x.nodeId != null && typeof x.fieldName === 'string' && x.fieldName);
}

/**
 * 当前的 RunningHub 应用 ID。只作为「默认值」给新装/空值用，不覆盖用户已填的值，
 * 也不参与任何节点映射（nodeId / fieldName 一律以设置为准）。
 * 输出分辨率（4:3 / 1280×960）由该应用的工作流决定，插件永不传 width / height / resolution。
 */
export const CURRENT_RH_APP_ID = '2116435600285958146';

/** 已作废、不该再用的应用 ID。命中只警告，不改用户设置。 */
export const DEPRECATED_RH_APP_IDS = Object.freeze(['2116336611532275714']);

/**
 * 检查「看起来还在用旧配置」的软性问题。只返回可读提示，不阻塞任何流程。
 * @returns {string[]} 空数组表示没有可疑配置
 */
export function checkDeprecatedSettings(s) {
    const warnings = [];
    const appId = String(s?.rhAppId ?? '').trim();
    if (appId && DEPRECATED_RH_APP_IDS.includes(appId)) {
        warnings.push(`RunningHub 应用 ID ${appId} 已作废（应用已重置），请改用 ${CURRENT_RH_APP_ID}`);
    }
    return warnings;
}

/** 校验设置是否具备生图条件，返回缺失项数组。 */
export function validateSettings(s) {
    const missing = [];
    if (!String(s?.deepseekBaseUrl ?? '').trim()) missing.push('DeepSeek API 地址');
    if (!String(s?.deepseekApiKey ?? '').trim()) missing.push('DeepSeek API Key');
    if (!String(s?.deepseekModel ?? '').trim()) missing.push('DeepSeek 模型名');
    if (!String(s?.positiveTemplate ?? '').trim()) missing.push('正向生成模板');
    if (!String(s?.rhApiKey ?? '').trim()) missing.push('RunningHub API Key');
    if (!String(s?.rhAppId ?? '').trim()) missing.push('RunningHub 应用 ID');
    if (!String(s?.positiveNodeId ?? '').trim()) missing.push('正面提示词节点 ID');
    if (!String(s?.positiveFieldName ?? '').trim()) missing.push('正面提示词字段名');
    return missing;
}

/**
 * 软性配置提示（不阻塞生图，只提醒）：
 * 正面字段名仍是历史默认值 `prompt`，而本项目默认应用记录里是 `text` 时，
 * 提醒用户按自己应用的 workflow 确认一次。
 * **只读判断，绝不改写用户已保存的值** —— 字段名属于应用工作流，插件无权猜。
 * @returns {string[]}
 */
export function checkFieldNameHints(s) {
    const hints = [];
    const appId = String(s?.rhAppId ?? '').trim();
    const field = String(s?.positiveFieldName ?? '').trim();
    if (appId === CURRENT_RH_APP_ID && field.toLowerCase() === 'prompt') {
        hints.push(`正面字段名填的是 prompt；本项目所用应用记录为 text，请按你的工作流确认`);
    }
    return hints;
}

/** 生成一个短的任务 ID（不用于安全场景）。 */
export function newJobId() {
    return `rh_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
