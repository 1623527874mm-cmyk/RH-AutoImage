import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRenderedText, isTriggerableMessage } from '../lib/core.js';
import {
    createTriggerGate, createTriggerController,
    isAllowedGenType, ALLOWED_GEN_TYPES, NO_MESSAGE_GEN_TYPES,
    DEFAULT_ARM_TTL_MS, DEFAULT_INTENT_TTL_MS,
} from '../lib/trigger.js';

const A = (mes, extra = {}) => ({ mes, is_user: false, name: 'char', swipe_id: 0, extra });
const U = (mes) => ({ mes, is_user: true, swipe_id: 0 });
const S = (mes) => ({ mes, is_system: true, swipe_id: 0 });

/** 造一个 controllable clock */
function clock(start = 1_000_000) {
    let t = start;
    const now = () => t;
    now.advance = (ms) => { t += ms; return t; };
    return now;
}

/** 造一个控制器 + 记录器 */
function harness({ text = '渲染后的正文', now = clock(), armTtlMs = DEFAULT_ARM_TTL_MS, intentTtlMs = DEFAULT_INTENT_TTL_MS } = {}) {
    const triggers = [];
    const reads = [];
    const controller = createTriggerController({
        readText: (idx) => { reads.push(idx); return text; },
        onTrigger: (idx, t) => triggers.push({ idx, text: t }),
        now,
        armTtlMs,
        intentTtlMs,
    });
    return { controller, triggers, reads, now };
}

// ───────── 1. 生成类型白名单 ─────────

test('只有 normal 允许触发；其余类型一律不允许', () => {
    assert.deepEqual([...ALLOWED_GEN_TYPES], ['normal']);
    assert.equal(isAllowedGenType('normal'), true);
    for (const t of ['continue', 'swipe', 'regenerate', 'command', 'appendFinal',
        'first_message', 'impersonate', 'quiet', '', null, undefined, 'NORMAL ']) {
        assert.equal(isAllowedGenType(t), false, `类型 ${String(t)} 不应允许触发`);
    }
});

// ───────── 2. 普通生成只触发一次 ─────────

test('普通生成：GENERATION_STARTED → RECEIVED → RENDERED 触发一次，正文取自 readText', () => {
    const chat = [U('hi'), A('回复一')];
    const h = harness({ text: '  渲染后的正文\r\n第二行  ' });

    h.controller.generationStarted('normal');
    const r1 = h.controller.received(1, 'normal', chat);
    assert.equal(r1.armed, true);
    assert.deepEqual(h.reads, [], 'MESSAGE_RECEIVED 阶段绝不读 DOM');
    assert.deepEqual(h.triggers, [], 'MESSAGE_RECEIVED 阶段绝不触发');

    const r2 = h.controller.rendered(1, 'normal', chat);
    assert.equal(r2.fired, true);
    assert.deepEqual(h.triggers, [{ idx: 1, text: '  渲染后的正文\r\n第二行  ' }]);
    assert.deepEqual(h.reads, [1], '只在 RENDERED 阶段读一次 DOM');
});

test('普通生成完整链路只触发一次（重复 RENDERED 也不会再触发）', () => {
    const chat = [U('hi'), A('回复一')];
    const h = harness();

    h.controller.generationStarted('normal');
    h.controller.received(1, 'normal', chat);
    assert.equal(h.controller.rendered(1, 'normal', chat).fired, true);
    const second = h.controller.rendered(1, 'normal', chat);
    assert.equal(second.fired, false);
    assert.equal(second.reason, 'not_armed');
    assert.equal(h.triggers.length, 1, '只触发一次');
    assert.equal(h.reads.length, 1, '第二次不再读 DOM');
});

