import { beforeEach, describe, expect, it } from 'vitest';
import { useStore } from './useStore';
import { computePairs } from './selectors';
import { DEMO_START } from '../data/sampleData';

const s = () => useStore.getState();

describe('Zustand 工作流端到端', () => {
  beforeEach(() => {
    s().resetDemo();
    s().login('planner', 'demo1234');
  });

  it('候选 → 草稿 → 批准 → 出库 → 逐批签收全链路，正式库存按事件迁移', () => {
    const state = s();
    const cand = state.buildCandidates().candidates.find(
      (c) => c.id === 'CAND-S-CENTRAL-S-A-DRG-002',
    )!;
    expect(cand.qtyMin).toBe(100);
    s().addCandidateToDraft(cand);
    const draft = s().transfers.find((t) => t.candidateId === cand.id && t.status === 'draft')!;
    expect(draft).toBeDefined();

    // 草稿阶段不写正式库存
    expect(s().batches.find((b) => b.id === 'B-NTG-01' && b.siteId === 'S-CENTRAL')!.qtyMin).toBe(100);

    s().confirmDrafts([draft.id]);
    expect(s().transfers.find((t) => t.id === draft.id)!.status).toBe('approved');
    // 批准未出库仍不动正式库存
    expect(s().batches.find((b) => b.id === 'B-NTG-01' && b.siteId === 'S-CENTRAL')!.qtyMin).toBe(100);

    s().shipOrder(draft.id);
    expect(s().transfers.find((t) => t.id === draft.id)!.status).toBe('shipped');
    expect(s().batches.find((b) => b.id === 'B-NTG-01' && b.siteId === 'S-CENTRAL')!.qtyMin).toBe(0);

    // 逐批签收：90 收 + 5 损 + 5 待查 = 100
    s().receiveOrder(draft.id, [
      { batchId: 'B-NTG-01', receivedMin: 90, damagedMin: 5, quarantineMin: 5 },
    ]);
    const closed = s().transfers.find((t) => t.id === draft.id)!;
    expect(closed.status).toBe('received');
    expect(s().batches.find((b) => b.id === 'B-NTG-01' && b.siteId === 'S-A')!.qtyMin).toBe(90);
    // 待查 5 不回补来源
    expect(s().batches.find((b) => b.id === 'B-NTG-01' && b.siteId === 'S-CENTRAL')!.qtyMin).toBe(0);

    // 已结清单再次签收被拒
    const eventsBefore = s().events.length;
    s().receiveOrder(draft.id, [
      { batchId: 'B-NTG-01', receivedMin: 1, damagedMin: 0, quarantineMin: 0 },
    ]);
    expect(s().rejected.length).toBeGreaterThan(0);
    expect(s().events.length).toBe(eventsBefore);
  });

  it('双情景选择器在节点环境输出真实缺口', () => {
    const rows = computePairs(s().planningData(), {
      siteIds: ['S-B'],
      startDate: DEMO_START,
      horizonDays: 30,
    });
    const epi = rows.find((r) => r.drugCode === 'DRG-001')!;
    expect(epi.baseline.firstGapDate).toBe('2026-11-18');
    expect(epi.baseline.totalExpiredMin).toBe(16);
  });

  it('盘点使锁定草稿产生冲突原因、已批准单待复核，且数量不被静默修改', () => {
    const cand = s().buildCandidates().candidates.find(
      (c) => c.id === 'CAND-S-CENTRAL-S-A-DRG-001',
    )!;
    s().addCandidateToDraft(cand);
    const draft = s().transfers.find((t) => t.candidateId === cand.id)!;
    s().toggleLock(draft.id);

    // 先批准一张单子用于验证待复核标记
    const cand2 = s().buildCandidates().candidates.find(
      (c) => c.id === 'CAND-S-CENTRAL-S-A-DRG-004',
    )!;
    s().addCandidateToDraft(cand2);
    const draft2 = s().transfers.find((t) => t.candidateId === cand2.id)!;
    s().confirmDrafts([draft2.id]);

    // 盘点把 B-EPI-01 调减到 50（草稿需要 110）
    s().stocktake('S-CENTRAL', [{ batchId: 'B-EPI-01', newQtyMin: 50 }]);
    expect(s().transfers.find((t) => t.id === draft.id)!.invalid).toBe(true);
    const approved = s().transfers.find((t) => t.id === draft2.id)!;
    expect(approved.reviewRequired).toBe(true);
    expect(approved.lines[0].qtyApprovedMin).toBe(60); // 数量未被静默修改

    s().recalc();
    const locked = s().transfers.find((t) => t.id === draft.id)!;
    expect(locked.conflictReason).toContain('重算后真实余量仅');
  });

  it('只读观察员的写操作被拦截', () => {
    s().logout();
    s().login('viewer', 'view1234');
    const before = s().transfers.length;
    const cand = s().buildCandidates().candidates[0];
    s().addCandidateToDraft(cand);
    expect(s().transfers.length).toBe(before);
    expect(s().notice).toContain('只读');
  });
});
