import * as THREE from 'three';
import type { TwinVector3 } from '@twin-platform/world-kernel';
import type { EntityMeshInput } from '@twin-platform/studio-sdk';
import { material, rbox, cyl, sphere, at } from '@twin-platform/studio-sdk/three';
import { ROPE_SEGMENTS } from './rope';

/** 钓场内部的动画句柄；宿主不解释这些字段。 */
export interface FishingEntityAnim {
  kind: string;
  /**
   * 台钓钓组的线（主线 / 子线）：每帧按两端实体的**挂线点**拉伸。
   * 挂线点 = 实体位置 + 该实体模型 `userData.lineAnchor`（本地偏移，缺省为原点），
   * 例如线穿漂脚而不是漂身中心、子线系在钩柄眼上而不是钩门中间。
   */
  fishingLines?: {
    readonly mesh: THREE.Mesh;
    readonly fromId: string;
    readonly toId: string;
    /** 子线弯曲：设置则该段属子线，控制器按 rigVisualPose 的 bend（调钓状态 + 这一口）松弛成折线。 */
    readonly bendAttr?: 'bendUpper' | 'bendLower';
    /** 主线 / 子线（控制器据此给软绳配线长与受力）。 */
    readonly kind: 'main' | 'branch';
    /** 软绳分段：本 mesh 是第 index 截（共 count 截）。 */
    readonly segment: { readonly index: number; readonly count: number };
    /** 弯曲量来源的 rig 实体（钓场固定为 rig-01）。 */
    readonly rigId?: string;
  }[];
  /** 咬钩的鱼（仅钓组）：只在一口鱼期间显示，嘴在模型本地 +X 端。 */
  biter?: THREE.Group;
  /** 水面涟漪（仅 water）：按渲染时钟从中心向外扩散、淡出，循环播放。 */
  ripples?: { readonly mesh: THREE.Mesh; readonly phase: number; readonly maxRadius: number; readonly period: number }[];
  /** 摆动件（水草叶片 / 鱼尾）：绕 axis 在 base 附近做正弦摆动，纯表现，不写世界状态。 */
  sway?: { readonly mesh: THREE.Object3D; readonly axis: 'y' | 'z'; readonly base: number; readonly amp: number; readonly speed: number; readonly phase: number }[];
}

// ─────────────────────────────────────────────────────────────────────────
// 台钓钓组（漂语插件）
// ─────────────────────────────────────────────────────────────────────────
// 真实台钓的漂 / 钩 / 饵是厘米级，放进 2m 深的水里根本看不清。这里是**示意比例**
// （漂总长 ~0.9m），位置仍严格来自 fishingLayout（米）——尺寸只影响"看不看得清"，
// 不影响仿真，几何与行为共用同一套坐标。

/** 漂尾目数：红 / 黑相间的短节，数得出来才叫"看得清目"。 */
const FLOAT_MARKS = 5;
const FLOAT_MARK_H = 0.08;
const FLOAT_TAIL_R = 0.028;
const FLOAT_BODY_R = 0.075;
const FLOAT_BODY_H = 0.3;
const FLOAT_STEM_H = 0.2;
const SINKER_R = 0.045;
const SINKER_H = 0.11;
/**
 * 鱼钩（示意比例，但比例关系按真钩来）：**原点 = 钩眼**（子线系在这里，也就是内核里
 * 钩的位置），钩身从钩眼往下垂：钩柄 → J 形钩弯 → 向上的钩尖（带倒刺）。
 * 钩要比子线短得多——以前钩柄 0.19m 而短子线只有 0.2m，钩眼顶到 8 字环，子线就"没了"。
 */
const HOOK_WIRE = 0.008;
const HOOK_EYE_R = 0.012;
const HOOK_SHANK = 0.1;
const HOOK_BEND_R = 0.035;
/** 钩尖所在的竖直段（钩弯另一侧）高度，与钩尖锥长。 */
const HOOK_POINT_RISE = 0.035;
const HOOK_POINT_LEN = 0.032;
/** 饵裹在钩弯上，钩尖与倒刺露在外面（钩要"看得见尖"）。 */
const BAIT_R = 0.042;
const BAIT_CENTER: TwinVector3 = [-HOOK_BEND_R, -HOOK_SHANK - HOOK_BEND_R * 0.35, 0];
const FISHING_LINE_R = 0.022;

