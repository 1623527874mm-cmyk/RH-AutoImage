// jobs.js — 任务运行时状态 + 图片写回安全判定。纯逻辑，不 import 酒馆模块，可在 node 下直接单测。
//
// 设计要点（对应本阶段的三条硬性要求）：
// 1. 运行状态（status / error / taskId / 去重标记）**只存在这里的 Map 里**，任何情况下都不写进
//    message.extra，因此刷新页面后运行中的状态会消失 —— 这是预期行为。
// 2. 图片写回只允许发生在「当前聊天 + 同一楼层 + 原文未变」的情况下，否则丢弃结果，
//    并且永远不通过 /api/chats/save 之类全量接口后台写别的聊天。
// 3. 下载完成之后、真正挂图之前再校验一次，避免异步窗口内聊天被切换 / 楼层被删 / 内容被改。

import {
    hashText, assembleRhValues, buildRhPayload,
    pickImageUrls, describeEmptyResults, redact,
} from './core.js';

/** 仍在进行中的状态（用于并发上限与「是否还值得等」判断）。 */
export const ACTIVE_STATUSES = Object.freeze(['pending', 'prompting', 'queued', 'rendering']);

/** 任务对象的稳定字段清单（测试用它断言「没有多写状态字段进消息」）。 */
export const JOB_FIELDS = Object.freeze([
    'jobId', 'refKey', 'isGroup', 'characterName', 'mesIndex', 'mesHash', 'mesText',
    'status', 'startedAt', 'finishedAt', 'taskId', 'error', 'imageCount',
    'cancelled', 'cancelReason',
]);

/** 聊天的稳定标识；任一部分缺失就返回空串（此时一律不写回）。 */
export function chatRefKey(ref) {
    if (!ref || typeof ref !== 'object') return '';
    const kind = ref.isGroup ? 'group' : 'char';
    const chatId = String(ref.chatId ?? '');
    if (!chatId) return '';
    const owner = ref.isGroup ? String(ref.groupId ?? '') : String(ref.characterName ?? '');
    return `${kind}:${chatId}:${owner}`;
}

export function isSameChat(a, b) {
    return typeof a === 'string' && typeof b === 'string' && a !== '' && a === b;
}

/**
 * 运行时任务表。**不落盘、不写 message.extra**，进程内有效。
 * 上限只用于防止长会话内存无限增长：超出时只清掉已结束的旧任务，绝不清正在跑的。
 */
export function createJobStore({ limit = 200 } = {}) {
    const jobs = new Map();

    function trim() {
        if (jobs.size <= limit) return;
        for (const [id, job] of jobs) {
            if (jobs.size <= limit) break;
            if (!ACTIVE_STATUSES.includes(job.status)) jobs.delete(id);
        }
    }

    function start(job) {
        const entry = {
            cancelled: false,
            cancelReason: '',
            appliedUrls: new Set(),
            ...job,
        };
        jobs.set(entry.jobId, entry);
        trim();
        return entry;
    }

    function get(jobId) {
        return jobs.get(jobId) ?? null;
    }

    function update(jobId, patch) {
        const job = jobs.get(jobId);
        if (!job) return null;
        Object.assign(job, patch);
        return job;
    }

    function remove(jobId) {
        jobs.delete(jobId);
    }

    /** 取消：只改内存状态，结果不会再被写回聊天。 */
    function cancel(jobId, reason = 'cancelled') {
        const job = jobs.get(jobId);
        if (!job) return null;
        job.cancelled = true;
        job.cancelReason = reason;
        if (ACTIVE_STATUSES.includes(job.status)) job.status = 'discarded';
        return job;
    }

    function cancelWhere(predicate, reason = 'cancelled') {
        const out = [];
        for (const [id, job] of jobs) {
            if (!ACTIVE_STATUSES.includes(job.status)) continue;
            if (!predicate(job)) continue;
            cancel(id, reason);
            out.push(job);
        }
        return out;
    }

    function isAlive(jobId) {
        const job = jobs.get(jobId);
        return !!job && !job.cancelled;
    }

    /** 同一楼层是否已有任务（去重标记只在这里，不进消息对象）。 */
    function findByFloor(refKey, mesIndex, mesHash) {
        for (const job of jobs.values()) {
            if (job.cancelled) continue;
            if (job.refKey !== refKey) continue;
            if (job.mesIndex !== mesIndex) continue;
            if (mesHash !== undefined && job.mesHash !== mesHash) continue;
            return job;
        }
        return null;
    }

    function activeCount(refKey) {
        let n = 0;
        for (const job of jobs.values()) {
            if (job.cancelled) continue;
            if (job.refKey !== refKey) continue;
            if (ACTIVE_STATUSES.includes(job.status)) n++;
        }
        return n;
    }

    function listByChat(refKey) {
        return [...jobs.values()].filter(j => j.refKey === refKey);
    }

    function clear() {
        jobs.clear();
    }

    return {
        start, get, update, remove, cancel, cancelWhere, isAlive,
        findByFloor, activeCount, listByChat, clear,
        get size() { return jobs.size; },
    };
}