test('未预备（没有 RECEIVED）时，孤立 RENDERED 不触发', () => {
    const chat = [U('hi'), A('回复一')];
    const h = harness();
    const r = h.controller.rendered(1, 'normal', chat);
    assert.equal(r.fired, false);
    assert.equal(r.reason, 'not_armed');
    assert.equal(h.triggers.length, 0);
    assert.equal(h.reads.length, 0);
});

// ───────── 3. 生成意图闸（本次修复的核心）─────────

test('★ 非流式 regenerate：完成事件 type 被归一为 normal，仍必须拦截', () => {
    // 场景复现 ST 1.18.0 真实行为：
    //   Generate('regenerate') → GENERATION_STARTED('regenerate')
    //   → 删除末条 AI 消息 → 重新生成 → saveReply 把 type 归一成 'normal'
    //   → MESSAGE_RECEIVED(idx, 'normal')
    const chat = [U('hi'), A('重新生成的回复')];
    const h = harness();

    h.controller.generationStarted('regenerate');
    const r1 = h.controller.received(1, 'normal', chat);   // 完成事件说 normal
    assert.equal(r1.armed, false, '不得因为完成事件说 normal 就放行');
    assert.equal(r1.reason, 'intent_type_not_allowed');
    assert.equal(r1.intentType, 'regenerate');

    const r2 = h.controller.rendered(1, 'normal', chat);
    assert.equal(r2.fired, false);
    assert.equal(h.reads.length, 0, '不得读 DOM');
    assert.equal(h.triggers.length, 0, '不得生图');
});

test('★ 非流式 continue：GENERATION_STARTED(continue) → RECEIVED(appendFinal) 不触发', () => {
    const chat = [U('hi'), A('被续写的回复')];
    const h = harness();
    h.controller.generationStarted('continue');
    const r = h.controller.received(1, 'appendFinal', chat);
    assert.equal(r.armed, false);
    // 完成事件类型本身非法：类型闸先挡（不消费意图）
    assert.equal(r.reason, 'type_not_allowed');
    assert.equal(h.controller.gate.peekIntent().type, 'continue', '意图保留，由下一轮 STARTED 覆盖或 TTL 清理');
    assert.equal(h.triggers.length, 0);
    assert.equal(h.reads.length, 0);
});

test('★ 非流式 swipe：GENERATION_STARTED(swipe) → RECEIVED(swipe) 不触发', () => {
    const chat = [U('hi'), A('第 0 条 swipe')];
    const h = harness();
    h.controller.generationStarted('swipe');
    const r = h.controller.received(1, 'swipe', chat);
    assert.equal(r.armed, false);
    assert.equal(r.reason, 'type_not_allowed');
    assert.equal(h.controller.gate.peekIntent().type, 'swipe');
    assert.equal(h.triggers.length, 0);
});

test('★ dryRun 生成（只算 token）不留意图，因此不触发', () => {
    const chat = [U('hi'), A('回复')];
    const h = harness();
    const noted = h.controller.generationStarted('normal', true);
    assert.equal(noted.noted, false);
    assert.equal(noted.reason, 'dry_run');
    const r = h.controller.received(1, 'normal', chat);
    assert.equal(r.armed, false);
    assert.equal(r.reason, 'no_generation_intent');
    assert.equal(h.triggers.length, 0);
});

test('★ 没有 GENERATION_STARTED 就来的 RECEIVED 不放行（无意图即拒绝）', () => {
    const chat = [U('hi'), A('回复')];
    const h = harness();
    const r = h.controller.received(1, 'normal', chat);
    assert.equal(r.armed, false);
    assert.equal(r.reason, 'no_generation_intent');
    assert.equal(h.controller.rendered(1, 'normal', chat).fired, false);
    assert.equal(h.triggers.length, 0);
    assert.equal(h.reads.length, 0);
});

test('★ 意图只能消费一次：第二次 RECEIVED 无意图不放行', () => {
    const chat = [U('hi'), A('回复')];
    const h = harness();
    h.controller.generationStarted('normal');
    assert.equal(h.controller.received(1, 'normal', chat).armed, true);
    const second = h.controller.received(1, 'normal', chat);
    assert.equal(second.armed, false);
    assert.equal(second.reason, 'no_generation_intent');
});

