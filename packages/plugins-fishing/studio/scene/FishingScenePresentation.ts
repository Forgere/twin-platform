import * as THREE from 'three';
import type { ScenePresentation, SceneViewContext, CameraView } from '@twin-platform/studio-sdk';
import { buildFishingEntityMesh, type FishingEntityAnim } from './fishingMeshes';
import { MAX_FLOAT_DROP, MAX_FLOAT_SHIFT, type FloatSignalName } from './floatSignal';
import { castEntryPoint, fishingPresentation } from './fishingPresentation';
import { driftWobble, flowOffset, rigVisualPose } from './rigVisual';
import { solveRigChainBuoyant, subLineLength, SUBLINE_SIDE, type HookKey, type V3 } from './rigChain';
import { Rope } from './rope';
import { FishingConditionsVisual } from './FishingConditionsVisual';
import { calculateRigState, conditionsOf, isMeasurePhase, measureMarks, rigPartsOf, rigPhaseOf, rigPosture } from '@twin-platform/plugins-fishing';

/** 钓组线每帧拉伸复用的临时量，避免每帧分配。 */
const FISHING_UP = new THREE.Vector3(0, 1, 0);
const fishingDirection = new THREE.Vector3();
const fishingFrom = new THREE.Vector3();
/** 钓场固定模板：漂相来自 rig-01 的 attrs.signal，按存档中的鱼口时间取当前姿态。 */
const FISHING_RIG_ID = 'rig-01';
const FISHING_FLOAT_ID = 'float-01';
const FISHING_SWIVEL_ID = 'swivel-01';
const FISHING_SINKER_ID = 'sinker-01';
const FISHING_BOTTOM_ID = 'bottom-01';
const FISHING_ROD_TIP_ID = 'rod-tip-01';
/**
 * 两根并联子线的渲染姿态：仿真里双钩同轴（x = z = 0），直接画会两根线叠成一根、
 * 两只钩朝同一边。这里把上钩摆到 −X、下钩摆到 +X（子线张成 V 字），钩尖各朝外。
 * side = 外侧方向，yaw 让钩尖（模型 −X）朝向 side。咬哪只钩读 rig 的 attrs.bitHook（fish-sim 用 ctx.rng 定）。
 */
const FISHING_HOOKS = [
  { key: 'upper', hookId: 'hook-upper-01', baitId: 'bait-upper-01', side: -1, yaw: 0 },
  { key: 'lower', hookId: 'hook-lower-01', baitId: 'bait-lower-01', side: 1, yaw: Math.PI },
] as const;
/** 子线张开的水平距离（米，示意比例）。 */
const HOOK_SPLAY = 0.14;
/** 躺底的钩：钩眼离底面的高度（钩整只放倒，钩丝贴着底）。 */
const HOOK_LYING_EYE = 0.012;
const fishingTo = new THREE.Vector3();

/** 模型声明的本地挂线点（缺省原点）。 */
function localAnchor(object: THREE.Object3D): THREE.Vector3 {
  const anchor = object.userData.lineAnchor as readonly [number, number, number] | undefined;
  return new THREE.Vector3(anchor?.[0] ?? 0, anchor?.[1] ?? 0, anchor?.[2] ?? 0);
}

/** 解出的世界位置 → 相对实体原点的枢轴偏移。 */
function offset(point: V3, object: THREE.Object3D): [number, number, number] {
  return [point[0] - object.position.x, point[1] - object.position.y, point[2] - object.position.z];
}

/**
 * 钩的朝向：yaw 让钩尖朝外；本地 +Y 顺子线指向 8 字环（yaw 翻面后本地 X 与世界 X 反向，
 * 倾角符号随之翻）；躺底时从悬垂过渡到平躺（倒向 8 字环一侧）。
 */
function hookRotation(origin: THREE.Vector3, swivel: V3, spec: { readonly yaw: number }, lie: number): THREE.Euler {
  const lean = Math.atan2(swivel[0] - origin.x, Math.max(0.02, swivel[1] - origin.y));
  const hang = spec.yaw === 0 ? -lean : lean;
  const flat = (Math.sign(hang) || 1) * (Math.PI / 2) * 0.92;
  return new THREE.Euler(0, spec.yaw, hang + (flat - hang) * lie);
}

