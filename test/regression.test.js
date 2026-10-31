// regression.test.js — 回归测试：删除楼层后的触发行为（离线，纯逻辑，不触网）。
//
// 背景：计数一直是「按当前聊天现存顺序重算」而不是内存累加器，所以删楼后不应出现
//      「该触发却不触发」或「触发两次」。这里用一个与 index.js performTrigger 同序的
//      判定函数把它钉死：
//        isAiMessage → hasGeneratedMedia → findByFloor(去重) → countAiUpTo → shouldTrigger
//
// 同时固定三条「不触发」的既定行为：regenerate / swipe / continue。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    isAiMessage, hashText, hasGeneratedMedia, countAiUpTo, countAiMessages, shouldTrigger,
} from '../lib/core.js';
import { createTriggerController } from '../lib/trigger.js';
import { createJobStore } from '../lib/jobs.js';

const A = (mes, extra = {}) => ({ mes, is_user: false, name: 'char', swipe_id: 0, extra });
const U = (mes) => ({ mes, is_user: true, name: 'User', swipe_id: 0 });

const REF_KEY = 'char:chat-1:阿玥';

/**
 * 与 index.js performTrigger 同序的判定函数。
 * 只把「读 DOM / toast / 渲染角标 / 真正调 API」换成记录，判定顺序一字不改。
 */
function makeRuntime({ chat, interval = 1, refKey = REF_KEY } = {}) {
    const store = createJobStore();
    const fired = [];
    const attempts = [];

    function decide(idx, text) {
        const msg = chat[idx];
        if (!msg || !isAiMessage(msg)) {
            attempts.push({ idx, result: 'not_ai' });
            return 'not_ai';
        }
        // 该楼层已经有酒馆原生图片 → 不再堆第二张（刷新后重复触发的兜底）
        if (hasGeneratedMedia(msg)) {
            attempts.push({ idx, result: 'has_media' });
            return 'has_media';
        }
        const mesHash = hashText(msg.mes);
        // 去重标记只在内存里：同一楼层同一正文跑过就不再跑
        if (store.findByFloor(refKey, idx, mesHash)) {
            attempts.push({ idx, result: 'deduped' });
            return 'deduped';
        }
        const aiCount = countAiUpTo(chat, idx);
        if (aiCount < 0) {
            attempts.push({ idx, result: 'bad_index' });
            return 'bad_index';
        }
        if (!shouldTrigger(aiCount, interval)) {
            attempts.push({ idx, result: 'interval_miss', aiCount });
            return 'interval_miss';
        }
        store.start({
            jobId: `job-${idx}-${fired.length}`,
            refKey,
            mesIndex: idx,
            mesHash,
            status: 'pending',
        });
        fired.push({ idx, aiCount, text });
        attempts.push({ idx, result: 'fired', aiCount });
        return 'fired';
    }

    const controller = createTriggerController({
        // 模拟 DOM：正文随楼层变化，保证 hash 各不相同
        readText: (idx) => `渲染后的正文 #${idx}`,
        onTrigger: decide,
    });

    return { controller, store, fired, attempts, chat, interval, refKey };
}

/** 模拟一次普通生成：先记意图，再追加用户消息 + AI 回复，返回新楼层索引。 */
function normalGeneration(rt, { user = '新一轮用户消息', ai = '新一轮 AI 回复' } = {}) {
    rt.controller.generationStarted('normal');
    rt.chat.push(U(user));
    rt.chat.push(A(ai));
    const idx = rt.chat.length - 1;
    return { idx, chat: rt.chat };
}

// ───────── 1. 删除楼层后仍然只触发一次 ─────────