test('★ 意图过期（超过 intentTtlMs）不放行', () => {
    const chat = [U('hi'), A('回复')];
    const now = clock();
    const h = harness({ now, intentTtlMs: 600_000 });
    h.controller.generationStarted('normal');
    now.advance(600_001);
    const r = h.controller.received(1, 'normal', chat);
    assert.equal(r.armed, false);
    assert.equal(r.reason, 'intent_expired');
    assert.equal(h.triggers.length, 0);
});

test('★ 新意图覆盖旧意图（单槽位，不排队）', () => {
    const chat = [U('hi'), A('回复')];
    const h = harness();
    h.controller.generationStarted('regenerate');
    h.controller.generationStarted('normal');
    const r = h.controller.received(1, 'normal', chat);
    assert.equal(r.armed, true, '以最后一次意图为准');
});

test('★ quiet / impersonate 不产出消息，因此不顶掉已有的 normal 意图', () => {
    assert.deepEqual([...NO_MESSAGE_GEN_TYPES], ['quiet', 'impersonate']);
    const chat = [U('hi'), A('回复')];
    const h = harness();
    h.controller.generationStarted('normal');
    assert.equal(h.controller.generationStarted('quiet').noted, false);
    assert.equal(h.controller.generationStarted('impersonate').noted, false);
    assert.equal(h.controller.received(1, 'normal', chat).armed, true, 'normal 意图必须还在');
    assert.equal(h.controller.rendered(1, 'normal', chat).fired, true);
});

test('★ dryRun 不顶掉已有的 normal 意图', () => {
    const chat = [U('hi'), A('回复')];
    const h = harness();
    h.controller.generationStarted('normal');
    h.controller.generationStarted('normal', true);
    assert.equal(h.controller.received(1, 'normal', chat).armed, true);
});

test('★ GENERATION_STOPPED 清空意图，之后 RECEIVED 不放行', () => {
    const chat = [U('hi'), A('回复')];
    const h = harness();
    h.controller.generationStarted('normal');
    h.controller.generationStopped();
    const r = h.controller.received(1, 'normal', chat);
    assert.equal(r.armed, false);
    assert.equal(r.reason, 'no_generation_intent');
});

test('★ regenerate 之后紧接着普通生成：只有后一次触发', () => {
    const chat = [U('hi'), A('重新生成后又被正常发送的新回复')];
    const h = harness();

    h.controller.generationStarted('regenerate');
    assert.equal(h.controller.received(1, 'normal', chat).armed, false);

    h.controller.generationStarted('normal');
    assert.equal(h.controller.received(1, 'normal', chat).armed, true);
    assert.equal(h.controller.rendered(1, 'normal', chat).fired, true);
    assert.equal(h.triggers.length, 1, '整段只触发一次');
});

test('★ reset()（切换聊天）清空意图与预备', () => {
    const chat = [U('hi'), A('回复')];
    const h = harness();
    h.controller.generationStarted('normal');
    h.controller.received(1, 'normal', chat);
    h.controller.reset();
    assert.equal(h.controller.gate.peek(), null);
    assert.equal(h.controller.gate.peekIntent(), null);
    assert.equal(h.controller.rendered(1, 'normal', chat).fired, false);
});

// ───────── 4. 其它路径不触发 ─────────

