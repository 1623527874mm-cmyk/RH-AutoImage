// index.js — RH 定时生图 扩展入口
// 职责：按 AI 回复楼层计数 → 触发 → DeepSeek 生成正向关键词 → RunningHub 生成 → 图片挂回触发楼层。
// 只用公开 API / 事件；不修改酒馆核心；不依赖正则触发。

import { eventSource, event_types, saveSettingsDebounced, saveChatConditional, updateMessageBlock } from '/script.js';
import { extension_settings, getContext } from '/scripts/extensions.js';
import { MEDIA_TYPE, MEDIA_SOURCE } from '/scripts/constants.js';
import { saveBase64AsFile } from '/scripts/utils.js';
import {
    countAiUpTo, shouldTrigger, isAiMessage, hashText, hasGeneratedMedia,
    guessImageFormat, buildRhPayload, parseExtraNodes, validateSettings, newJobId,
    normalizeRenderedText, isSupportedChat, checkDeprecatedSettings, checkFieldNameHints,
    CURRENT_RH_APP_ID,
} from './lib/core.js';
import { resolveSettings } from './lib/settings.js';
import { createApi, safeError } from './lib/api.js';
import { createTriggerController } from './lib/trigger.js';
import {
    createJobStore, chatRefKey, planAttach, applyMediaEntry, runImageJob,
} from './lib/jobs.js';

const MODULE_NAME = 'rh_autoimage';
const VERSION = '0.4.0';
const LOG_PREFIX = '[RH-AutoImage]';

/** @type {Map<string, {controller: AbortController, cancelled: boolean}>} */
const inflight = new Map();

/** 旧配置警告只提醒一次，避免每次触发都弹。 */
let deprecatedWarned = false;

/**
 * 软性提示：还在用已作废的应用 ID 时提醒一次。
 * 只提示，不改设置、不阻塞生图（用户可能故意在测别的应用）。
 */
function warnDeprecatedOnce(s) {
    if (deprecatedWarned) return;
    const warnings = checkDeprecatedSettings(s);
    if (!warnings.length) return;
    deprecatedWarned = true;
    for (const w of warnings) warnf(w);
    toast('warning', warnings[0]);
}

function settings() {
    if (!extension_settings[MODULE_NAME]) extension_settings[MODULE_NAME] = {};
    // 补默认值 + 旧版正/负前缀迁移（只搬家不猜测，详见 core.migrateSettings）
    const r = resolveSettings(extension_settings[MODULE_NAME]);
    if (r.migrated || r.seeded?.length) {
        saveSettingsDebounced();
        if (r.preserved.length) logf('旧版前缀已保留并在设置里展示，不会自动拼入提示词');
        if (r.seeded?.includes('rhAppId')) logf('应用 ID 原为空，已填入当前默认值', CURRENT_RH_APP_ID);
    }
    return r.settings;
}

// ───────────────────────── 基础工具 ─────────────────────────

function logf(...args) {
    console.log(LOG_PREFIX, ...args);
}

function warnf(...args) {
    console.warn(LOG_PREFIX, ...args);
}

function toast(level, message) {
    try {
        globalThis.toastr?.[level]?.(message);
    } catch { /* 忽略 */ }
}

// ───────────────────────── 聊天标识 ─────────────────────────

function currentChatRef() {
    const ctx = getContext();
    if (ctx.groupId) {
        return {
            key: `group:${ctx.groupId}`,
            isGroup: true,
            chatId: ctx.chatId,
            groupId: String(ctx.groupId),
            avatarUrl: '',
        };
    }
    const chid = ctx.characterId;
    const character = (chid !== undefined && chid !== null) ? ctx.characters?.[chid] : null;
    if (!character) return null;
    return {
        key: `char:${character.avatar}:${ctx.chatId ?? ''}`,
        isGroup: false,
        chatId: ctx.chatId,
        avatarUrl: character.avatar,
        characterName: character.name,
    };
}

// ───────────────────────── 任务状态与写回 ─────────────────────────

/**
 * 运行时任务表：状态 / taskId / 错误 / 去重标记全在这里，**只有内存，绝不写进 message.extra**。
 * 刷新页面后运行中的状态会消失，这是本阶段的明确要求。
 */
const jobStore = createJobStore();

/** 当前聊天的稳定标识；取不到就返回空串（空串永远不等于任何 job.refKey）。 */
function currentChatRefKey() {
    return chatRefKey(currentChatRef());
}

