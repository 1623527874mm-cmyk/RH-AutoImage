// jobs.test.js — 任务运行时状态 + 图片写回安全。全部离线：假 api、假图片保存，不触网。
//
// 覆盖本阶段的硬性要求：
//   · 运行状态只存内存，绝不写进 message.extra，也不触发聊天保存
//   · 切换聊天 / 删除楼层 / 内容变化 / 索引漂移 / 重复完成事件 → 丢弃结果
//   · 有效任务正常挂图（且只挂一次、只存盘一次）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    createJobStore, chatRefKey, isSameChat, planAttach, applyMediaEntry, runImageJob,
    ACTIVE_STATUSES, JOB_FIELDS,
} from '../lib/jobs.js';
import { hashText } from '../lib/core.js';

const REF = 'char:chatA:小雅';
const OTHER_REF = 'char:chatB:小雅';

function aiMsg(mes = '她靠在窗边看着外面。') {
    return { mes, is_user: false, is_system: false, name: '小雅', extra: {} };
}

/** 造一条完整任务 + 假依赖；activeRefKey 用可变闭包模拟「切换聊天」。 */
function harness({ chat, urls = ['https://rh.example/1.png'], activeRefKey = REF } = {}) {
    const store = createJobStore();
    const state = {
        chat,
        activeRefKey,
        calls: { prompt: 0, submit: 0, poll: 0, save: 0, chatSave: 0, attach: [] },
        savedMessages: [],
    };
    const msg = chat[0];
    const job = store.start({
        jobId: 'job-1',
        refKey: REF,
        isGroup: false,
        characterName: '小雅',
        mesIndex: 0,
        mesHash: hashText(msg.mes),
        mesText: '她靠在窗边看着外面。',
        status: 'pending',
        startedAt: 1000,
    });

    const api = {
        async generatePositivePrompt() { state.calls.prompt++; return 'masterpiece, 1girl, window light'; },
        async rhSubmit() { state.calls.submit++; return { taskId: 'TASK-1' }; },
        async rhPoll() { state.calls.poll++; return { results: urls.map(u => ({ fileUrl: u })) }; },
    };

    const deps = {
        api,
        store,
        settings: {
            positiveNodeId: '1195', positiveFieldName: 'text',
            negativeNodeId: '1018', negativeFieldName: 'text',
            negativePrompt: 'lowres',
            characterPersona: 'silver hair',
            positiveTemplate: 'template',
        },
        saveImage: async (url) => { state.calls.save++; return `/user/images/x/${url.split('/').pop()}`; },
        attachMedia: async (j, entry) => {
            state.calls.attach.push(entry.url);
            // 与 index.js 完全相同的判定路径
            const plan = planAttach({ job: j, activeRefKey: state.activeRefKey, chat: state.chat });
            if (!plan.ok) return { applied: false, reason: plan.reason };
            applyMediaEntry(plan.msg, entry);
            state.savedMessages.push(plan.msg);
            return { applied: true, index: plan.index };
        },
        saveChat: async () => { state.calls.chatSave++; },
        makeMedia: (path) => ({ url: path, type: 'image', title: 'x', source: 'generated' }),
        now: () => 2000,
    };

    return { store, job, deps, state };
}

// ───────────── 聊天标识 ─────────────

test('chatRefKey：同一聊天稳定，不同聊天/缺字段不相等', () => {
    const a = { isGroup: false, chatId: 'chatA', characterName: '小雅' };
    assert.equal(chatRefKey(a), REF);
    assert.equal(chatRefKey({ ...a }), REF);
    assert.notEqual(chatRefKey(a), chatRefKey({ ...a, chatId: 'chatB' }));
    assert.notEqual(chatRefKey(a), chatRefKey({ ...a, characterName: '别人' }));
    assert.equal(chatRefKey({ isGroup: false, characterName: '小雅' }), '', '缺 chatId 一律不写回');
    assert.equal(chatRefKey(null), '');
    assert.equal(isSameChat(REF, REF), true);
    assert.equal(isSameChat(REF, OTHER_REF), false);
    assert.equal(isSameChat('', ''), false);
    assert.equal(isSameChat(REF, ''), false);
});

// ───────────── 任务表 ─────────────

