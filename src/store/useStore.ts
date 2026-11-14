import { create } from 'zustand';
import {
  applyEvent,
  defaultReturnArrive,
  type AdapterState,
} from '../adapters/localEventAdapter';
import { generateCandidates } from '../domain/candidates';
import { addDays } from '../domain/date';
import {
  openingBatchesFor,
  routeKey,
  type PlanningData,
} from '../domain/projection';
import {
  createDemoData,
  demoAccounts,
  demoDemands,
  demoDrugs,
  demoInbounds,
  demoPackageSpecs,
  demoSites,
  demoTransport,
  DEMO_START,
  type DemoAccount,
} from '../data/sampleData';
import type {
  AllocationCandidate,
  Batch,
  DomainEvent,
  MissingConversionItem,
  ReceiveLineInput,
  RejectedEvent,
  TransferOrder,
} from '../domain/types';

interface AuthUser {
  username: string;
  displayName: string;
  role: DemoAccount['role'];
}

interface AppState {
  // 认证
  user: AuthUser | null;
  loginError: string | null;
  // 静态参考数据
  drugs: typeof demoDrugs;
  packageSpecs: typeof demoPackageSpecs;
  sites: typeof demoSites;
  transport: Record<string, number>;
  inbounds: typeof demoInbounds;
  demands: typeof demoDemands;
  missingConversions: MissingConversionItem[];
  // 适配器状态（正式库存 + 调拨台账 + 事件日志）
  batches: Batch[];
  transfers: TransferOrder[];
  events: DomainEvent[];
  rejected: RejectedEvent[];
  // 分析参数
  startDate: string;
  horizonDays: number;
  selectedSiteIds: string[];
  // 交互
  expandedKeys: Set<string>;
  seq: number;
  notice: string | null;

  login: (username: string, password: string) => boolean;
  logout: () => void;
  setStartDate: (d: string) => void;
  setHorizon: (n: number) => void;
  toggleSite: (id: string) => void;
  toggleExpanded: (key: string) => void;
  clearNotice: () => void;

  planningData: () => PlanningData;
  buildCandidates: () => ReturnType<typeof generateCandidates>;

  addCandidateToDraft: (c: AllocationCandidate) => void;
  removeDraft: (id: string) => void;
  toggleLock: (id: string) => void;
  recalc: () => void;
  confirmDrafts: (ids: string[]) => void;
  shipOrder: (id: string) => void;
  receiveOrder: (id: string, lines: ReceiveLineInput[]) => void;
  cancelOrder: (id: string) => void;
  registerReturn: (transferId: string, batchId: string, qty: number) => void;
  receiveReturn: (transferId: string, returnId: string) => void;
  stocktake: (siteId: string, adjustments: { batchId: string; newQtyMin: number }[]) => void;
  resetDemo: () => void;
}

const demo = createDemoData();

function nextId(seq: number, prefix: string): { id: string; seq: number } {
  return { id: `${prefix}-${2000 + seq}`, seq: seq + 1 };
}

function currentAdapter(s: AppState): AdapterState {
  return { batches: s.batches, transfers: s.transfers, events: s.events };
}