/**
 * 写回前的唯一判定。**纯函数**，不改任何东西，方便单测。
 * @returns {{ok: true, index: number, msg: object} | {ok: false, reason: string}}
 */
export function planAttach({ job, activeRefKey, chat } = {}) {
    if (!job) return { ok: false, reason: 'no_job' };
    if (job.cancelled) return { ok: false, reason: job.cancelReason || 'cancelled' };
    if (!job.refKey) return { ok: false, reason: 'no_chat_ref' };
    if (!isSameChat(job.refKey, activeRefKey)) return { ok: false, reason: 'chat_changed' };

    const index = job.mesIndex;
    if (!Number.isInteger(index) || index < 0) return { ok: false, reason: 'bad_index' };
    if (!Array.isArray(chat)) return { ok: false, reason: 'no_chat' };

    const msg = chat[index];
    // 楼层被删 / 前方楼层被删导致索引漂移：位置上的消息已经不是原来那条
    if (!msg || typeof msg !== 'object') return { ok: false, reason: 'floor_missing' };
    if (msg.is_user || msg.is_system) return { ok: false, reason: 'not_ai_message' };
    if (typeof job.mesHash !== 'string' || hashText(msg.mes) !== job.mesHash) {
        return { ok: false, reason: 'content_changed' };
    }
    return { ok: true, index, msg };
}

/**
 * 把媒体条目挂到消息上（酒馆原生结构：extra.media / extra.media_index / extra.inline_image）。
 * 只动 extra.media 相关字段，绝不写 rh_image_job 之类的任务状态。
 */
export function applyMediaEntry(msg, mediaEntry) {
    if (!msg || typeof msg !== 'object') throw new Error('目标消息不存在');
    if (!msg.extra || typeof msg.extra !== 'object') msg.extra = {};
    if (!Array.isArray(msg.extra.media)) msg.extra.media = [];
    msg.extra.media.push(mediaEntry);
    msg.extra.media_index = msg.extra.media.length - 1;
    msg.extra.inline_image = true;
    return msg.extra.media.length;
}

/**
 * 跑完一整条任务：生成正向关键词 → 提交 → 轮询 → 逐个下载 → 校验 → 挂图。
 * 所有副作用都通过注入的依赖完成，因此可以在 node 下用假 fetch / 假消息数组完整单测。
 *
 * @param {object} job 任务对象（由 store.start 创建）
 * @param {object} deps
 * @param {object} deps.api      createApi() 的返回值
 * @param {object} deps.store    createJobStore() 的返回值
 * @param {object} deps.settings 当前设置
 * @param {Array}  deps.extraNodes 附加节点
 * @param {(url:string,name:string)=>Promise<string>} deps.saveImage 下载并保存图片，返回酒馆路径
 * @param {(job:object, media:object)=>Promise<{applied:boolean, reason?:string}>} deps.attachMedia
 * @param {(msg:object)=>void} [deps.repaint] 挂图后重绘楼层
 * @param {()=>Promise<void>} [deps.saveChat] 保存聊天（只在真的挂上图后调用）
 * @param {(path:string)=>object} [deps.makeMedia] 构造媒体条目
 */