test('任务表：状态、取消、去重都在内存里', () => {
    const store = createJobStore();
    const job = store.start({
        jobId: 'j1', refKey: REF, mesIndex: 3, mesHash: 'h', status: 'pending',
    });
    assert.equal(store.get('j1'), job);
    assert.equal(store.isAlive('j1'), true);
    assert.equal(store.activeCount(REF), 1);
    assert.equal(store.activeCount(OTHER_REF), 0);

    store.update('j1', { status: 'queued', taskId: 'T' });
    assert.equal(store.get('j1').taskId, 'T');

    // 同楼层去重
    assert.equal(store.findByFloor(REF, 3), store.get('j1'));
    assert.equal(store.findByFloor(REF, 3, 'h'), store.get('j1'));
    assert.equal(store.findByFloor(REF, 3, 'other-hash'), null);
    assert.equal(store.findByFloor(REF, 4), null);

    store.cancel('j1', 'chat_changed');
    assert.equal(store.get('j1').cancelled, true);
    assert.equal(store.get('j1').cancelReason, 'chat_changed');
    assert.equal(store.get('j1').status, 'discarded');
    assert.equal(store.isAlive('j1'), false);
    assert.equal(store.activeCount(REF), 0);
    assert.equal(store.findByFloor(REF, 3), null, '已取消的任务不再去重');
});

test('任务表：cancelWhere 只动进行中的任务', () => {
    const store = createJobStore();
    store.start({ jobId: 'a', refKey: REF, mesIndex: 0, mesHash: 'h', status: 'queued' });
    store.start({ jobId: 'b', refKey: OTHER_REF, mesIndex: 1, mesHash: 'h', status: 'success' });
    const hit = store.cancelWhere(j => j.refKey === REF, 'chat_changed');
    assert.deepEqual(hit.map(j => j.jobId), ['a']);
    assert.equal(store.get('b').cancelled, false, '已结束的任务不受影响');
});

test('任务表：进程内状态不写消息对象（消息始终没有任务字段）', () => {
    const chat = [aiMsg()];
    const { job, deps } = harness({ chat });
    const before = JSON.stringify(chat);
    deps.store.update(job.jobId, { status: 'queued', taskId: 'TASK-1', error: 'x' });
    assert.equal(JSON.stringify(chat), before, '改状态不得触碰消息对象');
    assert.equal(chat[0].extra.rh_image_job, undefined);
    // 任务对象自身的字段是固定的那一组
    const extraKeys = Object.keys(deps.store.get(job.jobId)).filter(k => !JOB_FIELDS.includes(k));
    assert.deepEqual(extraKeys, ['appliedUrls'], '任务对象只多一个内存里的 appliedUrls');
});

// ───────────── 写回判定 ─────────────

test('写回判定：同聊天同楼层才通过', () => {
    const chat = [aiMsg('hello')];
    const job = { jobId: 'j', refKey: REF, mesIndex: 0, mesHash: hashText('hello') };
    const plan = planAttach({ job, activeRefKey: REF, chat });
    assert.equal(plan.ok, true);
    assert.equal(plan.index, 0);
    assert.equal(plan.msg, chat[0]);
});

test('写回判定：切换聊天 → chat_changed', () => {
    const chat = [aiMsg('hello')];
    const job = { jobId: 'j', refKey: REF, mesIndex: 0, mesHash: hashText('hello') };
    assert.deepEqual(
        planAttach({ job, activeRefKey: OTHER_REF, chat }),
        { ok: false, reason: 'chat_changed' },
    );
    assert.deepEqual(
        planAttach({ job, activeRefKey: '', chat }),
        { ok: false, reason: 'chat_changed' },
    );
});

test('写回判定：楼层被删 → floor_missing', () => {
    const job = { jobId: 'j', refKey: REF, mesIndex: 2, mesHash: hashText('gone') };
    assert.deepEqual(
        planAttach({ job, activeRefKey: REF, chat: [aiMsg('a'), aiMsg('b')] }),
        { ok: false, reason: 'floor_missing' },
    );
});

test('写回判定：索引漂移（前面楼层被删，位置换成了别的消息）→ content_changed', () => {
    const original = [aiMsg('第一层'), aiMsg('目标层'), aiMsg('第三层')];
    const job = { jobId: 'j', refKey: REF, mesIndex: 1, mesHash: hashText('目标层') };
    assert.equal(planAttach({ job, activeRefKey: REF, chat: original }).ok, true);

    // 删掉第 0 层：原目标层滑到 index 0，index 1 现在变成「第三层」
    const drifted = [aiMsg('目标层'), aiMsg('第三层')];
    assert.deepEqual(
        planAttach({ job, activeRefKey: REF, chat: drifted }),
        { ok: false, reason: 'content_changed' },
    );
});

test('写回判定：目标楼层被编辑 → content_changed', () => {
    const job = { jobId: 'j', refKey: REF, mesIndex: 0, mesHash: hashText('原文') };
    assert.deepEqual(
        planAttach({ job, activeRefKey: REF, chat: [aiMsg('原文被改过')] }),
        { ok: false, reason: 'content_changed' },
    );
});

test('写回判定：被删楼层位置换成了用户消息 → not_ai_message', () => {
    const job = { jobId: 'j', refKey: REF, mesIndex: 0, mesHash: hashText('用户说的话') };
    const chat = [{ mes: '用户说的话', is_user: true }];
    assert.deepEqual(
        planAttach({ job, activeRefKey: REF, chat }),
        { ok: false, reason: 'not_ai_message' },
    );
});