/**
 * 把图片挂到目标楼层。写回前用 planAttach 做唯一一次判定：
 * 必须是「当前聊天 + 同一楼层 + 原文未变」，否则丢弃结果，绝不后台写别的聊天。
 * @returns {Promise<{applied: boolean, reason?: string}>}
 */
async function attachMedia(job, mediaEntry) {
    const plan = planAttach({
        job,
        activeRefKey: currentChatRefKey(),
        chat: getContext().chat,
    });
    if (!plan.ok) {
        logf('丢弃生图结果', plan.reason);
        return { applied: false, reason: plan.reason };
    }
    applyMediaEntry(plan.msg, mediaEntry);
    return { applied: true, index: plan.index };
}

/** 挂图后的重绘（纯 DOM，不落盘）。 */
function repaintJob(job) {
    const ctx = getContext();
    if (chatRefKey(currentChatRef()) !== job.refKey) return;
    const msg = ctx.chat?.[job.mesIndex];
    if (!msg) return;
    try {
        updateMessageBlock(job.mesIndex, msg);
    } catch (err) {
        warnf('重绘楼层失败', safeError(err));
    }
}

/** 存盘走酒馆自己的保存流程（saveChatConditional 内部已带重入保护）。 */
async function saveChatAfterAttach() {
    await saveChatConditional();
}

// ───────────────────────── 网络层 ─────────────────────────

const api = createApi();

// ───────────────────────── 图片保存 ─────────────────────────

async function downloadAndSaveImage(url, characterName) {
    const { mime, buffer } = await api.downloadImage(url, 120000);
    const format = guessImageFormat(mime, url);
    if (buffer.byteLength === 0) throw new Error('下载到的图片为空');
    if (buffer.byteLength > 30 * 1024 * 1024) throw new Error('图片过大（>30MB），已放弃保存');
    const base64 = arrayBufferToBase64(buffer);
    const fileName = `rh_${Date.now()}`;
    const path = await saveBase64AsFile(base64, characterName || 'rh_images', fileName, format);
    if (!path) throw new Error('图片保存到酒馆目录失败');
    return path;
}

function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
}

// ───────────────────────── 状态渲染 ─────────────────────────

/**
 * 状态角标只反映**内存里**的任务状态，刷新即消失（本阶段要求：状态不落盘）。
 * 挂图成功后楼层本来就有图片，用户不需要角标来回忆。
 */
const STATUS_TEXT = {
    pending: '排队中',
    prompting: '生成提示词中',
    queued: '生图排队中',
    rendering: '生图中',
    success: '已生成',
    failed: '生成失败',
    skipped: '已跳过',
    discarded: '已丢弃',
};

function renderJobStatus(job) {
    if (!job) return;
    const el = document.querySelector(`#chat [mesid="${job.mesIndex}"]`);
    if (!el) return;
    const existing = el.querySelector('.rh-job-status');
    const status = job.status || 'pending';
    const node = existing || document.createElement('div');
    node.className = `rh-job-status rh-job-${status}`;
    let text = STATUS_TEXT[status] || status;
    if (status === 'failed' && job.error) text += `：${job.error}`;
    if (status === 'success' && job.imageCount > 1) text += `（${job.imageCount} 张）`;
    node.textContent = text;
    node.dataset.jobId = job.jobId || '';
    if (!existing) {
        const target = el.querySelector('.mes_text') || el;
        target.appendChild(node);
    }
}

/** 清掉某楼层的角标（任务被取消/丢弃时用）。 */
function clearJobStatus(mesIndex) {
    const el = document.querySelector(`#chat [mesid="${mesIndex}"]`);
    el?.querySelector('.rh-job-status')?.remove();
}

/** 重绘后（或切回聊天后）把内存里的状态重新贴到界面上。 */
function refreshAllStatuses() {
    const key = currentChatRefKey();
    if (!key) return;
    for (const job of jobStore.listByChat(key)) {
        if (job.status === 'discarded') clearJobStatus(job.mesIndex);
        else renderJobStatus(job);
    }
}

// ───────────────────────── 主流程 ─────────────────────────

function countPendingJobs() {
    const key = currentChatRefKey();
    return key ? jobStore.activeCount(key) : 0;
}

/** 取消一条任务：内存 + 网络。结果不会再写回聊天。 */
function cancelJob(jobId, reason) {
    const entry = inflight.get(jobId);
    try { entry?.controller?.abort(new Error(reason)); } catch { /* 忽略 */ }
    jobStore.cancel(jobId, reason);
    inflight.delete(jobId);
}