/** 浮漂：漂尾（红 / 黑目节）+ 漂身（纺锤）+ 漂脚。 */
function buildFloat(color: string): THREE.Group {
  const group = new THREE.Group();
  group.userData.codePath = 'plugins-fishing/studio/scene/fishingMeshes.ts:buildFloat';
  // 零件都挂在内层枢轴上：漂相动作只动枢轴，实体位置仍是内核给的静止位。
  const pivot = new THREE.Group();
  group.add(pivot);

  const body = new THREE.Mesh(new THREE.SphereGeometry(FLOAT_BODY_R, 14, 12), material(color, { roughness: 0.32 }));
  body.scale.set(1, FLOAT_BODY_H / (FLOAT_BODY_R * 2), 1);
  body.castShadow = true;
  pivot.add(body);

  const tailBottom = FLOAT_BODY_H / 2;
  for (let index = 0; index < FLOAT_MARKS; index += 1) {
    const bandColor = index % 2 === 0 ? '#e63946' : '#1f2933';
    pivot.add(at(cyl(FLOAT_TAIL_R, FLOAT_MARK_H, bandColor, 10, { roughness: 0.35 }), 0, tailBottom + FLOAT_MARK_H * (index + 0.5), 0));
  }

  pivot.add(at(cyl(FLOAT_TAIL_R, FLOAT_STEM_H, '#5b6472', 8, { roughness: 0.4 }), 0, -FLOAT_BODY_H / 2 - FLOAT_STEM_H / 2, 0));
  // 漂座在漂脚末端：主线从这里穿过，上接竿梢、下接铅皮座，不穿漂身。
  group.userData.lineAnchor = [0, -FLOAT_BODY_H / 2 - FLOAT_STEM_H, 0];
  group.userData.lineAnchorPivot = pivot;
  // 吃水参数：控制器按"露出 d 目"摆漂——漂尾底端以上每 markH 一目，共 marks 目。
  group.userData.waterline = { tailBottom: FLOAT_BODY_H / 2, markH: FLOAT_MARK_H, marks: FLOAT_MARKS };
  group.userData.anim = { kind: 'float' } as FishingEntityAnim;
  return group;
}

/** 铅坠：铅皮座缠一圈铅皮，做成一节深色圆柱。 */
function buildSinker(color: string): THREE.Group {
  const group = new THREE.Group();
  group.userData.codePath = 'plugins-fishing/studio/scene/fishingMeshes.ts:buildSinker';
  // 内层枢轴：随主线上下 / 走铅时平躺，只动枢轴，实体位置仍是内核给的值。
  const pivot = new THREE.Group();
  group.add(pivot);
  pivot.add(cyl(SINKER_R, SINKER_H, color, 12, { roughness: 0.45, metalness: 0.55 }));
  group.userData.lineAnchorPivot = pivot;
  return group;
}

/**
 * 鱼钩：钩眼（小环）+ 钩柄 + J 形钩弯（一根连续的细管）+ 锥形钩尖 + 倒刺。
 * 原点在钩眼顶端（挂线点），钩尖在本地 −X 侧、朝上略向钩柄内收。
 */