// 完成事件伪装成 normal（真实场景：这些生成的完成事件也可能发 normal 或被归一成 normal），
// 必须靠意图类型拦下来。
for (const type of ['regenerate', 'swipe', 'continue', 'appendFinal', 'command', 'first_message']) {
    test(`意图是 ${type}（完成事件自称 normal）不触发，且意图被消费`, () => {
        const chat = [U('hi'), A('回复一')];
        const h = harness();

        h.controller.generationStarted(type);
        const r1 = h.controller.received(1, 'normal', chat);
        assert.equal(r1.armed, false);
        assert.equal(r1.reason, 'intent_type_not_allowed');
        assert.equal(r1.intentType, type);
        assert.equal(h.controller.gate.peekIntent(), null, '意图必须被消费，不得留给后续普通回复');

        const r2 = h.controller.rendered(1, 'normal', chat);
        assert.equal(r2.fired, false);
        assert.equal(h.reads.length, 0, '不得读 DOM');
        assert.equal(h.triggers.length, 0, '不得触发');
    });
}

// 完成事件本身就是非法类型（ST 真实会这样发：'swipe' / 'command' / 'first_message'）
for (const badType of ['swipe', 'command', 'first_message', 'appendFinal', 'extension']) {
    test(`完成事件 type=${badType} 不触发、不读 DOM、且不消费意图`, () => {
        const chat = [U('hi'), A('回复一')];
        const h = harness();
        h.controller.generationStarted('normal');

        const r1 = h.controller.received(1, badType, chat);
        assert.equal(r1.armed, false);
        assert.equal(r1.reason, 'type_not_allowed');
        assert.notEqual(h.controller.gate.peekIntent(), null, '意图必须保留');
        assert.equal(h.controller.gate.peekIntent().type, 'normal');

        assert.equal(h.controller.rendered(1, badType, chat).fired, false);
        assert.equal(h.reads.length, 0);
        assert.equal(h.triggers.length, 0);
    });
}

test('impersonate 不触发（该类型不产出消息，不记录意图）', () => {
    const chat = [U('hi'), A('回复一')];
    const h = harness();
    assert.equal(h.controller.generationStarted('impersonate').reason, 'no_message_type');
    const r = h.controller.received(1, 'impersonate', chat);
    assert.equal(r.armed, false);
    assert.equal(r.reason, 'type_not_allowed');
    assert.equal(h.controller.gate.peekIntent(), null, '从未记录意图');
    assert.equal(h.controller.rendered(1, 'impersonate', chat).fired, false);
    assert.equal(h.reads.length, 0);
    assert.equal(h.triggers.length, 0);
});

test('完成事件 type 不在白名单（即便意图是 normal）也不放行，且意图保留', () => {
    const chat = [U('hi'), A('回复一')];
    const h = harness();
    h.controller.generationStarted('normal');
    const r = h.controller.received(1, 'swipe', chat);
    assert.equal(r.armed, false);
    assert.equal(r.reason, 'type_not_allowed');
    assert.equal(h.controller.gate.peekIntent().type, 'normal', 'D5：类型闸先于意图消费');
});

// ───────── 4.5 D5 专项：非法完成事件不得偷走待处理意图 ─────────

for (const stealType of ['command', 'first_message']) {
    test(`★ D5：STARTED(normal) → RECEIVED(${stealType}) 保留意图 → 随后 normal 完成只触发一次`, () => {
        const chat = [U('hi'), A('真实回复')];
        const h = harness({ text: '真实正文' });

        h.controller.generationStarted('normal');

        // ① 非普通完成事件插进来（/sendas、/narrator、first_message 等）。
        //    结构闸会放行（is_user=false / is_system=false / swipe_id=0 / 位于末位），
        //    只能靠类型闸挡；且**绝不能**消费意图。
        const steal = h.controller.received(1, stealType, chat);
        assert.equal(steal.armed, false);
        assert.equal(steal.reason, 'type_not_allowed');
        assert.notEqual(h.controller.gate.peekIntent(), null, '意图不得被偷走');
        assert.equal(h.controller.gate.peekIntent().type, 'normal');
        assert.equal(h.reads.length, 0, '不读 DOM');
        assert.equal(h.triggers.length, 0, '不触发');

        // ② 本轮真正的普通生成完成事件到达。
        const real = h.controller.received(1, 'normal', chat);
        assert.equal(real.armed, true, '意图仍在，必须能预备');
        assert.equal(h.controller.rendered(1, 'normal', chat).fired, true);
        assert.equal(h.triggers.length, 1, '整段只触发一次');
        assert.deepEqual(h.triggers[0], { idx: 1, text: '真实正文' });
        assert.equal(h.reads.length, 1);
    });
}