async function runJob(job) {
    const s = settings();
    const controller = new AbortController();
    inflight.set(job.jobId, { controller });

    try {
        let extraNodes = [];
        try {
            extraNodes = parseExtraNodes(s.extraNodesJson);
        } catch (err) {
            jobStore.update(job.jobId, { status: 'failed', error: safeError(err), finishedAt: Date.now() });
            renderJobStatus(job);
            return;
        }

        await runImageJob(job, {
            api,
            store: jobStore,
            settings: s,
            extraNodes,
            signal: controller.signal,
            saveImage: downloadAndSaveImage,
            attachMedia,
            repaint: repaintJob,
            saveChat: saveChatAfterAttach,
            makeMedia: path => ({
                url: path,
                type: MEDIA_TYPE.IMAGE,
                title: `RH 生成 ${new Date().toLocaleString()}`,
                source: MEDIA_SOURCE.GENERATED,
            }),
            // 兜底脱敏：key / 人设 / 模板 / 负面词 / 正文都不得进日志。
            safeError: err => safeError(err, s.deepseekApiKey, [
                s.rhApiKey, s.characterPersona, s.positiveTemplate, s.negativePrompt, job.mesText,
            ]),
            log: logf,
            warn: warnf,
        });
    } finally {
        inflight.delete(job.jobId);
        if (currentChatRefKey() === job.refKey) renderJobStatus(job);
    }
}

/**
 * 真正触发点：仅在「渲染完成 + 已取到非空正文」之后调用。
 * 不做任何阻塞式 await，聊天可继续。
 * promptText 是界面上实际显示的正文（已规范化），与 msg.mes 分开保存。
 */
function performTrigger(idx, promptText) {
    const s = settings();
    if (!s.enabled) return;
    warnDeprecatedOnce(s);
    if (!Number.isInteger(idx) || idx < 0) return;

    const ctx = getContext();

    // v1 只支持单人聊天：群聊里 regenerate 会被 group-chats.js 提前归一成 'normal'（
    // L1062-1063），意图闸无法区分，所以直接不触发，不用启发式去猜。
    if (!isSupportedChat(ctx)) {
        logf('当前为群聊，v1 不支持，已跳过');
        return;
    }

    const msg = ctx.chat?.[idx];
    if (!msg || !isAiMessage(msg)) return;
    // 该楼层已经有图片（酒馆原生 extra.media）就不再堆第二张，避免刷新后重复触发时叠图。
    if (hasGeneratedMedia(msg)) return;

    const ref = currentChatRef();
    const refKey = chatRefKey(ref);
    if (!refKey) return;

    // 去重标记只在内存里：同一楼层（含同一正文）已经跑过就不再跑
    const mesHash = hashText(msg.mes);
    if (jobStore.findByFloor(refKey, idx, mesHash)) return;

    const aiCount = countAiUpTo(ctx.chat, idx);
    if (aiCount < 0) return;
    if (!shouldTrigger(aiCount, s.interval)) return;

    const base = {
        refKey,
        isGroup: !!ref.isGroup,
        characterName: ref.isGroup ? 'group' : (ref.characterName || 'rh_images'),
        mesIndex: idx,
        mesHash,
        mesText: promptText,
        startedAt: Date.now(),
    };

    const missing = validateSettings(s);
    if (missing.length) {
        jobStore.start({ ...base, jobId: newJobId(), status: 'failed', error: `配置不完整，缺少：${missing.join('、')}`, finishedAt: Date.now() });
        renderJobStatus(jobStore.findByFloor(refKey, idx, mesHash));
        toast('warning', `RH 定时生图：配置不完整（缺少${missing.length}项），已跳过本楼层`);
        return;
    }

    const pending = countPendingJobs();
    if (pending >= (Number(s.maxPendingJobs) || 5)) {
        jobStore.start({ ...base, jobId: newJobId(), status: 'skipped', error: '排队任务过多，已跳过', finishedAt: Date.now() });
        renderJobStatus(jobStore.findByFloor(refKey, idx, mesHash));
        warnf('排队任务过多，跳过一个楼层');
        return;
    }

    const job = jobStore.start({ ...base, jobId: newJobId(), status: 'pending' });
    renderJobStatus(job);
    logf('触发第', idx, '楼层，AI 回复序号', aiCount, '间隔', s.interval);

    runJob(job).catch(err => warnf('未捕获异常', safeError(err)));
}