function buildHook(color: string): THREE.Group {
  const group = new THREE.Group();
  group.userData.codePath = 'plugins-fishing/studio/scene/fishingMeshes.ts:buildHook';
  const metal = { roughness: 0.25, metalness: 0.75 };
  // 零件挂在内层枢轴上：朝向 / 被鱼拖拽只动枢轴，实体位置仍是内核给的值。
  const pivot = new THREE.Group();
  group.add(pivot);

  const eye = new THREE.Mesh(new THREE.TorusGeometry(HOOK_EYE_R, HOOK_WIRE * 0.55, 8, 20), material(color, metal));
  eye.position.y = -HOOK_EYE_R;
  eye.name = 'hook-eye';
  pivot.add(eye);

  // 钩柄 → 钩弯 → 钩尖竖直段：一条连续曲线扫成细管，拐弯处不会断开。
  const top = -HOOK_EYE_R * 2;
  const points: THREE.Vector3[] = [new THREE.Vector3(0, top, 0), new THREE.Vector3(0, -HOOK_SHANK, 0)];
  for (let index = 1; index <= 12; index += 1) {
    const angle = (index / 12) * Math.PI; // 从钩柄底（右）绕到钩尖侧（左），经过最低点
    points.push(new THREE.Vector3(-HOOK_BEND_R + HOOK_BEND_R * Math.cos(angle), -HOOK_SHANK - HOOK_BEND_R * Math.sin(angle), 0));
  }
  points.push(new THREE.Vector3(-2 * HOOK_BEND_R, -HOOK_SHANK + HOOK_POINT_RISE, 0));
  const body = new THREE.Mesh(
    new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points, false, 'centripetal'), 64, HOOK_WIRE, 8, false),
    material(color, metal),
  );
  body.castShadow = true;
  body.name = 'hook-body';
  pivot.add(body);

  // 钩尖：从管径收到 0 的锐锥，略向钩柄内收（真钩的尖是往里勾的）。
  const pointBase = new THREE.Vector3(-2 * HOOK_BEND_R, -HOOK_SHANK + HOOK_POINT_RISE, 0);
  const point = new THREE.Mesh(new THREE.ConeGeometry(HOOK_WIRE, HOOK_POINT_LEN, 10), material(color, metal));
  point.geometry.translate(0, HOOK_POINT_LEN / 2, 0);
  point.position.copy(pointBase);
  point.rotation.z = -0.28;
  point.name = 'hook-point';
  pivot.add(point);
  // 倒刺：钩尖下方外侧一根朝下斜出的小刺。
  const barb = new THREE.Mesh(new THREE.ConeGeometry(HOOK_WIRE * 0.6, HOOK_POINT_LEN * 0.45, 8), material(color, metal));
  barb.geometry.translate(0, (HOOK_POINT_LEN * 0.45) / 2, 0);
  barb.position.set(pointBase.x - HOOK_WIRE * 0.2, pointBase.y + HOOK_POINT_LEN * 0.55, 0);
  barb.rotation.z = Math.PI - 0.55;
  barb.name = 'hook-barb';
  pivot.add(barb);

  group.userData.lineAnchor = [0, 0, 0];
  group.userData.lineAnchorPivot = pivot;
  return group;
}

/** 饵：一小团，裹在钩弯上（搓饵 / 拉饵都这样示意），钩尖和倒刺露在外面。 */
function buildBait(color: string): THREE.Group {
  const group = new THREE.Group();
  group.userData.codePath = 'plugins-fishing/studio/scene/fishingMeshes.ts:buildBait';
  // 与钩同构的枢轴：控制器给钩和饵写同一个姿态，饵始终穿在钩尖上。
  const pivot = new THREE.Group();
  group.add(pivot);
  pivot.add(at(sphere(BAIT_R, color, { roughness: 0.75 }), BAIT_CENTER[0], BAIT_CENTER[1], BAIT_CENTER[2]));
  group.userData.lineAnchorPivot = pivot;
  return group;
}

/** 半透明水体不写深度：画在它后面的钓线（renderOrder 更大）不会被水面"挡掉"。 */
function noDepthWrite(object: THREE.Object3D): void {
  object.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (mesh.isMesh) (mesh.material as THREE.Material).depthWrite = false;
  });
}

/**
 * 水面 / 水体：半透明体块，上表面就是水面（实体 position 是水体中心）。
 * 顶部叠一层更亮的薄板当"水面高光"，让水面读得出一个平面而不是盒子的侧面。
 * 透明件不投影也不收影，否则水下钓组会被自己的水面阴影糊掉。
 */