test('★ D5：多次非法完成事件连续插入，意图仍只被真正的那一次消费', () => {
    const chat = [U('hi'), A('真实回复')];
    const h = harness();
    h.controller.generationStarted('normal');

    assert.equal(h.controller.received(1, 'command', chat).reason, 'type_not_allowed');
    assert.equal(h.controller.received(1, 'first_message', chat).reason, 'type_not_allowed');
    assert.equal(h.controller.received(1, 'extension', chat).reason, 'type_not_allowed');
    assert.equal(h.controller.received(1, 'swipe', chat).reason, 'type_not_allowed');
    assert.equal(h.controller.gate.peekIntent().type, 'normal', '连敲四次仍未丢');

    assert.equal(h.controller.received(1, 'normal', chat).armed, true);
    assert.equal(h.controller.rendered(1, 'normal', chat).fired, true);
    assert.equal(h.triggers.length, 1);
});

test('★ D5：非法完成事件插进来后，regenerate 意图仍必须被消费并拒绝', () => {
    const chat = [U('hi'), A('重新生成的回复')];
    const h = harness();
    h.controller.generationStarted('regenerate');

    // 先插一个 command：类型闸挡下，意图（regenerate）保留
    assert.equal(h.controller.received(1, 'command', chat).reason, 'type_not_allowed');
    assert.equal(h.controller.gate.peekIntent().type, 'regenerate');

    // 再来的 normal 完成事件：必须消费掉 regenerate 意图并拒绝
    const r = h.controller.received(1, 'normal', chat);
    assert.equal(r.armed, false);
    assert.equal(r.reason, 'intent_type_not_allowed');
    assert.equal(r.intentType, 'regenerate');
    assert.equal(h.controller.gate.peekIntent(), null, 'regenerate 意图必须被消费，不得留给后续');
    assert.equal(h.controller.rendered(1, 'normal', chat).fired, false);
    assert.equal(h.reads.length, 0);
    assert.equal(h.triggers.length, 0);
});

test('★ D5：被拒绝后紧接一轮新普通生成，只由新一轮触发（无意图错配）', () => {
    const chat = [U('hi'), A('回复')];
    const h = harness();

    h.controller.generationStarted('normal');
    h.controller.gate.takeIntent();          // 模拟意图被某轮消耗掉（中止/丢失）
    assert.equal(h.controller.received(1, 'normal', chat).reason, 'no_generation_intent');

    h.controller.generationStarted('normal');
    assert.equal(h.controller.received(1, 'normal', chat).armed, true);
    assert.equal(h.controller.rendered(1, 'normal', chat).fired, true);
    assert.equal(h.triggers.length, 1, '整个过程中只触发一次');
});

test('★ D5：结构闸先于类型闸（历史楼层 + 非法 type 时返回 not_triggerable，不碰意图）', () => {
    const chat = [U('u1'), A('a1'), U('u2'), A('a2')];
    const h = harness();
    h.controller.generationStarted('normal');
    const r = h.controller.received(1, 'command', chat);   // 历史楼层
    assert.equal(r.reason, 'not_triggerable');
    assert.equal(h.controller.gate.peekIntent().type, 'normal');
});

test('★ D5：孤立非法完成事件（无意图）不触发也不产生新状态', () => {
    const chat = [U('hi'), A('回复')];
    const h = harness();
    assert.equal(h.controller.received(1, 'command', chat).reason, 'type_not_allowed');
    assert.equal(h.controller.gate.peekIntent(), null);
    assert.equal(h.controller.rendered(1, 'command', chat).fired, false);
    assert.equal(h.triggers.length, 0);
});