/** 楼层被删 / 内容被改 / 切换聊天后校验：对不上的任务直接丢弃结果。 */
function cancelOrphanedJobs() {
    const ctx = getContext();
    const activeKey = currentChatRefKey();

    // 1) 不属于当前聊天的任务：切走即作废，绝不在后台写回旧聊天
    for (const job of jobStore.cancelWhere(j => j.refKey !== activeKey, 'chat_changed')) {
        const entry = inflight.get(job.jobId);
        try { entry?.controller?.abort(new Error('已取消')); } catch { /* 忽略 */ }
        inflight.delete(job.jobId);
        logf('聊天已切换，丢弃任务结果', job.jobId);
    }

    // 2) 当前聊天里，楼层不存在或正文变了（含索引漂移）
    const chat = Array.isArray(ctx.chat) ? ctx.chat : [];
    for (const job of jobStore.listByChat(activeKey)) {
        if (job.cancelled) continue;
        if (!['pending', 'prompting', 'queued', 'rendering'].includes(job.status)) continue;
        const msg = chat[job.mesIndex];
        const same = !!msg && !msg.is_user && !msg.is_system && hashText(msg.mes) === job.mesHash;
        if (same) continue;
        cancelJob(job.jobId, msg ? 'content_changed' : 'floor_missing');
        clearJobStatus(job.mesIndex);
        logf('目标楼层已删除或变更，取消任务', job.jobId, job.cancelReason);
    }
}

// ───────────────────────── 事件绑定 ─────────────────────────

/**
 * 读取某楼层「界面上实际显示的正文」。
 * 只读 DOM，不回退 msg.mes：读不到就返回 null，调用方必须放弃本次触发。
 */
function readRenderedText(mesId) {
    const root = document.querySelector(`#chat .mes[mesid="${Number(mesId)}"] .mes_text`);
    if (!root) return null;
    const raw = typeof root.innerText === 'string' ? root.innerText : '';
    const text = normalizeRenderedText(raw);
    return text ? text : null;
}

/** 触发控制器：received 只预备，rendered 才放行并读正文。 */
const trigger = createTriggerController({
    readText: readRenderedText,
    onTrigger: (idx, text) => {
        try {
            performTrigger(idx, text);
        } catch (err) {
            warnf('触发流程异常', safeError(err));
        }
    },
    log: (...args) => logf(...args),
});

function bindEvents() {
    // 生成意图：GENERATION_STARTED 带的是 Generate() 的原始 type，
    // 而完成事件的 type 会被 saveReply 归一化（非流式 regenerate → 'normal'），
    // 因此这里是唯一可靠的「本次生成是什么」来源。不读 DOM、不计数。
    eventSource.on(event_types.GENERATION_STARTED, (type, _options, dryRun) => {
        if (!settings().enabled) return;
        try {
            trigger.generationStarted(type, dryRun === true);
        } catch (err) {
            warnf('生成开始事件异常', safeError(err));
        }
    });

    // 用户中止生成：意图作废，避免残留意图影响下一次判定。
    eventSource.on(event_types.GENERATION_STOPPED, () => {
        if (!settings().enabled) return;
        try {
            trigger.generationStopped();
        } catch (err) {
            warnf('生成中止事件异常', safeError(err));
        }
    });

    // 预备：只登记「有一条普通生成即将渲染」，此阶段绝不读 DOM、不计数。
    eventSource.on(event_types.MESSAGE_RECEIVED, (mesId, type) => {
        if (!settings().enabled) return;
        try {
            trigger.received(mesId, type, getContext().chat);
        } catch (err) {
            warnf('预备事件异常', safeError(err));
        }
    });

    // 放行：DOM 已渲染，配对成功才读 .mes_text.innerText。
    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, (mesId, type) => {
        if (!settings().enabled) return;
        try {
            const r = trigger.rendered(mesId, type, getContext().chat);
            if (!r.fired && r.reason === 'empty_text') {
                warnf('未能读取渲染文本，跳过本次且不计数');
            }
            if (!r.fired && (r.reason === 'no_generation_intent' || r.reason === 'intent_type_not_allowed')) {
                logf('非普通生成，跳过', r.reason, r.intentType ?? '');
            }
        } catch (err) {
            warnf('渲染事件异常', safeError(err));
        }
    });

    eventSource.on(event_types.MESSAGE_DELETED, () => {
        setTimeout(() => {
            try { cancelOrphanedJobs(); } catch (err) { warnf(safeError(err)); }
        }, 200);
    });

    eventSource.on(event_types.CHAT_CHANGED, () => {
        try { trigger.reset(); } catch { /* 忽略 */ }
        // 切走聊天：旧聊天里正在跑的任务全部作废（结果不再写回），避免后台写别的聊天。
        try { cancelOrphanedJobs(); } catch (err) { warnf(safeError(err)); }
        setTimeout(() => {
            try { refreshAllStatuses(); } catch (err) { warnf(safeError(err)); }
        }, 300);
    });

    // 正文被编辑 = 原文变了：正在跑的任务作废（结果只对应旧正文）。
    eventSource.on(event_types.MESSAGE_EDITED, (mesId) => {
        try {
            const idx = Number(mesId);
            for (const job of jobStore.listByChat(currentChatRefKey())) {
                if (job.mesIndex !== idx) continue;
                if (!['pending', 'prompting', 'queued', 'rendering'].includes(job.status)) continue;
                const msg = getContext().chat?.[idx];
                if (msg && hashText(msg.mes) === job.mesHash) continue;
                cancelJob(job.jobId, 'content_changed');
                clearJobStatus(idx);
            }
        } catch { /* 忽略 */ }
    });
}