function buildWater(size: TwinVector3, color: string): THREE.Group {
  const group = new THREE.Group();
  group.userData.codePath = 'plugins-fishing/studio/scene/fishingMeshes.ts:buildWater';
  const body = rbox(size[0], size[1], size[2], color, { roughness: 0.12, metalness: 0.05, opacity: 0.26 });
  noDepthWrite(body);
  body.castShadow = false;
  body.receiveShadow = false;
  group.add(body);
  const surface = rbox(size[0] * 0.995, 0.04, size[2] * 0.995, '#9fd3e8', { roughness: 0.18, opacity: 0.5 });
  noDepthWrite(surface);
  surface.position.y = size[1] / 2 - 0.02;
  surface.castShadow = false;
  surface.receiveShadow = false;
  group.add(surface);
  // 水体下半层压一块更深的色：浅处透、深处暗，读得出"有深度"而不是一块均匀玻璃。
  const deep = rbox(size[0] * 0.99, size[1] * 0.5, size[2] * 0.99, '#123f5c', { roughness: 0.3, opacity: 0.22 });
  noDepthWrite(deep);
  deep.position.y = -size[1] / 4;
  deep.castShadow = false;
  deep.receiveShadow = false;
  group.add(deep);
  // 漂落点的涟漪：三圈白环错相扩散、淡出（每圈独占材质，才能各自改透明度）。
  const ripples: NonNullable<FishingEntityAnim['ripples']> = [];
  for (let index = 0; index < 3; index += 1) {
    const ring = new THREE.Mesh(new THREE.TorusGeometry(1, 0.012, 8, 48), material('#ffffff', { roughness: 0.25, opacity: 0.5 }));
    noDepthWrite(ring);
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = size[1] / 2 + 0.008;
    ring.castShadow = false;
    ring.receiveShadow = false;
    group.add(ring);
    ripples.push({ mesh: ring, phase: index / 3, maxRadius: 0.9, period: 3.6 });
  }
  group.userData.anim = { kind: 'water', ripples } as FishingEntityAnim;
  return group;
}

/** 鱼竿长度（示意比例，够长才像"竿指水面"）。 */
const ROD_LENGTH = 2.6;

/**
 * 鱼竿：锥形竿身 + 握把。竿身以实体位置为中心、沿 +Y 摆放，再整体转向竿梢。
 *
 * 模板声明 tipOffset（竿梢相对竿中心的偏移）时，竿长 = 2·|tipOffset|、朝向 = tipOffset，
 * 竿尖恰好落在竿梢导线环上——主线从竿梢出发才连得上。未声明时退回固定长度与斜角。
 */
function buildRod(color: string, config?: Record<string, unknown>): THREE.Group {
  const group = new THREE.Group();
  group.userData.codePath = 'plugins-fishing/studio/scene/fishingMeshes.ts:buildRod';
  const offset = config?.tipOffset;
  const dir =
    Array.isArray(offset) && offset.length === 3
      ? new THREE.Vector3(offset[0] as number, offset[1] as number, offset[2] as number)
      : undefined;
  const declared = dir !== undefined && dir.lengthSq() > 1e-9;
  const length = declared ? dir.length() * 2 : ROD_LENGTH;

  const rod = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.035, length, 10), material(color, { roughness: 0.55 }));
  rod.castShadow = true;
  group.add(rod);
  // 握把套在竿根上（在竿身长度之内），不再伸出竿根之外。
  const gripH = 0.45;
  const grip = cyl(0.042, gripH, '#3b2f2a', 10, { roughness: 0.85 });
  grip.position.y = -length / 2 + gripH / 2;
  grip.castShadow = true;
  group.add(grip);

  if (declared) {
    group.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
    return group;
  }
  group.rotation.z = 0.62;
  group.rotation.y = -0.55;
  return group;
}