test('swipe 到非第 0 条 swipe 的楼层不触发', () => {
    const chat = [U('hi'), { mes: 'swipe2', is_user: false, swipe_id: 1 }];
    const h = harness();
    h.controller.generationStarted('normal');
    const r1 = h.controller.received(1, 'normal', chat);
    assert.equal(r1.armed, false);
    assert.equal(r1.reason, 'not_triggerable');
    assert.equal(h.triggers.length, 0);
});

// ───────── 5. 用户消息 / 系统消息不触发 ─────────

test('用户消息不触发', () => {
    const chat = [A('a1'), U('用户刚发的')];
    const h = harness();
    h.controller.generationStarted('normal');
    assert.equal(h.controller.received(1, 'normal', chat).armed, false);
    assert.equal(h.controller.rendered(1, 'normal', chat).fired, false);
    assert.equal(h.triggers.length, 0);
    assert.equal(h.reads.length, 0);
});

test('系统消息不触发', () => {
    const chat = [U('u'), S('系统提示')];
    const h = harness();
    h.controller.generationStarted('normal');
    assert.equal(h.controller.received(1, 'normal', chat).armed, false);
    assert.equal(h.controller.rendered(1, 'normal', chat).fired, false);
    assert.equal(h.triggers.length, 0);
});

// ───────── 6. 预备早于渲染：不提前读 DOM ─────────

test('RECEIVED 早于 RENDERED 时，DOM 只在 RENDERED 后读取', () => {
    const chat = [U('hi'), A('回复一')];
    const order = [];
    const controller = createTriggerController({
        readText: (idx) => { order.push('read'); return '正文'; },
        onTrigger: () => order.push('trigger'),
        now: clock(),
    });

    controller.generationStarted('normal');
    controller.received(1, 'normal', chat);
    order.push('received-done');
    assert.deepEqual(order, ['received-done'], '此时不应有任何 DOM 读取或触发');

    controller.rendered(1, 'normal', chat);
    assert.deepEqual(order, ['received-done', 'read', 'trigger']);
});

// ───────── 7. 预备事件超时后不触发 ─────────

test('预备事件超时后不触发', () => {
    const chat = [U('hi'), A('回复一')];
    const now = clock();
    const h = harness({ now, armTtlMs: 10_000 });

    h.controller.generationStarted('normal');
    h.controller.received(1, 'normal', chat);
    now.advance(10_001);

    const r = h.controller.rendered(1, 'normal', chat);
    assert.equal(r.fired, false);
    assert.equal(r.reason, 'arm_expired');
    assert.equal(h.reads.length, 0, '过期后不读 DOM');
    assert.equal(h.triggers.length, 0);
    assert.equal(h.controller.gate.peek(), null, '过期后预备状态被清空');
});

test('预备刚好在有效期内仍然触发', () => {
    const chat = [U('hi'), A('回复一')];
    const now = clock();
    const h = harness({ now, armTtlMs: 10_000 });
    h.controller.generationStarted('normal');
    h.controller.received(1, 'normal', chat);
    now.advance(10_000);
    assert.equal(h.controller.rendered(1, 'normal', chat).fired, true);
});

// ───────── 8. DOM 为空 / 不存在 → 不计数、不调用后续 ─────────

for (const [label, text] of [['null（节点不存在）', null], ['空字符串', ''], ['全空白', '   \n\n  ']]) {
    test(`正文读取失败（${label}）时不触发、不计数`, () => {
        const chat = [U('hi'), A('回复一')];
        const h = harness({ text });
        h.controller.generationStarted('normal');
        h.controller.received(1, 'normal', chat);
        const r = h.controller.rendered(1, 'normal', chat);
        assert.equal(r.fired, false);
        assert.equal(r.reason, 'empty_text');
        assert.equal(h.triggers.length, 0, '不得调用 onTrigger（即不得计数/写标记/调 API）');
    });
}