// ───────────────────────── 设置界面 ─────────────────────────

function el(id) {
    return document.getElementById(id);
}

function bindInput(id, key, transform = v => v) {
    const node = el(id);
    if (!node) return;
    const s = settings();
    if (node.type === 'checkbox') node.checked = !!s[key];
    else node.value = s[key] ?? '';
    const evt = (node.type === 'checkbox' || node.tagName === 'SELECT') ? 'change' : 'input';
    node.addEventListener(evt, () => {
        const value = node.type === 'checkbox' ? node.checked : transform(node.value);
        s[key] = value;
        saveSettingsDebounced();
        updateStatusLine();
    });
}

function updateStatusLine() {
    const s = settings();
    const missing = validateSettings(s);
    const line = el('rh_status_line');
    if (!line) return;
    if (!s.enabled) {
        line.textContent = '插件已停用';
        line.className = 'rh-status-line rh-off';
        return;
    }
    if (missing.length) {
        line.textContent = `未完成配置：缺少 ${missing.join('、')}`;
        line.className = 'rh-status-line rh-warn';
        return;
    }
    if (!isSupportedChat(getContext())) {
        line.textContent = '当前是群聊，v1 仅支持单人聊天，不会触发';
        line.className = 'rh-status-line rh-warn';
        return;
    }
    const extra = parseExtraNodesSafe(s.extraNodesJson);
    // 字段名软提示：只提醒、绝不改用户已保存的值
    const hints = checkFieldNameHints(s);
    const hintText = hints.length ? ` · ${hints[0]}` : '';
    line.textContent = `运行中 · 每 ${s.interval} 条 AI 回复触发一次${extra === null ? ' · 附加节点 JSON 有误' : ''}${hintText}`;
    line.className = `rh-status-line ${(extra === null || hints.length) ? 'rh-warn' : 'rh-ok'}`;
}

function parseExtraNodesSafe(text) {
    try { return parseExtraNodes(text); } catch { return null; }
}