/** 水底泥沙：贴地薄板 + 几颗鹅卵石，透过半透明水体看得见才有"底"。 */
function buildPondBottom(size: TwinVector3, color: string): THREE.Group {
  const group = new THREE.Group();
  group.userData.codePath = 'plugins-fishing/studio/scene/fishingMeshes.ts:buildPondBottom';
  const slab = rbox(size[0], size[1], size[2], color, { roughness: 0.95 });
  slab.castShadow = false;
  slab.receiveShadow = false;
  group.add(slab);
  const pebbles: [number, number, number][] = [
    [-1.2, 0.6, 0.09],
    [0.7, -0.9, 0.07],
    [1.5, 1.1, 0.11],
  ];
  for (const [x, z, r] of pebbles) {
    const pebble = sphere(r, '#c2ab84', { roughness: 0.9 });
    pebble.position.set(x, size[1] / 2 + r * 0.5, z);
    pebble.castShadow = false;
    group.add(pebble);
  }
  return group;
}

/** 水草：一丛高低错落的细锥，带轻微倾角，贴在水底。 */
function buildWeed(color: string): THREE.Group {
  const group = new THREE.Group();
  group.userData.codePath = 'plugins-fishing/studio/scene/fishingMeshes.ts:buildWeed';
  const sway: NonNullable<FishingEntityAnim['sway']> = [];
  for (let index = 0; index < 6; index += 1) {
    const height = 0.22 + ((index * 37) % 23) / 100;
    const blade = new THREE.Mesh(new THREE.ConeGeometry(0.03, height, 6), material(color, { roughness: 0.7 }));
    blade.position.set((index - 2.5) * 0.09, height / 2, ((index % 3) - 1) * 0.05);
    blade.rotation.z = index % 2 === 0 ? 0.12 : -0.09;
    blade.castShadow = false;
    // 锥体绕自身中心转会"飘"，把几何下移让转轴落在根部，叶片才是从底上摆。
    blade.geometry.translate(0, height / 2, 0);
    blade.position.y = 0;
    group.add(blade);
    sway.push({ mesh: blade, axis: 'z', base: blade.rotation.z, amp: 0.1, speed: 1.1 + index * 0.13, phase: index * 0.9 });
  }
  group.userData.anim = { kind: 'weed', sway } as FishingEntityAnim;
  return group;
}

/**
 * 鱼影：压扁的纺锤身 + 尾鳍 + 背鳍，深灰蓝剪影色。
 * 位置固定（不做游动行为——装饰一动，确定性回放就得给鱼也上快照）；
 * 摆尾只是渲染层按渲染时钟做的表现，不写世界状态。
 */
function buildFish(color: string, size: TwinVector3): THREE.Group {
  const group = new THREE.Group();
  group.userData.codePath = 'plugins-fishing/studio/scene/fishingMeshes.ts:buildFish';
  const radius = Math.max(0.08, size[1]);
  const body = sphere(radius, color, { roughness: 0.45 });
  body.scale.set(1.35, 0.55, 0.42);
  body.castShadow = false;
  group.add(body);
  const tail = new THREE.Mesh(new THREE.ConeGeometry(radius * 0.55, radius * 1.1, 8), material(color, { roughness: 0.5 }));
  tail.rotation.z = Math.PI / 2;
  tail.position.x = -radius * 0.55;
  tail.castShadow = false;
  // 尾鳍挂在尾柄枢轴上：摆的是枢轴，尾鳍绕尾柄甩，而不是绕自身中心转。
  const tailPivot = new THREE.Group();
  tailPivot.position.x = -radius * 1.0;
  tailPivot.add(tail);
  group.add(tailPivot);
  const fin = new THREE.Mesh(new THREE.ConeGeometry(radius * 0.3, radius * 0.6, 6), material(color, { roughness: 0.5 }));
  fin.position.set(radius * 0.1, radius * 0.62, 0);
  fin.rotation.x = Math.PI / 4;
  fin.castShadow = false;
  group.add(fin);
  // 只摆尾、身体轻晃：鱼停在固定位置（装饰没有行为），但看起来是活的。
  const phase = size[0] * 17;
  group.userData.anim = {
    kind: 'fish',
    sway: [
      { mesh: tailPivot, axis: 'y', base: 0, amp: 0.45, speed: 5.5, phase },
      { mesh: body, axis: 'y', base: 0, amp: 0.05, speed: 5.5, phase: phase + Math.PI },
    ],
  } as FishingEntityAnim;
  return group;
}

