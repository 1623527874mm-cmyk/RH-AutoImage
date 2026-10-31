// trigger.js — 触发闸门（纯逻辑，不 import 任何酒馆模块，可在 node 下直接单测）。
// 设计要点：
//   1) MESSAGE_RECEIVED 只「预备」，绝不读 DOM；
//   2) CHARACTER_MESSAGE_RENDERED 才「放行」，此时才读渲染后正文；
//   3) 计数与启动任务在「拿到非空正文」之后才发生；
//   4) 正文读取失败 → 不计数、不写标记、不调用任何外部 API。

import { isTriggerableMessage } from './core.js';

/** v1 只认普通新生成。continue/swipe/regenerate/command/appendFinal/first_message/impersonate 全部不触发。 */
export const ALLOWED_GEN_TYPES = Object.freeze(['normal']);

/**
 * 这些生成类型**根本不会产生新消息**（script.js：isImpersonate 走 IMPERSONATE_READY、
 * quiet 直接 return，都不经过 saveReply），因此不记录意图，避免把有效意图顶掉。
 */
export const NO_MESSAGE_GEN_TYPES = Object.freeze(['quiet', 'impersonate']);

/** 预备事件的存活时间：超过这个时间还没等到渲染事件就作废。 */
export const DEFAULT_ARM_TTL_MS = 10000;

/**
 * 生成意图的存活时间：从 GENERATION_STARTED 到对应 MESSAGE_RECEIVED 之间。
 * 必须覆盖一次完整生成的耗时（长回复几分钟），所以给得比 arm 宽松得多。
 */
export const DEFAULT_INTENT_TTL_MS = 600000;

/** 生成类型是否允许触发。空值、未知值一律不允许（宁可漏触发，不可误触发）。 */
export function isAllowedGenType(type) {
    const t = String(type ?? '').trim();
    return ALLOWED_GEN_TYPES.includes(t);
}

/**
 * 预备/放行闸门。
 * - arm：收到 MESSAGE_RECEIVED 时调用，仅记录「有一条普通生成即将渲染」。
 * - confirm：收到 CHARACTER_MESSAGE_RENDERED 时调用，配对成功才返回 { fire: true }。
 * 同一个 arm 只能被消费一次，因此重复的渲染事件不会重复触发。
 *
 * 另有一份「生成意图」寄存：GENERATION_STARTED 带的是 Generate() 的**原始 type**，
 * 而完成事件带的 type 会被 saveReply 归一化（非流式 regenerate → 'normal'），
 * 因此判定是否该触发必须看意图，不能只看完成事件的 type。
 */
export function createTriggerGate({
    armTtlMs = DEFAULT_ARM_TTL_MS,
    intentTtlMs = DEFAULT_INTENT_TTL_MS,
    now = () => Date.now(),
} = {}) {
    let armed = null;
    let intent = null;

    return {
        arm({ mesId, type } = {}) {
            if (!isAllowedGenType(type)) return { armed: false, reason: 'type_not_allowed' };
            if (!Number.isInteger(mesId) || mesId < 0) return { armed: false, reason: 'invalid_mes_id' };
            armed = { mesId, type: String(type).trim(), ts: now() };
            return { armed: true, reason: 'armed' };
        },

        confirm({ mesId, type } = {}) {
            if (!armed) return { fire: false, reason: 'not_armed' };
            if (now() - armed.ts > armTtlMs) {
                armed = null;
                return { fire: false, reason: 'arm_expired' };
            }
            if (!Number.isInteger(mesId) || mesId !== armed.mesId) {
                return { fire: false, reason: 'mes_mismatch' };
            }
            if (!isAllowedGenType(type)) return { fire: false, reason: 'type_not_allowed' };
            armed = null;
            return { fire: true, reason: 'fire', mesId, type: String(type).trim() };
        },

        clear() {
            armed = null;
            intent = null;
        },

        peek() {
            return armed ? { ...armed } : null;
        },

        /**
         * 记录一次生成开始的「意图」。dryRun（只算 token、不产出消息）一律不留痕。
         * 单槽位：新的生成意图覆盖旧的。
         */
        noteGeneration({ type, dryRun } = {}) {
            // dryRun 只算 token、不产出消息，且可能在任何时刻发生 —— 一律不碰意图。
            if (dryRun) return { noted: false, reason: 'dry_run' };
            const t = String(type ?? '').trim();
            // 不产出消息的类型同样不碰意图，避免正常生成的意图被顶掉（宁可漏，不可错）。
            if (NO_MESSAGE_GEN_TYPES.includes(t)) return { noted: false, reason: 'no_message_type' };
            intent = { type: t, ts: now() };
            return { noted: true, reason: 'noted', type: t };
        },

        /** 取出并消费意图（只能用一次）。过期的返回 { expired: true }。 */
        takeIntent() {
            if (!intent) return null;
            const i = intent;
            intent = null;
            if (now() - i.ts > intentTtlMs) return { ...i, expired: true };
            return i;
        },

        peekIntent() {
            return intent ? { ...intent } : null;
        },

        clearIntent() {
            intent = null;
        },
    };
}