function buildSettingsHtml() {
    return `
    <div id="rh_autoimage_drawer" class="extension_settings">
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>RH 定时生图 <span class="rh-version">${VERSION}</span></b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <div class="rh-status-line" id="rh_status_line">插件已停用</div>

                <label class="checkbox_label">
                    <input type="checkbox" id="rh_enabled">
                    <span>启用插件</span>
                </label>

                <label for="rh_interval">每 N 条 AI 回复生成一次</label>
                <input type="number" id="rh_interval" min="1" step="1" class="text_pole">

                <hr>
                <b>DeepSeek</b>
                <label for="rh_ds_url">API 地址</label>
                <input type="text" id="rh_ds_url" class="text_pole" placeholder="https://api.deepseek.com">
                <label for="rh_ds_key">API Key</label>
                <input type="password" id="rh_ds_key" class="text_pole" autocomplete="off">
                <label for="rh_ds_model">模型名</label>
                <input type="text" id="rh_ds_model" class="text_pole" placeholder="deepseek-chat">
                <div class="rh-row">
                    <div>
                        <label for="rh_ds_temp">temperature</label>
                        <input type="number" id="rh_ds_temp" min="0" max="2" step="0.1" class="text_pole">
                    </div>
                    <div>
                        <label for="rh_ds_maxtok">max_tokens</label>
                        <input type="number" id="rh_ds_maxtok" min="100" max="4000" step="50" class="text_pole">
                    </div>
                </div>
                <div class="rh-btn-row">
                    <div class="menu_button" id="rh_test_ds">测试 DeepSeek</div>
                </div>

                <hr>
                <b>提示词输入</b>
                <div class="rh-hint">
                    人设由你手动维护，插件不会去读角色卡；默认留空（示例见 README）。
                    三项都只存在本机扩展设置里。
                </div>
                <label for="rh_persona">角色人设关键词</label>
                <textarea id="rh_persona" class="text_pole" rows="4"
                    placeholder="角色外貌、服装、体型等固定描述；留空也能用"></textarea>

                <label for="rh_template">正向关键词生成模板</label>
                <textarea id="rh_template" class="text_pole" rows="9"></textarea>
                <div class="rh-hint">
                    模板会原样发给 DeepSeek，你可以直接改。默认含质量词、POV 与「一图一秒」规则。
                </div>

                <label for="rh_negative">固定负面关键词</label>
                <textarea id="rh_negative" class="text_pole" rows="3"
                    placeholder="lowres, bad anatomy, watermark"></textarea>
                <div class="rh-hint">
                    固定负面词不发给 DeepSeek、不由模型改写，原样填入 RunningHub 负面节点；留空则不提交负面节点。
                </div>

                <div id="rh_legacy_box" class="rh-legacy" style="display:none">
                    <b>旧版前缀（已保留，未生效）</b>
                    <div class="rh-hint">
                        旧版只有「正面前缀 / 负面前缀」，无法确定对应到新的哪一项，所以没有自动拼入。
                        下面是你原来的原文，请自行复制到「正向模板」或「固定负面关键词」里，然后点下方按钮清除。
                    </div>
                    <label for="rh_legacy_pos">旧·正面前缀</label>
                    <textarea id="rh_legacy_pos" class="text_pole" rows="2" readonly></textarea>
                    <label for="rh_legacy_neg">旧·负面前缀</label>
                    <textarea id="rh_legacy_neg" class="text_pole" rows="2" readonly></textarea>
                    <div class="rh-btn-row">
                        <div class="menu_button" id="rh_legacy_clear">已处理，清除旧值</div>
                    </div>
                </div>

                <hr>
                <b>RunningHub</b>
                <label for="rh_base">API 地址</label>
                <input type="text" id="rh_base" class="text_pole" placeholder="https://www.runninghub.ai">
                <label for="rh_key">API Key</label>
                <input type="password" id="rh_key" class="text_pole" autocomplete="off">
                <label for="rh_appid">AI 应用 ID</label>
                <input type="text" id="rh_appid" class="text_pole" placeholder="默认已填当前应用，可换成你自己的">
                <div class="rh-row">
                    <div>
                        <label for="rh_pos_node">正面节点 ID</label>
                        <input type="text" id="rh_pos_node" class="text_pole" placeholder="默认 1195，换应用请改">
                    </div>
                    <div>
                        <label for="rh_pos_field">正面字段名</label>
                        <input type="text" id="rh_pos_field" class="text_pole" placeholder="例如 text / prompt">
                    </div>
                </div>
                <div class="rh-hint">
                    默认值（1195 / 1018，字段名 <code>text</code>）对齐的是本项目所用的 RunningHub 应用，
                    换成你自己的应用时请按工作流实际值修改，插件不会替你猜。
                    填错通常报 <code>NODE_INFO_MISMATCH</code>，且提交已发生（可能计费）。
                </div>
                <div class="rh-row">
                    <div>
                        <label for="rh_neg_node">负面节点 ID</label>
                        <input type="text" id="rh_neg_node" class="text_pole" placeholder="默认 1018，留空表示不提交负面节点">
                    </div>
                    <div>
                        <label for="rh_neg_field">负面字段名</label>
                        <input type="text" id="rh_neg_field" class="text_pole" placeholder="例如 text / negative_prompt">
                    </div>
                </div>
                <label for="rh_extra_nodes">附加节点（JSON 数组，可留空）</label>
                <textarea id="rh_extra_nodes" class="text_pole" rows="3"
                    placeholder='[{"nodeId":"145","fieldName":"value","fieldValue":"5"}]'></textarea>
                <div class="rh-btn-row">
                    <div class="menu_button" id="rh_test_rh">测试 RunningHub 应用</div>
                </div>

                <hr>
                <b>高级</b>
                <div class="rh-row">
                    <div>
                        <label for="rh_poll_ms">轮询间隔（毫秒）</label>
                        <input type="number" id="rh_poll_ms" min="2000" step="500" class="text_pole">
                    </div>
                    <div>
                        <label for="rh_poll_timeout">最长等待（毫秒）</label>
                        <input type="number" id="rh_poll_timeout" min="60000" step="10000" class="text_pole">
                    </div>
                </div>
                <div class="rh-row">
                    <div>
                        <label for="rh_req_timeout">单请求超时（毫秒）</label>
                        <input type="number" id="rh_req_timeout" min="5000" step="1000" class="text_pole">
                    </div>
                    <div>
                        <label for="rh_max_pending">最大并行任务数</label>
                        <input type="number" id="rh_max_pending" min="1" max="20" step="1" class="text_pole">
                    </div>
                </div>
                <div class="rh-hint">
                    API Key 仅保存在本机扩展设置中，不会写入聊天、日志或源码。
                </div>
                <div class="rh-hint">
                    v1 仅支持单人聊天：群里自动不触发（群聊会把「重新生成」提前归一成普通生成，插件无法可靠区分）。
                    分辨率（如 4:3 / 1280×960）由 RunningHub 工作流决定，插件不传宽高、不覆盖。
                </div>
            </div>
        </div>
    </div>`;
}