/** 钓组零件的挂线点（世界坐标）：实体位置 + 模型声明的本地 `lineAnchor`（随零件旋转）。 */
function lineAnchorOf(object: THREE.Object3D, out: THREE.Vector3): THREE.Vector3 {
  const anchor = object.userData.lineAnchor as readonly [number, number, number] | undefined;
  const pivot = object.userData.lineAnchorPivot as THREE.Object3D | undefined;
  out.set(anchor?.[0] ?? 0, anchor?.[1] ?? 0, anchor?.[2] ?? 0);
  // 挂线点跟着内层枢轴走（浮漂的漂相动作），线才不会和漂脱开。
  if (pivot) out.applyEuler(pivot.rotation).add(pivot.position);
  return out.applyQuaternion(object.quaternion).add(object.position);
}

/** 钓场三维展示：只读世界，全部表现按当前仿真时间取样。 */
class FishingScenePresentation implements ScenePresentation {
  readonly showHelpers = false;
  readonly buildEntity = buildFishingEntityMesh;
  private readonly fishingConditions = new FishingConditionsVisual();

  constructor(private readonly context: SceneViewContext) {
    context.scene.add(this.fishingConditions.group);
  }

  overview(): CameraView | undefined {
    const rig = this.context.world.getEntity(FISHING_RIG_ID);
    if (rig) {
      const config = rig.config ?? {};
      const surfaceY = typeof config.surfaceY === 'number' ? config.surfaceY : 2;
      const depth = typeof config.depth === 'number' ? config.depth : 2;
      const midY = surfaceY - depth / 2 + 0.1;
      // 抛竿初段的浮漂在水面上方，机位也要容纳这段入水过程，而不只框住稳态钓组。
      const distance = Math.max(5.2, depth * 2.8);
      return { eye: [0.9, midY + distance * 0.22, distance], target: [0.1, midY, 0] };
    }
    return undefined;
  }

