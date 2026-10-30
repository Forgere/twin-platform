import type { BehaviorContext, WorldBehavior } from '@twin-platform/world-kernel';

/**
 * 顶升移栽机的顶升循环行为。
 *
 * 和 `asrs-cycle` 的分工不同：那条是时间的纯函数（自己造运动），
 * 这条是**事件驱动**的——它读内核搬出来的货物位置，判断"该不该顶"。
 *
 * 判据来自场景模板声明的 `divertIds`：只有表里的货到跟前才顶升，
 * 其余货物直着滚过去。这样"谁拐弯"这件事由场景说了算，行为不用猜。
 *
 * ── 单工位（本行为的核心约束）──
 * 移栽机只有一个台面，同一时刻只能吃一个货：
 * 1. 认领 —— 空闲时把检测区里第一个货登记为 `__job`；
 * 2. 独占 —— 一旦认领就认到底，链条保持顶起，直到这个货真正离开台面
 *    （沿出货方向出去了，或直着滚过下游边）。期间别的分流货不许上台；
 * 3. 排队 —— 被占着的时候，其余分流货拦在台面前方的排队区里停住
 *    （反向推进抵消内核这一步的行进），并打上 `backpressure` 让渲染层染红。
 *
 * 排队用的是"抵消推进"而不是"改速度"：内核先 `advanceSimMotion` 再跑行为，
 * 所以行为里 `ctx.move(id, -speed*dt)` 正好把这一步的位移还回去，净位移为零。
 * 释放工位后不再抵消，货物自然起步——不需要额外的状态机。
 *
 * 检测区沿来料方向（-X）前伸一段 `lead`，货物还没上台面就开始顶，
 * 否则等它已经拐弯了才抬，看着像被拽过去的。
 */

export interface TransferBehaviorConfig {
  /** 移栽机实体的能力标记，默认 `transfer`。 */
  capability?: string;
  /** 托举座实体的 id 后缀，默认 `-cassette`。 */
  cassetteSuffix?: string;
  /** 分流事件类型。 */
  divertType?: string;
  /** 检测区沿来料方向前伸的距离（米），用于提前顶升。 */
  lead?: number;
  /** 排队区长度（米）：工位被占时，后续分流货停在台面前这么远的范围里。 */
  queue?: number;
}

const num = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback;

const str = (value: unknown, fallback: string): string => (typeof value === 'string' ? value : fallback);

const strList = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
};

/** 台面上的货还算不算"在这台机器上"：出货方向留出 0.15m 余量，免得链条提前掉。 */
const CLEARANCE = 0.15;