function addSettingsUI() {
    const container = document.getElementById('extensions_settings2');
    if (!container) {
        warnf('未找到设置容器 #extensions_settings2，稍后重试');
        setTimeout(addSettingsUI, 500);
        return;
    }
    if (document.getElementById('rh_autoimage_drawer')) return;

    container.insertAdjacentHTML('beforeend', buildSettingsHtml());

    bindInput('rh_enabled', 'enabled');
    bindInput('rh_interval', 'interval', v => Math.max(1, Math.trunc(Number(v) || 1)));
    bindInput('rh_ds_url', 'deepseekBaseUrl');
    bindInput('rh_ds_key', 'deepseekApiKey');
    bindInput('rh_ds_model', 'deepseekModel');
    bindInput('rh_ds_temp', 'deepseekTemperature', v => Number(v) || 0);
    bindInput('rh_ds_maxtok', 'deepseekMaxTokens', v => Math.trunc(Number(v) || 600));
    bindInput('rh_persona', 'characterPersona');
    bindInput('rh_template', 'positiveTemplate');
    bindInput('rh_negative', 'negativePrompt');
    bindInput('rh_base', 'rhBaseUrl');
    bindInput('rh_key', 'rhApiKey');
    bindInput('rh_appid', 'rhAppId');
    bindInput('rh_pos_node', 'positiveNodeId');
    bindInput('rh_pos_field', 'positiveFieldName');
    bindInput('rh_neg_node', 'negativeNodeId');
    bindInput('rh_neg_field', 'negativeFieldName');
    bindInput('rh_extra_nodes', 'extraNodesJson');
    bindInput('rh_poll_ms', 'pollIntervalMs', v => Math.trunc(Number(v) || 5000));
    bindInput('rh_poll_timeout', 'pollTimeoutMs', v => Math.trunc(Number(v) || 600000));
    bindInput('rh_req_timeout', 'requestTimeoutMs', v => Math.trunc(Number(v) || 60000));
    bindInput('rh_max_pending', 'maxPendingJobs', v => Math.max(1, Math.trunc(Number(v) || 5)));

    document.getElementById('rh_test_ds')?.addEventListener('click', onTestDeepSeek);
    document.getElementById('rh_test_rh')?.addEventListener('click', onTestRunningHub);
    document.getElementById('rh_legacy_clear')?.addEventListener('click', onClearLegacyPrefixes);

    renderLegacyBox();
    updateStatusLine();
}

/** 旧前缀只在「有内容」时才展示，全部为空就彻底隐藏。 */
function renderLegacyBox() {
    const s = settings();
    const box = el('rh_legacy_box');
    if (!box) return;
    const pos = String(s.legacyPositivePrefix ?? '');
    const neg = String(s.legacyNegativePrefix ?? '');
    const has = !!(pos.trim() || neg.trim());
    box.style.display = has ? '' : 'none';
    if (!has) return;
    const posNode = el('rh_legacy_pos');
    const negNode = el('rh_legacy_neg');
    if (posNode) posNode.value = pos;
    if (negNode) negNode.value = neg;
}