/** 岸坡：一圈比水体大的沙土垫片，把"水体悬在地面网格上"变成"池子嵌在岸里"。 */
function buildShore(size: TwinVector3, color: string): THREE.Group {
  const group = new THREE.Group();
  group.userData.codePath = 'plugins-fishing/studio/scene/fishingMeshes.ts:buildShore';
  const pad = rbox(size[0], size[1], size[2], color, { roughness: 0.95 });
  pad.castShadow = false;
  pad.receiveShadow = true;
  group.add(pad);
  return group;
}

/** 钓台：钓箱 + 支脚，摆在岸边的标志性道具，钓竿从它后面伸出去。 */
function buildPlatform(color: string): THREE.Group {
  const group = new THREE.Group();
  group.userData.codePath = 'plugins-fishing/studio/scene/fishingMeshes.ts:buildPlatform';
  const box = rbox(0.62, 0.34, 0.45, color, { roughness: 0.5 });
  box.position.y = 0.32;
  box.castShadow = true;
  group.add(box);
  for (const [x, z] of [
    [-0.24, -0.15],
    [0.24, -0.15],
    [-0.24, 0.15],
    [0.24, 0.15],
  ] as const) {
    const leg = cyl(0.028, 0.3, '#4a4a4a', 8, { roughness: 0.6, metalness: 0.4 });
    leg.position.set(x, 0.15, z);
    group.add(leg);
  }
  return group;
}

/** 芦苇：几根细秆 + 穗头，插在岸边，给空旷的背景一点层次。 */
function buildReed(color: string): THREE.Group {
  const group = new THREE.Group();
  group.userData.codePath = 'plugins-fishing/studio/scene/fishingMeshes.ts:buildReed';
  for (let index = 0; index < 5; index += 1) {
    const height = 0.7 + ((index * 29) % 40) / 100;
    const stalk = cyl(0.012, height, '#6f8f4f', 6, { roughness: 0.8 });
    stalk.position.set((index - 2) * 0.07, height / 2, ((index % 2) - 0.5) * 0.06);
    stalk.rotation.z = ((index % 3) - 1) * 0.06;
    group.add(stalk);
    const head = cyl(0.024, 0.14, color, 6, { roughness: 0.85 });
    head.position.set((index - 2) * 0.07 + ((index % 3) - 1) * 0.06 * height * 0.5, height + 0.06, ((index % 2) - 0.5) * 0.06);
    group.add(head);
  }
  return group;
}

/**
 * 逻辑钓组：参数与观察的载体，本身不画实体——但**线**由它提供。
 *
 * 主线 / 子线是动态的（两端实体每帧都在动），所以这里只准备单位长的圆柱段，
 * 由控制器每帧按两端位置拉伸与转向。端点 id 与 fishingTemplate 的实体 id 对齐
 * （钓场是固定模板）。
 */