export const useStore = create<AppState>((set, get) => ({
  user: null,
  loginError: null,
  drugs: demoDrugs,
  packageSpecs: demoPackageSpecs,
  sites: demoSites,
  transport: demoTransport,
  inbounds: demoInbounds,
  demands: demoDemands,
  missingConversions: demo.missingConversions,
  batches: demo.batches,
  transfers: demo.transfers,
  events: demo.events,
  rejected: [],
  startDate: DEMO_START,
  horizonDays: 30,
  selectedSiteIds: ['S-CENTRAL', 'S-A', 'S-B', 'S-C'],
  expandedKeys: new Set<string>(),
  seq: 1,
  notice: null,

  login: (username, password) => {
    const acc = demoAccounts.find(
      (a) => a.username === username && a.password === password,
    );
    if (!acc) {
      set({ loginError: '账号或密码错误（演示账号见 README）' });
      return false;
    }
    set({
      user: { username: acc.username, displayName: acc.displayName, role: acc.role },
      loginError: null,
    });
    return true;
  },
  logout: () => set({ user: null }),

  setStartDate: (d) => set({ startDate: d }),
  setHorizon: (n) => set({ horizonDays: Math.min(90, Math.max(7, n)) }),
  toggleSite: (id) =>
    set((s) => ({
      selectedSiteIds: s.selectedSiteIds.includes(id)
        ? s.selectedSiteIds.filter((x) => x !== id)
        : [...s.selectedSiteIds, id],
    })),
  toggleExpanded: (key) =>
    set((s) => {
      const next = new Set(s.expandedKeys);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return { expandedKeys: next };
    }),
  clearNotice: () => set({ notice: null, rejected: [] }),

  planningData: () => {
    const s = get();
    return {
      batches: s.batches,
      demands: s.demands,
      inbounds: s.inbounds,
      transfers: s.transfers,
      transport: s.transport,
    };
  },

  buildCandidates: () => {
    const s = get();
    return generateCandidates(s.planningData(), s.sites, {
      siteIds: s.selectedSiteIds,
      startDate: s.startDate,
      horizonDays: s.horizonDays,
    });
  },

  addCandidateToDraft: (c) => {
    const s = get();
    if (s.user?.role === 'viewer') {
      set({ notice: '只读观察员不能编辑草稿' });
      return;
    }
    if (s.transfers.some((t) => t.candidateId === c.id && t.status === 'draft')) {
      set({ notice: '该候选已在草稿中，不重复加入' });
      return;
    }
    const { id, seq } = nextId(s.seq, 'T');
    const order: TransferOrder = {
      id,
      candidateId: c.id,
      fromSiteId: c.fromSiteId,
      toSiteId: c.toSiteId,
      drugCode: c.drugCode,
      plannedShipDate: c.plannedShipDate,
      shipDate: null,
      arriveDate: c.arriveDate,
      status: 'draft',
      locked: false,
      basis: `候选 ${c.id}：覆盖 ${c.toSiteId} 缺口日 ${c.gapDate}（最晚到货 ${c.latestArriveDate}）`,
      lines: c.lines.map((l) => ({
        batchId: l.batchId,
        drugCode: c.drugCode,
        expiry: l.expiry,
        qtyApprovedMin: l.qtyMin,
        receivedMin: 0,
        damagedMin: 0,
        quarantineMin: 0,
      })),
      returns: [],
    };
    set({ transfers: [...s.transfers, order], seq, notice: `候选 ${c.id} 已加入草稿（试算占用，未写正式库存）` });
  },

  removeDraft: (id) =>
    set((s) => ({
      transfers: s.transfers.filter((t) => t.id !== id),
      notice: `草稿 ${id} 已移除`,
    })),

  toggleLock: (id) =>
    set((s) => ({
      transfers: s.transfers.map((t) =>
        t.id === id ? { ...t, locked: !t.locked, conflictReason: t.locked ? t.conflictReason : undefined } : t,
      ),
    })),

  recalc: () => {
    const s = get();
    // 重算：锁定项保留；依据当前正式库存复核锁定草稿的真实余量，冲突保留原因
    const data = s.planningData();
    const transfers = s.transfers.map((t) => {
      if (t.status !== 'draft' || !t.locked) return t;
      const reasons: string[] = [];
      for (const line of t.lines) {
        const opening = openingBatchesFor(data, t.fromSiteId, line.drugCode).find(
          (b) => b.batchId === line.batchId,
        );
        const committedByOtherDrafts = s.transfers
          .filter((o) => o.id !== t.id && o.status === 'draft' && !o.invalid)
          .flatMap((o) => o.lines)
          .filter((l) => l.batchId === line.batchId)
          .reduce((sum, l) => sum + l.qtyApprovedMin, 0);
        const free = (opening?.qtyMin ?? 0) - committedByOtherDrafts;
        if (line.qtyApprovedMin > free) {
          reasons.push(
            `锁定批次 ${line.batchId} 需 ${line.qtyApprovedMin}，重算后真实余量仅 ${Math.max(0, free)}`,
          );
        }
      }
      return { ...t, conflictReason: reasons.length ? reasons.join('；') : undefined };
    });
    set({
      transfers,
      notice: '已按当前正式库存与占用重算候选；锁定调拨保留，冲突原因已标注',
    });
  },

  confirmDrafts: (ids) => {
    const s = get();
    if (s.user?.role === 'viewer') {
      set({ notice: '只读观察员不能确认调拨' });
      return;
    }
    const orders = s.transfers.filter((t) => ids.includes(t.id));
    const { id, seq } = nextId(s.seq, 'EV');
    const ev: DomainEvent = {
      id,
      type: 'transfer.confirmed',
      at: s.startDate,
      orders,
      note: '整组审批确认：任一单据预检失败则全部退回，试算不直接修改正式库存',
    };
    const result = applyEvent(currentAdapter(s), ev);
    set({
      batches: result.state.batches,
      transfers: result.state.transfers,
      events: result.state.events,
      rejected: result.rejected,
      seq,
      notice: result.rejected.length
        ? `确认被整组退回：${result.rejected.map((r) => r.reason).join('；')}`
        : `已批准 ${orders.length} 张调拨单（批准未出库，继续占用来源余额）`,
    });
  },

  shipOrder: (id) => {
    const s = get();
    if (s.user?.role === 'viewer') {
      set({ notice: '只读观察员不能出库' });
      return;
    }
    const order = s.transfers.find((t) => t.id === id);
    if (!order) return;
    const { id: evId, seq } = nextId(s.seq, 'EV');
    const ev: DomainEvent = {
      id: evId,
      type: 'transfer.shipped',
      at: s.startDate,
      transferId: id,
      shipDate: s.startDate,
    };
    const result = applyEvent(currentAdapter(s), ev);
    set({
      batches: result.state.batches,
      transfers: result.state.transfers,
      events: result.state.events,
      rejected: result.rejected,
      seq,
      notice: result.rejected.length
        ? `出库失败：${result.rejected.map((r) => r.reason).join('；')}`
        : `${id} 已出库在途：批准占用转为在途，来源余额只扣一次，预计 ${order.arriveDate} 到货`,
    });
  },

  receiveOrder: (id, lines) => {
    const s = get();
    if (s.user?.role === 'viewer') {
      set({ notice: '只读观察员不能签收' });
      return;
    }
    const { id: evId, seq } = nextId(s.seq, 'EV');
    const ev: DomainEvent = {
      id: evId,
      type: 'transfer.received',
      at: s.startDate,
      transferId: id,
      lines,
      note: '逐批签收：实收+破损+待查须等于本次发出',
    };
    const result = applyEvent(currentAdapter(s), ev);
    set({
      batches: result.state.batches,
      transfers: result.state.transfers,
      events: result.state.events,
      rejected: result.rejected,
      seq,
      notice: result.rejected.length
        ? `签收整组退回：${result.rejected.map((r) => r.reason).join('；')}`
        : `${id} 签收完成；少到部分停留待查/在途，未直接退回来源可用`,
    });
  },

  cancelOrder: (id) => {
    const s = get();
    const { id: evId, seq } = nextId(s.seq, 'EV');
    const ev: DomainEvent = {
      id: evId,
      type: 'transfer.cancelled',
      at: s.startDate,
      transferId: id,
    };
    const result = applyEvent(currentAdapter(s), ev);
    set({
      batches: result.state.batches,
      transfers: result.state.transfers,
      events: result.state.events,
      rejected: result.rejected,
      seq,
      notice: result.rejected.length
        ? `取消被拒：${result.rejected.map((r) => r.reason).join('；')}`
        : `${id} 已取消：仅释放未发部分；已发退回请登记回程`,
    });
  },

  registerReturn: (transferId, batchId, qty) => {
    const s = get();
    const order = s.transfers.find((t) => t.id === transferId);
    if (!order) return;
    const route = s.transport[routeKey(order.fromSiteId, order.toSiteId)] ?? null;
    const shipDate = s.startDate;
    const { id: evId, seq } = nextId(s.seq, 'EV');
    const ev: DomainEvent = {
      id: evId,
      type: 'transfer.returned',
      at: shipDate,
      transferId,
      batchId,
      qtyMin: qty,
      shipDate,
      arriveDate: defaultReturnArrive(shipDate, route),
    };
    const result = applyEvent(currentAdapter(s), ev);
    set({
      batches: result.state.batches,
      transfers: result.state.transfers,
      events: result.state.events,
      rejected: result.rejected,
      seq,
      notice: result.rejected.length
        ? `回程登记失败：${result.rejected.map((r) => r.reason).join('；')}`
        : `回程已登记，预计 ${ev.arriveDate} 回到来源；到达前不恢复来源可用`,
    });
  },

  receiveReturn: (transferId, returnId) => {
    const s = get();
    const { id: evId, seq } = nextId(s.seq, 'EV');
    const ev: DomainEvent = {
      id: evId,
      type: 'transfer.return-received',
      at: s.startDate,
      transferId,
      returnId,
    };
    const result = applyEvent(currentAdapter(s), ev);
    set({
      batches: result.state.batches,
      transfers: result.state.transfers,
      events: result.state.events,
      rejected: result.rejected,
      seq,
      notice: result.rejected.length
        ? `回程签收失败：${result.rejected.map((r) => r.reason).join('；')}`
        : '回程到货已恢复来源库存（重复签收幂等忽略）',
    });
  },

  stocktake: (siteId, adjustments) => {
    const s = get();
    if (s.user?.role === 'viewer') {
      set({ notice: '只读观察员不能盘点' });
      return;
    }
    const { id: evId, seq } = nextId(s.seq, 'EV');
    const ev: DomainEvent = {
      id: evId,
      type: 'stocktake.adjusted',
      at: s.startDate,
      siteId,
      adjustments,
    };
    const result = applyEvent(currentAdapter(s), ev);
    set({
      batches: result.state.batches,
      transfers: result.state.transfers,
      events: result.state.events,
      rejected: result.rejected,
      seq,
      notice:
        '盘点已更新：未确认草稿标记失效，已批准/在途安排列待复核，数量未被静默修改',
    });
  },

  resetDemo: () => {
    const fresh = createDemoData();
    set({
      batches: fresh.batches,
      transfers: fresh.transfers,
      events: fresh.events,
      missingConversions: fresh.missingConversions,
      rejected: [],
      expandedKeys: new Set<string>(),
      seq: 1,
      startDate: DEMO_START,
      horizonDays: 30,
      selectedSiteIds: ['S-CENTRAL', 'S-A', 'S-B', 'S-C'],
      notice: '演示数据已重置',
    });
  },
}));

export function horizonEndDate(startDate: string, horizonDays: number): string {
  return addDays(startDate, horizonDays - 1);
}