test('readText 抛异常时按读取失败处理，不触发', () => {
    const chat = [U('hi'), A('回复一')];
    const triggers = [];
    const controller = createTriggerController({
        readText: () => { throw new Error('DOM boom'); },
        onTrigger: () => triggers.push(1),
        now: clock(),
    });
    controller.generationStarted('normal');
    controller.received(1, 'normal', chat);
    const r = controller.rendered(1, 'normal', chat);
    assert.equal(r.fired, false);
    assert.equal(r.reason, 'empty_text');
    assert.equal(triggers.length, 0);
});

// ───────── 9. 控制器内部幂等（★ 注意：这不是初始化幂等测试）─────────

test('同一控制器重复 received 不会累积多个待执行触发（控制器语义，非 init 幂等）', () => {
    const chat = [U('hi'), A('回复一')];
    const h = harness();
    h.controller.generationStarted('normal');
    h.controller.received(1, 'normal', chat);
    assert.equal(h.controller.received(1, 'normal', chat).reason, 'no_generation_intent');
    assert.equal(h.controller.received(1, 'normal', chat).reason, 'no_generation_intent');
    h.controller.rendered(1, 'normal', chat);
    h.controller.rendered(1, 'normal', chat);
    assert.equal(h.triggers.length, 1, '多次放行，只触发一次');
});

test('闸门是单槽位：新预备会覆盖旧预备，不会排队', () => {
    const gate = createTriggerGate({ now: clock() });
    gate.arm({ mesId: 3, type: 'normal' });
    gate.arm({ mesId: 4, type: 'normal' });
    assert.equal(gate.peek().mesId, 4);
    assert.equal(gate.confirm({ mesId: 3, type: 'normal' }).fire, false, '旧楼层不再放行');
});

test('闸门意图也只能消费一次', () => {
    const gate = createTriggerGate({ now: clock() });
    gate.noteGeneration({ type: 'normal' });
    assert.equal(gate.takeIntent().type, 'normal');
    assert.equal(gate.takeIntent(), null);
});

// ───────── 10. 非末尾楼层不触发 ─────────

test('只有最末一条楼层可以触发（历史楼层一律拒绝）', () => {
    const chat = [U('u1'), A('a1'), U('u2'), A('a2')];
    const h = harness();
    h.controller.generationStarted('normal');
    assert.equal(h.controller.received(1, 'normal', chat).armed, false);
    assert.equal(isTriggerableMessage(chat[1], 1, chat.length), false);
    assert.equal(isTriggerableMessage(chat[3], 3, chat.length), true);
});

// ───────── 11. 正文规范化只做三件事 ─────────

test('normalizeRenderedText：只转 CRLF/CR 并 trim，不压缩空行', () => {
    assert.equal(normalizeRenderedText('a\r\nb'), 'a\nb');
    assert.equal(normalizeRenderedText('a\rb'), 'a\nb');
    assert.equal(normalizeRenderedText('  a  '), 'a');
    assert.equal(normalizeRenderedText('a\n\n\n\nb'), 'a\n\n\n\nb', '连续空行必须保留');
    assert.equal(normalizeRenderedText('a\n   \nb'), 'a\n   \nb', '行内空白必须保留');
    assert.equal(normalizeRenderedText('\n\n  x  \n\n'), 'x');
});

test('normalizeRenderedText：非字符串输入返回空串', () => {
    for (const v of [null, undefined, 0, {}, []]) {
        assert.equal(normalizeRenderedText(v), '');
    }
});

test('normalizeRenderedText：不剥离标签（剥离是渲染器的职责）', () => {
    assert.equal(normalizeRenderedText('<scene_time>x</scene_time>\n正文'),
        '<scene_time>x</scene_time>\n正文');
});