/**
 * 把两个事件串成一条完整流程，便于脱离浏览器单测。
 * 依赖全部注入：readText（读渲染后正文）、onTrigger（真正计数+启动任务）。
 */
export function createTriggerController({
    readText,
    onTrigger,
    armTtlMs = DEFAULT_ARM_TTL_MS,
    intentTtlMs = DEFAULT_INTENT_TTL_MS,
    now = () => Date.now(),
    log = () => {},
} = {}) {
    if (typeof readText !== 'function') throw new Error('readText 必须是函数');
    if (typeof onTrigger !== 'function') throw new Error('onTrigger 必须是函数');

    const gate = createTriggerGate({ armTtlMs, intentTtlMs, now });

    return {
        gate,

        /**
         * GENERATION_STARTED：记录本次生成的原始意图（type 未被归一化，dryRun 可辨）。
         * 这是唯一能区分「普通生成」与「非流式 regenerate」的可靠信号。
         */
        generationStarted(type, dryRun) {
            const r = gate.noteGeneration({ type, dryRun });
            if (r.noted) log('记录生成意图', r.type);
            return r;
        },

        /** GENERATION_STOPPED：用户中止，意图作废，避免影响下一次判定。 */
        generationStopped() {
            gate.clearIntent();
            return { cleared: true };
        },

        /** MESSAGE_RECEIVED：只预备，不读 DOM、不计数。 */
        received(mesId, type, chat) {
            const idx = Number(mesId);
            if (!isTriggerableMessage(chat?.[idx], idx, Array.isArray(chat) ? chat.length : 0)) {
                return { armed: false, reason: 'not_triggerable' };
            }
            // 完成事件类型闸**必须先于**意图消费：
            // command（/sendas、/narrator）、first_message 这类事件结构合法但类型非法，
            // 若先 takeIntent() 会白吃掉仍然有效的 normal 意图，导致本轮真正回复漏触发。
            if (!isAllowedGenType(type)) return { armed: false, reason: 'type_not_allowed' };
            // 意图闸：完成事件的 type 不可信（非流式 regenerate 会被归一成 normal），
            // 必须以 GENERATION_STARTED 记下的原始类型为准。
            // 走到这里说明完成事件确实是普通生成，意图可以安全消费。
            const intent = gate.takeIntent();
            if (!intent) return { armed: false, reason: 'no_generation_intent' };
            if (intent.expired) return { armed: false, reason: 'intent_expired' };
            // 意图是 regenerate/continue/swipe 等：消费掉并拒绝，绝不留给后续普通回复。
            if (!isAllowedGenType(intent.type)) {
                return { armed: false, reason: 'intent_type_not_allowed', intentType: intent.type };
            }
            const r = gate.arm({ mesId: idx, type });
            if (r.armed) log('预备触发', '楼层', idx, '类型', type);
            return r;
        },

        /** CHARACTER_MESSAGE_RENDERED：配对成功 → 读正文 → 有正文才触发。 */
        rendered(mesId, type, chat) {
            const idx = Number(mesId);
            const r = gate.confirm({ mesId: idx, type });
            if (!r.fire) return { fired: false, reason: r.reason };

            if (!isTriggerableMessage(chat?.[idx], idx, Array.isArray(chat) ? chat.length : 0)) {
                return { fired: false, reason: 'not_triggerable' };
            }

            let text = null;
            try {
                text = readText(idx);
            } catch {
                text = null;
            }
            if (!text || !String(text).trim()) {
                return { fired: false, reason: 'empty_text' };
            }

            onTrigger(idx, text);
            return { fired: true, reason: 'fired', mesId: idx, text };
        },

        reset() {
            gate.clear();
        },
    };
}