  update(): void {
    this.animateFloatSignal();
    const fishingTime = this.context.world.time;
    this.fishingConditions.update(this.context.world, this.context.meshes);
    for (const object of this.context.meshes.values()) {
      const anim = object.userData.anim as FishingEntityAnim | undefined;
      if (!anim) continue;
      // 钓场表现按仿真时刻取样：暂停、倍速与 seek 都不改变同一状态的样子。
      if (anim.ripples) {
        for (const ripple of anim.ripples) {
          const k = (fishingTime / ripple.period + ripple.phase) % 1;
          const radius = 0.15 + k * ripple.maxRadius;
          // 走水：涟漪边扩散边往下游（+X，与水下钓组被推的方向一致）漂，并被拉成椭圆。
          const drift = Math.min(1, this.rigFlowTan * 4);
          ripple.mesh.scale.set(radius * (1 + 0.35 * drift), radius, 1);
          ripple.mesh.position.x = k * ripple.maxRadius * 1.2 * drift;
          (ripple.mesh.material as THREE.MeshStandardMaterial).opacity = 0.55 * (1 - k);
        }
      }
      if (anim.sway) {
        for (const part of anim.sway) {
          part.mesh.rotation[part.axis] = part.base + part.amp * Math.sin(fishingTime * part.speed + part.phase);
        }
      }
      // 台钓钓组的主线 / 子线：每根线是一条软绳（rope.ts），首尾钉在两个挂线点上，
      // 线长来自受力链的静止位（animateRig 写入 lineLengths）——有余量就下垂 / 贴底 / 被水流吹弯，
      // 有余量就下垂 / 贴底 / 被水流吹弯，钩被拖时线随真实挂点晃动。
      // 按当前形状取样，不积累渲染 dt，否则同一回放状态会因此前渲染帧数不同而分叉。
      // 调漂后即使暂停，线也要立刻跟着新的钩饵位置走。
      if (anim.fishingLines) {
        for (const line of anim.fishingLines) {
          const key = line.fromId + '->' + line.toId;
          if (line.segment.index === 0) {
            const fromObject = this.context.meshes.get(line.fromId);
            const toObject = this.context.meshes.get(line.toId);
            if (!fromObject || !toObject || !fromObject.visible || !toObject.visible) {
              this.ropes.delete(key);
            } else {
              // 线挂在零件的挂线点（漂座 / 钩眼），不是实体原点。
              const from = lineAnchorOf(fromObject, fishingFrom);
              const to = lineAnchorOf(toObject, fishingTo);
              const chord = from.distanceTo(to);
              const rope = this.ropes.get(key) ?? new Rope();
              this.ropes.set(key, rope);
              rope.pose([from.x, from.y, from.z], [to.x, to.y, to.z], Math.max(this.lineLengths.get(key) ?? chord, 1e-3), {
                // 主线大半在空气里（竿梢→漂），下垂明显；水下的尼龙子线几乎零浮力，只轻轻下沉。
                gravity: line.kind === 'main' ? -6 : -1.2,
                current: [this.rigFlowTan * 6, 0, 0],
                surfaceY: this.rigSurfaceY,
                floorY: this.rigFloorY,
                // 子线往自己钩的那一侧松（上钩在 −X、下钩在 +X），两根线不交叉。
                spread: line.kind === 'branch' ? [(line.bendAttr === 'bendUpper' ? SUBLINE_SIDE.upper : SUBLINE_SIDE.lower) * 2, 0, 0] : undefined,
              });
            }
          }
          const rope = this.ropes.get(key);
          if (!rope) {
            line.mesh.visible = false;
            continue;
          }
          const [ax, ay, az] = rope.point(line.segment.index);
          const [bx, by, bz] = rope.point(line.segment.index + 1);
          const length = Math.hypot(bx - ax, by - ay, bz - az);
          if (length < 1e-5) {
            line.mesh.visible = false;
            continue;
          }
          line.mesh.visible = true;
          line.mesh.position.set(
            (ax + bx) / 2 - object.position.x,
            (ay + by) / 2 - object.position.y,
            (az + bz) / 2 - object.position.z,
          );
          const radius = typeof line.mesh.userData.radius === 'number' ? (line.mesh.userData.radius as number) : 0.01;
          line.mesh.scale.set(radius, length, radius);
          fishingDirection.set(bx - ax, by - ay, bz - az).normalize();
          line.mesh.quaternion.setFromUnitVectors(FISHING_UP, fishingDirection);
        }
      }
    }
  }

  reset(): void {
    this.ropes.clear();
    this.lineLengths.clear();
    this.rigFlowTan = 0;
    this.rigFloorY = 0;
    this.rigSurfaceY = 0;
    this.fishingConditions.reset();
  }

  dispose(): void {
    this.reset();
    this.fishingConditions.dispose();
  }

  /** 每根钓线的软绳（键 = "起点id->终点id"）与线长（受力链静止位给出）。 */
  private readonly ropes = new Map<string, Rope>();
  private readonly lineLengths = new Map<string, number>();
  private rigFloorY = 0;
  private rigSurfaceY = 0;
  /** 走水倾角正切（0 = 静水），水面涟漪据此往下游漂。 */
  private rigFlowTan = 0;

  /** 取“当前这一口”的世界时间，而不是在渲染器里另起一个计时器。 */
  private animateFloatSignal(): void {
    const world = this.context.world;
    const rig = world.getEntity(FISHING_RIG_ID);
    if (!rig) return;
    const state = fishingPresentation(rig.attrs, world.time, Number(rig.config.castInterval ?? 3));
    const parts = rigPartsOf(rigPhaseOf(rig.attrs));
    for (const [id, attached] of [
      [FISHING_RIG_ID, true], [FISHING_FLOAT_ID, true], [FISHING_SINKER_ID, true], [FISHING_SWIVEL_ID, true],
      ['hook-upper-01', parts.hooks], ['hook-lower-01', parts.hooks],
      ['bait-upper-01', parts.upperBait], ['bait-lower-01', parts.lowerBait],
    ] as const) {
      const object = this.context.meshes.get(id);
      if (object) object.visible = !state.stowed && attached;
    }
    if (state.stowed) {
      this.rigFlowTan = conditionsOf(rig).drift ? 0.25 : 0;
      const biter = (this.context.meshes.get(FISHING_RIG_ID)?.userData.anim as FishingEntityAnim | undefined)?.biter;
      if (biter) biter.visible = false;
      return;
    }
    this.animateRig(state.signal, state.hook, state.biteAge, state.castProgress);
  }