function buildRigMarker(): THREE.Group {
  const group = new THREE.Group();
  group.userData.codePath = 'plugins-fishing/studio/scene/fishingMeshes.ts:buildRig';

  // 拓扑与 rigPosture.RIG_LINKS 一致（钓场是固定模板，实体 id 直接写死）：
  //   主线：竿梢 → 浮漂 → 铅坠 → 8 字环
  //   子线：8 字环 → 上钩 / 下钩（两根**并联**）
  // 每根线都是一串 ROPE_SEGMENTS 截的软绳（rope.ts），控制器每帧按软绳节点摆每一截——
  // 有余量就下垂、贴底，拉满就绷直，被拖时带惯性甩动。
  const lines: { fromId: string; toId: string; kind: 'main' | 'branch'; bendAttr?: 'bendUpper' | 'bendLower' }[] = [
    { fromId: 'rod-tip-01', toId: 'float-01', kind: 'main' },
    { fromId: 'float-01', toId: 'sinker-01', kind: 'main' },
    { fromId: 'sinker-01', toId: 'swivel-01', kind: 'main' },
    { fromId: 'swivel-01', toId: 'hook-upper-01', kind: 'branch', bendAttr: 'bendUpper' },
    { fromId: 'swivel-01', toId: 'hook-lower-01', kind: 'branch', bendAttr: 'bendLower' },
  ];
  const rigId = 'rig-01';

  const fishingLines: NonNullable<FishingEntityAnim['fishingLines']>[number][] = [];
  for (const { fromId, toId, kind, bendAttr } of lines) {
    // 线不吃光照（MeshBasic）、画在水之后（renderOrder）：半透明水体不再把细线染暗吞掉。
    // 主线白、子线亮黄——子线在水下，要和水色、泥底都拉开对比。
    const lineMaterial = new THREE.MeshBasicMaterial({ color: kind === 'main' ? '#ffffff' : '#ffc933', transparent: true });
    const geometry = new THREE.CylinderGeometry(1, 1, 1, 8);
    const radius = kind === 'main' ? FISHING_LINE_R * 0.8 : FISHING_LINE_R * 0.65;
    for (let index = 0; index < ROPE_SEGMENTS; index += 1) {
      const mesh = new THREE.Mesh(geometry, lineMaterial);
      mesh.userData.radius = radius;
      mesh.renderOrder = 5;
      mesh.castShadow = false;
      group.add(mesh);
      fishingLines.push({ mesh, fromId, toId, kind, bendAttr, segment: { index, count: ROPE_SEGMENTS }, rigId });
    }
  }
  // 咬钩的鱼：平时隐藏，有口时由控制器摆到下钩饵旁（嘴含饵、身子朝外），随拖拽一起走。
  const biter = buildFish('#4f5d66', [0.3, 0.12, 0.08]);
  biter.userData.codePath = 'plugins-fishing/studio/scene/fishingMeshes.ts:buildRig:biter';
  biter.visible = false;
  group.add(biter);
  group.userData.anim = { kind: 'fishing-rig', fishingLines, biter } as FishingEntityAnim;
  return group;
}

/** 8 字环：主线与两根子线的分叉点，一个小金属环。 */
function buildSwivel(color: string): THREE.Group {
  const group = new THREE.Group();
  group.userData.codePath = 'plugins-fishing/studio/scene/fishingMeshes.ts:buildSwivel';
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.022, 0.007, 8, 16), material(color, { roughness: 0.35, metalness: 0.7 }));
  ring.castShadow = false;
  // 内层枢轴：随主线上下；两根子线与主线都挂在它上面。
  const pivot = new THREE.Group();
  group.add(pivot);
  pivot.add(ring);
  group.userData.lineAnchorPivot = pivot;
  return group;
}

/** 竿梢导线环：主线（RIG_LINKS 第一段）起点，套在竿尖上的小环。 */
function buildRodTip(color: string): THREE.Group {
  const group = new THREE.Group();
  group.userData.codePath = 'plugins-fishing/studio/scene/fishingMeshes.ts:buildRodTip';
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.03, 0.006, 8, 14), material(color, { roughness: 0.4, metalness: 0.6 }));
  ring.castShadow = false;
  group.add(ring);
  return group;
}

/** 不认识的实体交回宿主，不偷偷创建默认模型。 */
export function buildFishingEntityMesh(entity: EntityMeshInput): THREE.Group | undefined {
  const size = entity.visual?.size ?? [0.7, 0.7, 0.7];
  const color = entity.visual?.color ?? '#94a3b8';
  switch (entity.kind) {
    case 'water':
      return buildWater(size, color);
    case 'pondBottom':
      return buildPondBottom(size, color);
    case 'shore':
      return buildShore(size, color);
    case 'rod':
      return buildRod(color, entity.config);
    case 'rodTip':
      return buildRodTip(color);
    case 'swivel':
      return buildSwivel(color);
    case 'platform':
      return buildPlatform(color);
    case 'reed':
      return buildReed(color);
    case 'weed':
      return buildWeed(color);
    case 'fish':
      return buildFish(color, size);
    case 'float':
      return buildFloat(color);
    case 'sinker':
      return buildSinker(color);
    case 'hook':
      return buildHook(color);
    case 'bait':
      return buildBait(color);
    case 'rig':
      return buildRigMarker();
    default:
      return undefined;
  }
}