export async function runImageJob(job, deps) {
    const {
        api, store, settings, extraNodes = [],
        saveImage, attachMedia, repaint, saveChat, makeMedia, signal,
        now = () => Date.now(),
        maxImages = 4,
        log = () => {}, warn = () => {},
        safeError = (err) => String(err?.message ?? err),
    } = deps;

    const jobId = job.jobId;
    const alive = () => store.isAlive(jobId);
    // 被取消时回传具体的取消原因（chat_changed / floor_missing / …），便于上层记日志
    const stopped = () => ({ ok: false, reason: store.get(jobId)?.cancelReason || 'cancelled' });

    // 重复触发 / 重复完成事件：同一个 jobId 已经在跑或已经成功，就不再来一遍（避免重复计费）。
    const existing = store.get(jobId);
    if (!existing) return { ok: false, reason: 'unknown_job' };
    if (existing.cancelled) return { ok: false, reason: existing.cancelReason || 'cancelled' };
    if (existing.status === 'success') return { ok: false, reason: 'already_done' };

    // 本次任务已经生成的正向词：只用于错误脱敏，不写进消息、不写进日志。
    let positiveText = '';

    const media = makeMedia ?? (path => ({
        url: path,
        type: 'image',
        title: `RH 生成 ${new Date(now()).toLocaleString()}`,
        source: 'generated',
    }));

    try {
        store.update(jobId, { status: 'prompting' });

        // 只生成正向关键词：固定负面词从不进 DeepSeek。
        const positive = await api.generatePositivePrompt(settings, {
            persona: settings.characterPersona,
            template: settings.positiveTemplate,
            reply: job.mesText,
        }, signal);
        if (!alive()) return stopped();
        if (!positive) throw new Error('正面提示词为空，无法生图');
        positiveText = String(positive);

        const { positiveValue, negativeValue } = assembleRhValues({ positive, settings });
        const payload = buildRhPayload({
            positiveValue,
            negativeValue,
            positiveNode: settings.positiveNodeId,
            positiveField: settings.positiveFieldName,
            negativeNode: settings.negativeNodeId,
            negativeField: settings.negativeFieldName,
            extraNodes,
        });

        // extraSecrets：正向词与回复正文也可能被服务端回显，一并纳入脱敏字典
        const extraSecrets = [positiveText, job.mesText];
        const submitted = await api.rhSubmit(settings, payload, signal, extraSecrets);
        if (!alive()) return stopped();
        store.update(jobId, { status: 'queued', taskId: submitted.taskId });

        const result = await api.rhPoll(settings, submitted.taskId, signal, extraSecrets);
        if (!alive()) return stopped();

        const urls = pickImageUrls(result.results);
        if (urls.length === 0) throw new Error(describeEmptyResults(result.results));

        store.update(jobId, { status: 'rendering' });

        let saved = 0;
        let lastReason = '';
        for (const url of urls.slice(0, maxImages)) {
            if (!alive()) break;
            // 重复的完成事件 / 重复轮询结果：同一个 url 只挂一次
            if (job.appliedUrls?.has(url)) continue;

            // 先下载，下载是慢操作，落地后必须重新校验任务是否还对得上。
            const path = await saveImage(url, job.characterName);
            if (!alive()) break;

            const entry = media(path);
            const res = await attachMedia(job, entry);
            if (res?.applied) {
                job.appliedUrls?.add(url);
                saved++;
                if (typeof repaint === 'function') {
                    try { repaint(job); } catch (err) { warn('重绘楼层失败', safeError(err)); }
                }
                // 只有真的挂上图才需要写盘
                if (typeof saveChat === 'function') {
                    try { await saveChat(); } catch (err) { warn('保存聊天失败', safeError(err)); }
                }
            } else {
                lastReason = res?.reason || '无法挂载到目标楼层';
                // 聊天已切换 / 楼层已不存在 / 内容已变：后续图片同样写不进去，直接停
                if (['chat_changed', 'floor_missing', 'content_changed', 'not_ai_message', 'bad_index', 'no_chat_ref', 'no_chat'].includes(lastReason)) {
                    break;
                }
            }
        }

        if (saved === 0) throw new Error(lastReason || '图片已生成但保存失败');

        store.update(jobId, {
            status: 'success',
            imageCount: saved,
            finishedAt: now(),
            error: '',
        });
        log('任务完成', jobId, saved);
        return { ok: true, saved };
    } catch (err) {
        const current = store.get(jobId);
        if (current?.cancelled) {
            return { ok: false, reason: current.cancelReason || 'cancelled' };
        }
        // 二次兜底：即使调用方的 safeError 没配好，正向词/负面词/人设/正文也不会漏进错误里
        const message = redact(safeError(err), [
            settings?.deepseekApiKey, settings?.rhApiKey,
            settings?.characterPersona, settings?.positiveTemplate,
            settings?.negativePrompt, job?.mesText, positiveText,
        ]);
        store.update(jobId, { status: 'failed', error: message, finishedAt: now() });
        warn('任务失败', jobId, message);
        return { ok: false, reason: 'failed', error: message };
    }
}