test('写回判定：已取消 / 无聊天 / 非法索引一律拒绝', () => {
    const chat = [aiMsg('x')];
    assert.deepEqual(planAttach({ job: null, activeRefKey: REF, chat }), { ok: false, reason: 'no_job' });
    assert.deepEqual(
        planAttach({ job: { jobId: 'j', refKey: REF, mesIndex: 0, mesHash: 'h', cancelled: true }, activeRefKey: REF, chat }),
        { ok: false, reason: 'cancelled' },
    );
    assert.deepEqual(
        planAttach({ job: { jobId: 'j', refKey: '', mesIndex: 0, mesHash: 'h' }, activeRefKey: REF, chat }),
        { ok: false, reason: 'no_chat_ref' },
    );
    assert.deepEqual(
        planAttach({ job: { jobId: 'j', refKey: REF, mesIndex: 0, mesHash: 'h' }, activeRefKey: REF, chat: null }),
        { ok: false, reason: 'no_chat' },
    );
    assert.deepEqual(
        planAttach({ job: { jobId: 'j', refKey: REF, mesIndex: -1, mesHash: 'h' }, activeRefKey: REF, chat }),
        { ok: false, reason: 'bad_index' },
    );
});

test('applyMediaEntry 只写酒馆原生媒体字段，不碰任务状态', () => {
    const msg = aiMsg('x');
    applyMediaEntry(msg, { url: '/a.png', type: 'image' });
    applyMediaEntry(msg, { url: '/b.png', type: 'image' });
    assert.deepEqual(msg.extra.media.map(m => m.url), ['/a.png', '/b.png']);
    assert.equal(msg.extra.media_index, 1);
    assert.equal(msg.extra.inline_image, true);
    assert.deepEqual(Object.keys(msg.extra).sort(), ['inline_image', 'media', 'media_index']);
    assert.equal('rh_image_job' in msg.extra, false);
});

// ───────────── 完整任务（假网络） ─────────────

test('有效任务：正常挂图一次，只存盘一次，消息里只有原生媒体字段', async () => {
    const chat = [aiMsg()];
    const { job, deps, state } = harness({ chat });
    const res = await runImageJob(job, deps);

    assert.equal(res.ok, true);
    assert.equal(res.saved, 1);
    assert.equal(state.calls.prompt, 1);
    assert.equal(state.calls.submit, 1);
    assert.equal(state.calls.poll, 1);
    assert.equal(state.calls.save, 1);
    assert.equal(state.calls.chatSave, 1, '挂图成功才存盘，且只存一次');
    assert.deepEqual(chat[0].extra.media.map(m => m.url), ['/user/images/x/1.png']);
    assert.equal('rh_image_job' in chat[0].extra, false, '任务状态绝不进消息');
    assert.equal(deps.store.get(job.jobId).status, 'success');
    assert.equal(deps.store.get(job.jobId).imageCount, 1);
});

test('未挂图时（聊天已切换）不存盘、不写消息', async () => {
    const chat = [aiMsg()];
    const { job, deps, state } = harness({ chat });
    state.activeRefKey = OTHER_REF; // 模拟轮询期间用户切走了

    const before = JSON.stringify(chat);
    const res = await runImageJob(job, deps);

    assert.equal(res.ok, false);
    assert.equal(state.calls.attach.length, 1, '下载完仍会尝试一次写回判定');
    assert.equal(state.calls.chatSave, 0, '没挂图就绝不触发聊天保存');
    assert.equal(JSON.stringify(chat), before, '消息对象一个字节都不许变');
    assert.equal(deps.store.get(job.jobId).status, 'failed');
    assert.match(deps.store.get(job.jobId).error, /无法挂载|chat_changed/);
});

test('目标楼层被删：丢弃结果，不存盘', async () => {
    const chat = [aiMsg('原文')];
    const { job, deps, state } = harness({ chat });
    state.chat = []; // 楼层没了

    const res = await runImageJob(job, deps);
    assert.equal(res.ok, false);
    assert.equal(state.calls.chatSave, 0);
    assert.equal(deps.store.get(job.jobId).status, 'failed');
});

test('目标楼层内容变化：丢弃结果，不存盘', async () => {
    const chat = [aiMsg('原文')];
    const { job, deps, state } = harness({ chat });
    state.chat = [aiMsg('被编辑成别的正文')];

    const res = await runImageJob(job, deps);
    assert.equal(res.ok, false);
    assert.equal(state.calls.chatSave, 0);
    assert.equal('media' in state.chat[0].extra, false, '不许挂到替换后的楼层上');
});