function onClearLegacyPrefixes() {
    const s = settings();
    s.legacyPositivePrefix = '';
    s.legacyNegativePrefix = '';
    saveSettingsDebounced();
    renderLegacyBox();
    toast('success', '旧版前缀已清除');
}

async function onTestDeepSeek() {
    const s = settings();
    const btn = document.getElementById('rh_test_ds');
    if (!s.deepseekApiKey) return toast('warning', '请先填写 DeepSeek API Key');
    if (!String(s.positiveTemplate ?? '').trim()) return toast('warning', '请先填写正向关键词生成模板');
    btn.classList.add('rh-busy');
    try {
        const probe = await api.generatePositivePrompt(s, {
            persona: s.characterPersona,
            template: s.positiveTemplate,
            reply: '少女站在窗边，阳光落在肩上，安静地看着外面。',
        });
        // 只报长度与首尾标签数量，不把模型输出写进 toast / 日志
        const tagCount = probe.split(',').filter(x => x.trim()).length;
        toast('success', `DeepSeek 连通正常（正向 ${probe.length} 字符 / ${tagCount} 个标签）`);
    } catch (err) {
        toast('error', `DeepSeek 测试失败：${safeError(err, s.deepseekApiKey, [s.characterPersona, s.positiveTemplate, s.negativePrompt])}`);
    } finally {
        btn.classList.remove('rh-busy');
    }
}

async function onTestRunningHub() {
    const s = settings();
    warnDeprecatedOnce(s);
    const btn = document.getElementById('rh_test_rh');
    if (!s.rhApiKey) return toast('warning', '请先填写 RunningHub API Key');
    if (!s.rhAppId) return toast('warning', '请先填写 RunningHub 应用 ID');
    if (!s.positiveNodeId || !s.positiveFieldName) return toast('warning', '请先填写正面提示词节点与字段名');

    let extraNodes = [];
    try {
        extraNodes = parseExtraNodes(s.extraNodesJson);
    } catch (err) {
        return toast('error', safeError(err));
    }

    btn.classList.add('rh-busy');
    try {
        // 负面只用于自己的连通性测试，不涉及 DeepSeek。
        const testNegative = String(s.negativePrompt ?? '').trim();
        const payload = buildRhPayload({
            positiveValue: 'test, a simple red apple on a white table, product photo',
            negativeValue: testNegative,
            positiveNode: s.positiveNodeId,
            positiveField: s.positiveFieldName,
            negativeNode: s.negativeNodeId,
            negativeField: s.negativeFieldName,
            extraNodes,
        });
        const res = await api.rhSubmit(s, payload, undefined);
        toast('success', `RunningHub 提交成功，taskId=${res.taskId}（本次会产生消耗）`);
    } catch (err) {
        toast('error', `RunningHub 测试失败：${safeError(err, s.rhApiKey)}`);
    } finally {
        btn.classList.remove('rh-busy');
    }
}

// ───────────────────────── 生命周期 ─────────────────────────

let bound = false;
let initialized = false;

export async function init() {
    // 幂等保护：即使被重复调用，也不会重复绑定事件 / 重复插入设置面板 / 重复启动任务。
    if (initialized) {
        logf('已初始化，跳过重复调用');
        return;
    }
    initialized = true;
    try {
        warnDeprecatedOnce(settings());
        addSettingsUI();
        if (!bound) {
            bindEvents();
            bound = true;
        }
        setTimeout(() => {
            try { refreshAllStatuses(); } catch { /* 忽略 */ }
        }, 1000);
        logf(`已加载 v${VERSION}`);
    } catch (err) {
        initialized = false;
        throw err;
    }
}

export async function exit() {
    document.getElementById('rh_autoimage_drawer')?.remove();
    for (const [jobId, entry] of inflight) {
        jobStore.cancel(jobId, 'plugin_disabled');
        try { entry.controller?.abort(new Error('插件已停用')); } catch { /* 忽略 */ }
    }
    inflight.clear();
    jobStore.clear();
    bound = false;
    initialized = false;
    logf('已卸载');
}

// ST 1.18.0 加载契约：addExtensionScript() 以 <script type="module"> 引入本文件，
// 顶层代码会执行一次；若同时在 manifest 声明 hooks.activate，callExtensionHook()
// 会 await import() 同一 URL（命中模块缓存，不重复执行顶层）后再调用 init()，
// 导致 init() 被调用两次。因此这里只保留顶层调用，manifest 不声明 hooks。
init().catch(err => warnf('初始化失败', safeError(err)));