  /**
   * 浮漂以下整副钓组：
   * 1. 静止姿态来自 rigVisualPose（调钓状态：钩躺不躺、饵扁不扁、子线弯多少、铅坠倒不倒；送漂上托）；
   * 2. 一口鱼只做一件事——把被咬的那只钩往外拖；其余全由受力链（rigChain）沿线传上去：
   *    子线先被拉直，再拉 8 字环 → 铅坠 → 漂。线长守恒，漂的下顿 / 没入是被拉出来的。
   * 只写各零件的内层枢轴，并让每个挂线点**正好**落在解出来的位置上。
   */
  private animateRig(signal: FloatSignalName, bitten: HookKey, t: number, castProgress = 1): void {
    const rig = this.context.world.getEntity(FISHING_RIG_ID);
    const objects = {
      float: this.context.meshes.get(FISHING_FLOAT_ID),
      sinker: this.context.meshes.get(FISHING_SINKER_ID),
      swivel: this.context.meshes.get(FISHING_SWIVEL_ID),
    };
    if (!rig || !objects.float || !objects.sinker || !objects.swivel) return;
    const attrs = rig.attrs ?? {};
    const num = (value: unknown, fallback: number): number => (typeof value === 'number' ? value : fallback);
    const result = calculateRigState({ t0: num(attrs.t0, 4), t: num(attrs.t, 2), w: num(attrs.w, 1), d: num(attrs.d, 2) });
    if (!result.ok) return;
    // 走水：rigPosture 给出主线被拉斜的角度；加了铅（antiDrift）斜得只剩一半。
    const conditions = conditionsOf(rig);
    const pose = rigVisualPose(rigPosture(result.state, { drift: conditions.drift }), signal, t, {
      antiDrift: conditions.antiDrift,
      bitten,
    });
    this.rigFlowTan = pose.flowTan;
    const config = rig.config ?? {};
    // 底面 = 水底泥沙板的顶面（没有这块装饰时退回水体底面）：钩躺底、子线贴底都以它为准，
    // 用水体底面会让躺底的钩整只埋进泥沙板里看不见。
    const bottom = this.context.world.getEntity(FISHING_BOTTOM_ID);
    const bottomTop = bottom ? bottom.transform.position[1] + (bottom.visual?.size?.[1] ?? 0) / 2 : undefined;
    this.rigFloorY = (bottomTop ?? num(config.surfaceY, 2) - num(config.depth, 2)) + 0.012;

    // ── 静止位的挂线点 ──
    const floatObject = objects.float;
    const floatLocal = localAnchor(floatObject);
    // 水流把漂座以下的部分往下游（+X）推：越深推得越远，主线因此斜过来；漂的倾斜由受力链顺线得出。
    // 漂的吃水：测量阶段按向导预览目数，找底 / 作钓按 d；漂肚整个在水下。
    // 内核里一目只有 2cm（与模型的示意目高不同），所以漂的高度按模型的目高重新定。
    const surfaceY = num(config.surfaceY, 2);
    this.rigSurfaceY = surfaceY;
    const waterline = floatObject.userData.waterline as { tailBottom: number; markH: number; marks: number } | undefined;
    const phase = rigPhaseOf(attrs);
    const marks = isMeasurePhase(phase) ? measureMarks(phase, attrs) : num(attrs.d, 2);
    const visibleMarks = Math.min(Math.max(marks, 0), waterline?.marks ?? 5);
    const floatOriginY = waterline
      ? surfaceY - waterline.tailBottom - (waterline.marks - visibleMarks) * waterline.markH
      : floatObject.position.y;
    const floatAnchorY = floatOriginY + floatLocal.y + pose.floatLift;
    const flow = (y: number): number => flowOffset(floatAnchorY, y, pose.flowTan);
    const at = (object: THREE.Object3D, dy: number): V3 => {
      const y = object.position.y + dy;
      return [object.position.x + flow(y), y, object.position.z];
    };
    // 水流晃动取同一仿真时刻；下面的零件经受力链跟着漂一起动。
    const wobble = driftWobble(this.context.world.time, pose.flowTan);
    const restFloat: V3 = [floatObject.position.x + floatLocal.x + wobble.dx, floatAnchorY + wobble.dy, floatObject.position.z + floatLocal.z];
    const restSwivel = at(objects.swivel, pose.mainLift);
    // 钩的原点就是钩眼（挂线点）；躺底的钩整只放倒在底上，钩眼随之落到底面。
    const eyes = {} as Record<HookKey, V3>;
    for (const spec of FISHING_HOOKS) {
      const hook = this.context.meshes.get(spec.hookId);
      if (!hook) return;
      const visual = pose.hooks[spec.key];
      const hangY = hook.position.y + visual.dy;
      const eyeY = hangY + (this.rigFloorY + HOOK_LYING_EYE - hangY) * visual.lie;
      eyes[spec.key] = [hook.position.x + spec.side * HOOK_SPLAY + flow(eyeY), eyeY, hook.position.z];
    }

    // ── 鱼拖被咬的那只钩：受力链解算 ──
    const bittenSpec = FISHING_HOOKS.find((spec) => spec.key === bitten) ?? FISHING_HOOKS[1];
    const shake = pose.drag.shake * Math.sin(t * 38);
    const from = eyes[bitten];
    const target: V3 = [from[0] + bittenSpec.side * pose.drag.out, from[1] + pose.drag.dy, from[2] + shake];
    let solved = solveRigChainBuoyant(
      {
        float: restFloat,
        sinker: at(objects.sinker, pose.mainLift),
        swivel: restSwivel,
        upper: eyes.upper,
        lower: eyes.lower,
        bend: pose.bend,
        floorY: this.rigFloorY,
      },
      target,
      bitten,
      { drop: MAX_FLOAT_DROP[signal], shift: MAX_FLOAT_SHIFT[signal] },
    );

    // 线长 = 静止位的长度：子线是受力链里的弧长（钝时多出来的线由软绳自己垂下 / 躺底），
    // 主线留一点余量（竿梢→漂在空气里自然下垂；水下两段在走水时能被吹弯）。
    const rodTip = this.context.meshes.get(FISHING_ROD_TIP_ID)?.position;
    const restSinker = at(objects.sinker, pose.mainLift);
    const span = (a: V3, b: V3): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
    if (rodTip) this.lineLengths.set(FISHING_ROD_TIP_ID + '->' + FISHING_FLOAT_ID, span([rodTip.x, rodTip.y, rodTip.z], restFloat) * 1.04);
    this.lineLengths.set(FISHING_FLOAT_ID + '->' + FISHING_SINKER_ID, span(restFloat, restSinker) * 1.01);
    this.lineLengths.set(FISHING_SINKER_ID + '->' + FISHING_SWIVEL_ID, span(restSinker, restSwivel) * 1.01);
    for (const spec of FISHING_HOOKS) {
      this.lineLengths.set(
        FISHING_SWIVEL_ID + '->' + spec.hookId,
        subLineLength(restSwivel, eyes[spec.key], pose.bend[spec.key], SUBLINE_SIDE[spec.key], this.rigFloorY),
      );
    }

    // 新抛竿只改变这组挂点的入水进度：线长仍取稳态长度，多出的线自然松弛，绝不各画各的。
    if (castProgress < 1 && rodTip) {
      const entry = (point: V3): V3 => castEntryPoint(point, restFloat, [rodTip.x, rodTip.y, rodTip.z], surfaceY, castProgress);
      solved = {
        ...solved,
        float: entry(solved.float), sinker: entry(solved.sinker), swivel: entry(solved.swivel),
        upper: entry(solved.upper), lower: entry(solved.lower),
      };
    }

    // ── 写回枢轴 ──
    const pivotOf = (object: THREE.Object3D | undefined) => object?.userData.lineAnchorPivot as THREE.Object3D | undefined;
    // 漂：挂线点落到解出的漂座上；被线往哪边拉，漂脚就被拽向哪边、漂身反向倾。
    const floatPivot = pivotOf(floatObject);
    if (floatPivot) {
      const pullX = solved.sinker[0] - solved.float[0];
      const pullY = Math.max(1e-3, solved.float[1] - solved.sinker[1]);
      // 漂有浮力、漂身又长，被斜拉时只顺线偏一点（最多约 30°），不会被放倒。
      floatPivot.rotation.set(0, 0, Math.max(-0.5, Math.min(0.5, Math.atan2(pullX, pullY) * 0.6)));
      const rotated = floatLocal.clone().applyEuler(floatPivot.rotation);
      floatPivot.position.set(
        solved.float[0] - floatObject.position.x - rotated.x,
        solved.float[1] - floatObject.position.y - rotated.y,
        solved.float[2] - floatObject.position.z - rotated.z,
      );
    }
    const sinkerPivot = pivotOf(objects.sinker);
    if (sinkerPivot) {
      sinkerPivot.position.set(...offset(solved.sinker, objects.sinker));
      sinkerPivot.rotation.z = (pose.sinkerLie * castProgress * Math.PI) / 2;
    }
    pivotOf(objects.swivel)?.position.set(...offset(solved.swivel, objects.swivel));

    for (const spec of FISHING_HOOKS) {
      const hook = this.context.meshes.get(spec.hookId);
      if (!hook) continue;
      const eye = new THREE.Vector3(...solved[spec.key]);
      // 钩从钩眼顺着子线垂下（本地 +Y 指向 8 字环），躺底的钩平躺。
      const rotation = hookRotation(eye, solved.swivel, spec, pose.hooks[spec.key].lie * castProgress);
      const bait = this.context.meshes.get(spec.baitId);
      for (const object of [hook, bait]) {
        const pivot = pivotOf(object);
        if (!object || !pivot) continue;
        // 饵实体与钩实体同位（仿真同点），同一个姿态即可让饵始终裹在钩弯上。
        pivot.position.set(eye.x - object.position.x, eye.y - object.position.y, eye.z - object.position.z);
        pivot.rotation.copy(rotation);
        // 饵：躺底压扁、被吸入变小（只缩饵团本身，不动它在钩弯上的位置）。
        if (object !== hook) pivot.children[0]?.scale.set(1, 1 + (pose.baits[spec.key] - 1) * castProgress, 1);
      }
      const baitBall = pivotOf(bait)?.children[0];
      if (spec.key === bitten && bait && baitBall) {
        bait.updateMatrixWorld(true);
        this.placeBiter(baitBall.getWorldPosition(new THREE.Vector3()), spec.side, pose.bite, t);
      }
    }
  }