test('索引漂移：不许挂到相邻楼层', async () => {
    const target = aiMsg('目标层');
    const prev = aiMsg('前一层');
    const chat = [prev, target];
    const { job, deps, state } = harness({ chat });
    // 删掉前一层：目标层滑到 index 0，index 1 变成 undefined/别的楼层
    state.chat = [aiMsg('目标层'), aiMsg('新来的一层')];

    const res = await runImageJob(job, deps);
    assert.equal(res.ok, false);
    assert.equal(state.calls.chatSave, 0);
    assert.equal('media' in state.chat[0].extra, false, '不许因为内容巧合就挂上去');
    assert.equal('media' in state.chat[1].extra, false, '更不许挂到相邻楼层');
});

test('重复完成事件：同一个 job 只提交一次、只挂一次', async () => {
    const chat = [aiMsg()];
    const { job, deps, state } = harness({ chat });

    const first = await runImageJob(job, deps);
    const second = await runImageJob(job, deps); // 重复完成事件

    assert.equal(first.ok, true);
    assert.deepEqual(second, { ok: false, reason: 'already_done' });
    assert.equal(state.calls.submit, 1, '不得重复提交（避免重复计费）');
    assert.equal(state.calls.chatSave, 1);
    assert.equal(chat[0].extra.media.length, 1);
});

test('同一次轮询里出现重复图片地址：只下载并挂一次', async () => {
    const chat = [aiMsg()];
    const { job, deps, state } = harness({
        chat,
        urls: ['https://rh.example/1.png', 'https://rh.example/1.png'],
    });
    const res = await runImageJob(job, deps);
    assert.equal(res.saved, 1);
    assert.equal(state.calls.save, 1);
    assert.equal(state.calls.chatSave, 1);
    assert.equal(chat[0].extra.media.length, 1);
});

test('已取消的任务：连 DeepSeek 都不调用', async () => {
    const chat = [aiMsg()];
    const { job, deps, state } = harness({ chat });
    deps.store.cancel(job.jobId, 'chat_changed');

    const res = await runImageJob(job, deps);
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'chat_changed');
    assert.equal(state.calls.prompt, 0);
    assert.equal(state.calls.chatSave, 0);
});

test('轮询途中被取消：不发后续请求、不挂图', async () => {
    const chat = [aiMsg()];
    const { job, deps, state } = harness({ chat });
    deps.api.rhPoll = async () => {
        state.calls.poll++;
        deps.store.cancel(job.jobId, 'chat_changed'); // 下载前被切走
        return { results: [{ fileUrl: 'https://rh.example/1.png' }] };
    };

    const res = await runImageJob(job, deps);
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'chat_changed');
    assert.equal(state.calls.prompt + state.calls.submit, 2);
    assert.equal(state.calls.attach.length, 0, '取消后不再尝试写回');
    assert.equal(state.calls.chatSave, 0);
});

test('DeepSeek 失败：不提交 RunningHub、不挂图、不存盘', async () => {
    const chat = [aiMsg()];
    const { job, deps, state } = harness({ chat });
    deps.api.generatePositivePrompt = async () => { throw new Error('DeepSeek 返回 HTTP 500'); };

    const res = await runImageJob(job, deps);
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'failed');
    assert.equal(state.calls.submit, 0);
    assert.equal(state.calls.save, 0);
    assert.equal(state.calls.chatSave, 0);
    assert.equal(deps.store.get(job.jobId).status, 'failed');
});

test('生图成功但没有图片结果：不写消息、不存盘', async () => {
    const chat = [aiMsg()];
    const { job, deps, state } = harness({ chat, urls: [] });
    const res = await runImageJob(job, deps);
    assert.equal(res.ok, false);
    assert.equal(state.calls.chatSave, 0);
    assert.equal('media' in chat[0].extra, false);
});

test('运行中状态可见但在内存里：prompting → queued → rendering → success', async () => {
    const chat = [aiMsg()];
    const { job, deps, store } = harness({ chat });
    const seen = [];
    deps.api.generatePositivePrompt = async () => { seen.push(store.get(job.jobId).status); return 'a girl'; };
    deps.api.rhSubmit = async () => { seen.push(store.get(job.jobId).status); return { taskId: 'T' }; };
    deps.api.rhPoll = async () => { seen.push(store.get(job.jobId).status); return { results: [{ fileUrl: 'https://rh.example/1.png' }] }; };

    await runImageJob(job, deps);
    // 依次是：调用 DeepSeek 时 / 提交时 / 轮询时 的状态快照
    assert.deepEqual(seen, ['prompting', 'prompting', 'queued']);
    assert.equal(store.get(job.jobId).status, 'success');
    assert.equal(store.get(job.jobId).status, 'success');
    assert.ok(ACTIVE_STATUSES.includes('rendering'));
});