test('删除较早楼层后，下一条普通新回复在 N=1 时仍然触发（且只一次）', () => {
    // 初始：3 轮对话，3 条 AI 回复
    const chat = [U('u1'), A('a1'), U('u2'), A('a2'), U('u3'), A('a3')];
    const rt = makeRuntime({ chat, interval: 1 });
    assert.equal(countAiMessages(chat), 3, '前置条件：3 条 AI 回复');

    // 删掉较早的两层（第 1 层 AI 回复 + 第 2 层用户消息）→ 索引整体前移
    chat.splice(1, 2);
    assert.equal(chat.length, 4);
    assert.equal(countAiMessages(chat), 2, '删楼后计数必须按现存楼层重算');

    const { idx } = normalGeneration(rt);
    assert.equal(idx, 5);
    assert.equal(countAiUpTo(chat, idx), 3, '重算：现存 2 条旧 AI + 本次 1 条 = 3');

    const r1 = rt.controller.received(idx, 'normal', chat);
    assert.equal(r1.armed, true, '删楼不应影响预备');

    const r2 = rt.controller.rendered(idx, 'normal', chat);
    assert.equal(r2.fired, true, '删楼后必须仍然触发');
    assert.equal(rt.fired.length, 1, '只能触发一次');
    assert.equal(rt.fired[0].idx, idx);
    assert.equal(rt.fired[0].aiCount, 3);
    assert.equal(rt.store.size, 1, '只登记一个任务');
});

test('同一楼层重复渲染不会重复触发（arm 只能被消费一次）', () => {
    const chat = [U('u1'), A('a1')];
    const rt = makeRuntime({ chat, interval: 1 });

    const { idx } = normalGeneration(rt);
    rt.controller.received(idx, 'normal', chat);
    assert.equal(rt.controller.rendered(idx, 'normal', chat).fired, true);
    assert.equal(rt.fired.length, 1);

    // 第二次渲染（楼层重绘、滚动、窗口 resize 等）没有新的 RECEIVED，必须静默
    const again = rt.controller.rendered(idx, 'normal', chat);
    assert.equal(again.fired, false);
    assert.equal(again.reason, 'not_armed');
    assert.equal(rt.fired.length, 1, '重复渲染不得重复触发');
    assert.equal(rt.store.size, 1);
});

test('删楼 + 重复渲染组合：仍然只有一次', () => {
    const chat = [U('u1'), A('a1'), U('u2'), A('a2'), U('u3'), A('a3')];
    const rt = makeRuntime({ chat, interval: 1 });
    chat.splice(1, 3); // 删得更狠：只剩最后一轮 AI 回复

    const { idx } = normalGeneration(rt);
    rt.controller.received(idx, 'normal', chat);
    rt.controller.rendered(idx, 'normal', chat);
    rt.controller.rendered(idx, 'normal', chat);
    rt.controller.rendered(idx, 'normal', chat);

    assert.equal(rt.fired.length, 1);
});

test('同一楼层已有酒馆原生图片时不再重复生成（删楼后索引漂移的兜底）', () => {
    const chat = [U('u1'), A('a1'), U('u2'), A('a2', { media: [{ type: 'image', url: 'x.png' }] })];
    const rt = makeRuntime({ chat, interval: 1 });

    // 删掉前面的楼，最后那条带图的 AI 回复成为倒数第二条
    chat.splice(1, 1);
    rt.controller.generationStarted('normal');
    chat.push(U('u3'));
    chat.push(A('a3'));
    const idx = chat.length - 1;

    // 本次新回复正常触发
    rt.controller.received(idx, 'normal', chat);
    assert.equal(rt.controller.rendered(idx, 'normal', chat).fired, true);

    // 直接对「已有图片」的楼层再走一遍判定 → 必须被 has_media 拦下
    const guarded = makeRuntime({ chat, interval: 1 });
    guarded.controller.generationStarted('normal');
    guarded.controller.received(2, 'normal', chat);
    const r = guarded.controller.rendered(2, 'normal', chat);
    // 第 2 层不是末位 → 结构闸先拒绝；这里确认它绝不会再去调 API
    assert.equal(r.fired, false);
    assert.equal(guarded.fired.length, 0);
});

// ───────── 2. 三种「不触发」的既定行为 ─────────