  /**
   * 咬钩的鱼：嘴含着被咬那只钩的饵、身子朝外，随钩一起被拖；强度低时离得远且小（游近 / 游走）。
   * 摆尾沿用 buildFish 自带的 sway，只是这条鱼不是独立实体，由这里代为驱动。
   */
  private placeBiter(mouthAt: THREE.Vector3, side: number, bite: number, t: number): void {
    const rigObject = this.context.meshes.get(FISHING_RIG_ID);
    const biter = (rigObject?.userData.anim as FishingEntityAnim | undefined)?.biter;
    if (!rigObject || !biter) return;
    biter.visible = bite > 0.02;
    if (!biter.visible) return;
    // 模型嘴在本地 +X（半径 0.12 × 1.35）；转 180° 让嘴朝钩，身子伸向外侧。
    const mouth = 0.16;
    const away = mouth + (1 - bite) * 0.4;
    biter.position.set(
      mouthAt.x + side * away - rigObject.position.x,
      mouthAt.y - rigObject.position.y,
      mouthAt.z - rigObject.position.z,
    );
    biter.rotation.y = side > 0 ? Math.PI : 0;
    biter.scale.setScalar(0.6 + 0.4 * bite);
    const sway = (biter.userData.anim as FishingEntityAnim | undefined)?.sway ?? [];
    for (const part of sway) part.mesh.rotation[part.axis] = part.base + part.amp * 1.6 * Math.sin(t * part.speed * 1.8 + part.phase);
  }

}

export function createFishingScenePresentation(context: SceneViewContext): ScenePresentation {
  return new FishingScenePresentation(context);
}