export function createTransferBehavior(config: TransferBehaviorConfig = {}): WorldBehavior {
  const capability = config.capability ?? 'transfer';
  const cassetteSuffix = config.cassetteSuffix ?? '-cassette';
  const divertType = config.divertType ?? 'transfer:divert';
  const defaultLead = config.lead ?? 0.7;
  const defaultQueue = config.queue ?? 2.2;

  return {
    id: 'transfer-cycle',
    step(ctx: BehaviorContext): void {
      // 本步被拦下的货 / 所有移栽机盯着的货。多台移栽机可能共用同一批
      // divertIds（立库"一进一出"两台就是），背压标记必须整步汇总后再写，
      // 否则后跑的那台会把先跑那台的标记清掉，红灯闪烁。
      const heldNow = new Set<string>();
      const watched = new Set<string>();
      for (const unit of ctx.entities) {
        if (!unit.capabilities.includes(capability)) continue;

        const conf = unit.config ?? {};
        const liftHeight = num(conf.liftHeight, 0.13);
        const upTime = Math.max(1e-3, num(conf.upTime, 0.18));
        const downTime = Math.max(1e-3, num(conf.downTime, 0.18));
        const divertIds = strList(conf.divertIds);
        if (divertIds.length === 0) continue;
        // 两种工作模式，货在台面上的走法完全相反：
        // - divert：货沿主线滚到台面**中央** → 顶起 → 链带沿 ±Z 把它送出台面边缘；
        // - merge ：货从 ±Z 侧垂直驶入台面**边缘** → 顶起 → 链带送到中央
        //           → 落带 → 主线滚筒带着往下游走。
        // 合流点必须用 merge，用 divert 会把货往回推。
        const merge = str(conf.transferMode, 'divert') === 'merge';
        /** 链带运行方向（沿 local Z）：+1 往 +Z，-1 往 −Z。 */
        const sign = num(conf.divertSign, -1) >= 0 ? 1 : -1;
        /** 双向机：同一台兼做"顶进支路"和"从支路接回"，按货的驶入侧决定顶送方向。 */
        const bidirectional = conf.bidirectional === true;

        const [ux, uy, uz] = unit.transform.position;
        const size = unit.visual?.size ?? [1.6, 0.6, 1.4];
        const halfX = (size[0] ?? 1.6) / 2;
        const halfZ = (size[2] ?? 1.4) / 2;
        const lead = num(conf.lead, defaultLead);
        const queue = num(conf.queue, defaultQueue);

        // ── 1) 工位上这个货还在不在？不在就交还工位 ──────────────────
        // 注意：不能用"是否还在检测区"判断——货被顶出去了当然不在检测区，
        // 但链条得等它完全离台才能落下去。
        let job = str(unit.attrs.__job, '');
        if (job) {
          const parcel = ctx.entity(job);
          if (!parcel) {
            job = '';
          } else {
            const [px, , pz] = parcel.transform.position;
            if (merge) {
              // 合流：被链带从边缘送到台面中央就落带，交给主线滚筒。
              // 来料侧是 −sign，所以"到位"就是 偏移×(−sign) 收敛到 0；
              // 冲过头（反向偏移）或已被主线带出下游，同样算交还工位。
              const lateral = (pz - uz) * -sign;
              if (lateral <= 0.12 || lateral < -0.2 || px > ux + halfX + CLEARANCE) job = '';
            } else {
              const outZ = Math.abs(pz - uz) > halfZ + CLEARANCE; // 沿出货方向已离台
              const outX = px > ux + halfX + CLEARANCE; // 或直着滚过下游边
              if (outZ || outX) job = '';
            }
          }
        }

        // ── 2) 空闲才认领：检测区沿来料方向前伸 lead ──────────────────
        const liftNow = num(unit.attrs.__lift, 0);
        const zoneFrom = ux - halfX - lead;
        const zoneTo = ux + halfX;
        if (!job && liftNow <= 0.001) {
          let claimedSign = sign;
          for (const id of divertIds) {
            const parcel = ctx.entity(id);
            if (!parcel) continue;
            const [px, , pz] = parcel.transform.position;
            if (merge) {
              // 只在"已经踏上台面、且还偏在来料侧"时认领：主线上的货恒在 z≈uz，
              // 偏移≈0，永远不会被误认领；支线来的货偏移从 halfZ 收敛到 0。
              const lateral = (pz - uz) * -sign;
              if (Math.abs(px - ux) <= halfX && lateral > halfZ * 0.25 && lateral <= halfZ) {
                job = id;
                break;
              }
              continue;
            }
            // 非合流（divert）：主线中央驶来的货 → 顶向支路（+divertSign）。
            if (px < zoneFrom || px > zoneTo) {
              // 双向机：也认从支路（+Z 侧）垂直驶来的回程货 → 顶向出库接驳（−divertSign）。
              if (!bidirectional || Math.abs(px - ux) > halfX) continue;
              if (pz < uz - lead || pz > uz + halfZ + lead) continue;
              job = id;
              claimedSign = -sign;
              break;
            }
            if (Math.abs(pz - uz) > halfZ) continue;
            job = id;
            claimedSign = sign;
            break;
          }
          if (job) ctx.setAttr(unit.id, '__jobSign', claimedSign);
        }

        // ── 3) 排队：占着工位时，其余分流货停在台面前方 ────────────────
        const occupied = job !== '';
        const holdFrom = ux - halfX - queue;
        for (const id of divertIds) {
          watched.add(id);
          if (id === job) continue;
          const parcel = ctx.entity(id);
          if (!parcel) continue;
          const [px, , pz] = parcel.transform.position;
          const inHold = px >= holdFrom && px <= zoneTo && Math.abs(pz - uz) <= halfZ;
          if (occupied && inHold) {
            // 内核这一步已经把它往前推了，反向推回去 = 原地停住。
            ctx.move(id, -(parcel.motion?.speed ?? 0) * ctx.dt);
            heldNow.add(id);
          }
        }

        // ── 4) 顶升高度 0→1 匀速趋近目标，启停不瞬跳 ───────────────────
        const lift = liftNow;
        const target = job ? 1 : 0;
        const rate = ctx.dt / (target > lift ? upTime : downTime);
        const next =
          lift < target ? Math.min(target, lift + rate) : lift > target ? Math.max(target, lift - rate) : lift;
        ctx.setAttr(unit.id, '__lift', next);
        if (job !== str(unit.attrs.__job, '')) ctx.setAttr(unit.id, '__job', job);

        const cassette = ctx.entity(`${unit.id}${cassetteSuffix}`);
        if (cassette) {
          ctx.setTransform(cassette.id, { position: [ux, uy + next * liftHeight, uz] });
        }

        // 被顶的货随链带一起抬离台面（货底 = 路径基准高 + 抬升量），
        // 否则货还停在 1.2、链带却升上去，看着像货穿过机器。
        if (job) {
          const jobParcel = ctx.entity(job);
          if (jobParcel) {
            // 基准高取场景声明的初始高度：内核的 motion 里没有 points 这个字段，
            // 只有路径弧长；用 baseTransform 才是"这条路径的原始高度"。
            const baseY = jobParcel.baseTransform.position[1] ?? 1.2;
            const [px, , pz] = jobParcel.transform.position;
            ctx.setTransform(jobParcel.id, { position: [px, baseY + next * liftHeight, pz] });
          }
        }

        ctx.setStatus(unit.id, next > 0.5 ? 'busy' : 'idle');

        // 每次"顶到位"只发一次，落到原位后重新武装。
        const armed = unit.attrs.__armed !== false;
        if (next >= 0.999 && armed && job) {
          ctx.emit(divertType, {
            entityId: unit.id,
            payload: { parcelId: job, height: liftHeight, lift: next },
          });
          ctx.setAttr(unit.id, '__armed', false);
        }
        if (next <= 0.001 && !armed) ctx.setAttr(unit.id, '__armed', true);
      }

      // 整步汇总后再写背压标记，避免共用 divertIds 的移栽机互相清标记。
      for (const id of watched) {
        const parcel = ctx.entity(id);
        if (!parcel) continue;
        const held = heldNow.has(id);
        if ((parcel.attrs.backpressure === true) !== held) ctx.setAttr(id, 'backpressure', held);
      }
    },
  };
}