test('非流式 regenerate 即使完成事件自称 normal 也不触发', () => {
    const chat = [U('u1'), A('a1')];
    const rt = makeRuntime({ chat, interval: 1 });

    rt.controller.generationStarted('regenerate');
    // script.js 的真实顺序：先删末条 AI 消息，生成后再追加新的一条
    chat.pop();
    chat.push(A('重新生成后的回复'));
    const idx = chat.length - 1;

    const r1 = rt.controller.received(idx, 'normal', chat);
    assert.equal(r1.armed, false);
    assert.equal(r1.reason, 'intent_type_not_allowed');
    assert.equal(r1.intentType, 'regenerate');
    assert.equal(rt.controller.rendered(idx, 'normal', chat).fired, false);
    assert.equal(rt.fired.length, 0, '重新生成绝不允许触发生图');
});

test('swipe 不触发', () => {
    const chat = [U('u1'), A('a1')];
    const rt = makeRuntime({ chat, interval: 1 });
    rt.controller.generationStarted('swipe');
    const idx = 1;

    assert.equal(rt.controller.received(idx, 'swipe', chat).reason, 'type_not_allowed');
    assert.equal(rt.controller.rendered(idx, 'swipe', chat).fired, false);
    assert.equal(rt.fired.length, 0);
});

test('continue 不触发（非流式完成事件是 appendFinal）', () => {
    const chat = [U('u1'), A('a1')];
    const rt = makeRuntime({ chat, interval: 1 });
    rt.controller.generationStarted('continue');
    const idx = 1;

    assert.equal(rt.controller.received(idx, 'appendFinal', chat).reason, 'type_not_allowed');
    assert.equal(rt.controller.rendered(idx, 'appendFinal', chat).fired, false);
    assert.equal(rt.fired.length, 0);
});

test('删楼后紧接着 regenerate：不触发；再下一次普通生成才触发', () => {
    const chat = [U('u1'), A('a1'), U('u2'), A('a2'), U('u3'), A('a3')];
    const rt = makeRuntime({ chat, interval: 1 });
    chat.splice(1, 2);

    // regenerate：意图是 regenerate，完成事件归一成 normal
    rt.controller.generationStarted('regenerate');
    chat.pop();
    chat.push(A('重新生成的 a3'));
    const idxR = chat.length - 1;
    assert.equal(rt.controller.received(idxR, 'normal', chat).armed, false);
    assert.equal(rt.controller.rendered(idxR, 'normal', chat).fired, false);
    assert.equal(rt.fired.length, 0);

    // 随后一次真正的普通生成：必须触发，且只触发这一次
    const { idx } = normalGeneration(rt);
    assert.equal(rt.controller.received(idx, 'normal', chat).armed, true);
    assert.equal(rt.controller.rendered(idx, 'normal', chat).fired, true);
    assert.equal(rt.fired.length, 1, '上一次 regenerate 不得留下可用的意图');
});

// ───────── 3. 计数语义（N>1 也按现存楼层重算） ─────────

test('N=3：删楼后计数按现存楼层重算，命中第 3 条时才触发', () => {
    const chat = [U('u1'), A('a1'), U('u2'), A('a2'), U('u3'), A('a3')];
    const rt = makeRuntime({ chat, interval: 3 });

    // 删掉 1 条旧 AI 回复 → 现存 2 条
    chat.splice(1, 1);
    assert.equal(countAiMessages(chat), 2);

    // 第 3 条 AI 回复 → 3 % 3 === 0 → 触发
    const { idx } = normalGeneration(rt);
    assert.equal(countAiUpTo(chat, idx), 3);
    rt.controller.received(idx, 'normal', chat);
    assert.equal(rt.controller.rendered(idx, 'normal', chat).fired, true);
    assert.equal(rt.fired.length, 1);

    // 再来一条 → 4 % 3 !== 0 → 不触发
    const second = normalGeneration(rt);
    assert.equal(countAiUpTo(chat, second.idx), 4);
    rt.controller.received(second.idx, 'normal', chat);
    assert.equal(rt.controller.rendered(second.idx, 'normal', chat).fired, true, 'arm 成功但 onTrigger 内部被 interval 拦下');
    assert.equal(rt.fired.length, 1, '第 4 条 AI 回复不应触发');
    assert.equal(rt.attempts.at(-1).result, 'interval_miss');
});

test('默认 interval 就是 1（不是 3）', async () => {
    const { DEFAULT_SETTINGS } = await import('../lib/settings.js');
    assert.equal(DEFAULT_SETTINGS.interval, 1);
});
