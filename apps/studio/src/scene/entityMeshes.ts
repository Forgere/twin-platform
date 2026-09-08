import type { TwinVector3 } from '@twin-platform/world-kernel';
import * as THREE from 'three';

/**
 * 实体模型工厂：把一个 TwinEntity 的"声明"翻译成有造型的三维物件。
 *
 * 之前每个实体只有一个 BoxGeometry，设备全是一模一样的方块，看不出是什么。
 * 这里按 `kind` / id 前缀组合出可辨认的造型（参考 VividFactory 范例的做法）：
 * - transport：皮带台面 + 两侧护栏 + 一排滚筒 + 四根支腿（分拣台再挂一根推杆）
 * - inspect：跨在皮带上方的检测拱门（立柱 + 顶梁 + 半透明光幕 + 状态灯）
 * - buffer：货架（四立柱 + 层板 + 货位 + 顶灯），包装架比拒收架装得满
 * - asrs：高层货架（立柱分货位 + 多层纵梁 + 托盘 + 顶部天轨）
 * - stacker：堆垛机门架（底盘 + 车轮 + 双立柱 + 天梁 + 警示灯）
 * - carriage：载货台；fork：货叉；pallet：托盘货箱
 * - 其余（parcel）：货物方块
 *
 * 这一层只负责"长什么样"，不保存任何业务真相：尺寸取自实体声明的 `visual.size`，
 * 颜色取自 `visual.color`，全部由场景模板决定。
 */

const FRAME = '#E8E4DC';
const FRAME_DARK = '#CFC7B8';
const METAL = '#A9A296';
const PEACH = '#F4A261';
const SKY = '#9FD8F0';
const CARGO_COLORS = ['#FFB7B2', '#B5EAD7', '#C7CEEA', '#FFDAC1', '#FDFD96'];

export interface EntityMeshInput {
  id: string;
  kind: string;
  visual?: { kind?: string; color?: string; size?: TwinVector3 };
  transform: { position: TwinVector3; rotation?: TwinVector3 };
  capabilities?: readonly string[];
  config?: Record<string, unknown>;
}

interface MaterialOptions {
  roughness?: number;
  metalness?: number;
  emissive?: string;
  emissiveIntensity?: number;
  opacity?: number;
}

function material(color: string, options: MaterialOptions = {}): THREE.MeshStandardMaterial {
  const opacity = options.opacity ?? 1;
  return new THREE.MeshStandardMaterial({
    color,
    roughness: options.roughness ?? 0.62,
    metalness: options.metalness ?? 0.12,
    emissive: new THREE.Color(options.emissive ?? '#000000'),
    emissiveIntensity: options.emissiveIntensity ?? 1,
    transparent: opacity < 1,
    opacity,
  });
}

function boxMesh(width: number, height: number, depth: number, color: string, options?: MaterialOptions): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(width, height, depth), material(color, options));
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

function cylinderMesh(radius: number, height: number, color: string, segments = 12, options?: MaterialOptions): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, height, segments), material(color, options));
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

function sphereMesh(radius: number, color: string, options?: MaterialOptions): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, 10, 10), material(color, options));
  mesh.castShadow = true;
  return mesh;
}

function at<T extends THREE.Object3D>(object: T, x: number, y: number, z: number): T {
  object.position.set(x, y, z);
  return object;
}

/** 输送段：滚筒为真正承托面 + 两侧低边框（非高护栏）+ 每 ~1.35m 支腿 + 来料端驱动电机 + 底座薄板。
 *  结构对齐 r3f-tools 的 ConveyorBelt：滚筒顶面与台面齐平、框架是贴着滚筒底面的边梁、
 *  电机挂在来料端、长皮带按间距多腿支撑。 */
function buildConveyor(sizeX: number, sizeZ: number, color: string, baseY: number, id: string): THREE.Group {
  const group = new THREE.Group();
  // 皮带沿较长的那条水平边铺设：主输送段是沿 X 的长条，外部车道是沿 Z 的长条。
  const alongZ = sizeZ > sizeX;
  const length = alongZ ? sizeZ : sizeX;
  const width = alongZ ? sizeX : sizeZ;
  if (alongZ) group.rotation.y = Math.PI / 2;

  const deckHeight = 0.1;
  const deckCenterY = 0.25; // 局部坐标：台面中心（世界 y = baseY + 0.25）
  const deckTop = deckCenterY + deckHeight / 2; // 0.30 → 世界 0.90
  const deckBottom = deckCenterY - deckHeight / 2;
  const rollerRadius = 0.05;
  const rollerCenterY = deckTop - rollerRadius; // 滚筒顶面与台面齐平

  // 底座薄板（承载结构，落在滚筒下方）
  group.add(at(boxMesh(length * 0.98, 0.04, width * 0.9, FRAME_DARK, { roughness: 0.7 }), 0, deckBottom - 0.02, 0));

  // 两侧低边框：贴着滚筒底面走，绝不高于滚筒（参考 r3f-tools 的 frame beam，而非护栏）
  const beamH = 0.07;
  for (const side of [-1, 1]) {
    group.add(
      at(
        boxMesh(length * 0.98, beamH, 0.06, FRAME, { roughness: 0.6 }),
        0,
        deckBottom - beamH / 2 + 0.02,
        side * (width / 2 - 0.05),
      ),
    );
  }

  // 一排滚筒：真正承托面，轴沿 Z 横跨皮带，顶面与台面齐平
  const rollerCount = Math.max(3, Math.round(length / 0.32));
  for (let i = 0; i <= rollerCount; i += 1) {
    const x = -length / 2 + 0.16 + (i / rollerCount) * (length - 0.32);
    const roller = cylinderMesh(rollerRadius, width * 0.84, METAL, 10, { roughness: 0.35, metalness: 0.45 });
    roller.castShadow = false;
    roller.rotation.x = Math.PI / 2; // 圆柱默认沿 Y，转成沿 Z 横跨皮带
    group.add(at(roller, x, rollerCenterY, 0));
  }

  // 支腿：每 ~1.35m 一根，长皮带多腿；落到底座下方直到地面
  const groundY = -baseY;
  const legSpacing = 1.35;
  const nLegs = Math.max(1, Math.round(length / legSpacing));
  const legTopY = deckBottom - 0.02;
  const legHeight = Math.max(0.08, legTopY - groundY);
  const legCenterY = (legTopY + groundY) / 2;
  for (let i = 0; i <= nLegs; i += 1) {
    const lx = -length / 2 + (i / nLegs) * length;
    for (const sz of [-1, 1]) {
      group.add(at(cylinderMesh(0.045, legHeight, FRAME_DARK, 8, { roughness: 0.7 }), lx, legCenterY, sz * (width / 2 - 0.12)));
    }
  }

  // 来料端驱动电机（小圆柱 + 端盖，参考 r3f-tools 的 CuteMotor）
  const motorX = -length / 2 + 0.3;
  group.add(at(cylinderMesh(0.06, 0.14, METAL, 12, { roughness: 0.4, metalness: 0.5 }), motorX, rollerCenterY, width / 2 + 0.04));
  group.add(at(cylinderMesh(0.04, 0.05, FRAME_DARK, 12), motorX, rollerCenterY, width / 2 + 0.12));

  // 分拣台：侧面加一根推杆，和别的输送段区分开
  if (id.startsWith('sorter')) {
    group.add(at(boxMesh(0.16, 0.16, 0.72, PEACH, { roughness: 0.5 }), 0, deckCenterY + 0.18, width / 2 + 0.22));
  }

  return group;
}

/** 检测站：跨在皮带上方的拱门 + 半透明光幕 + 状态灯。 */
function buildInspection(size: TwinVector3, color: string, baseY: number): THREE.Group {
  const group = new THREE.Group();
  const [width, height, depth] = size;
  const groundY = -baseY;
  const postHeight = height * 0.95;

  // 立柱站在皮带**外侧**（比声明宽度再外扩一点），否则会啃进护栏里。
  for (const side of [-1, 1]) {
    const z = side * (depth / 2 + 0.04);
    group.add(at(boxMesh(0.13, postHeight, 0.13, color, { roughness: 0.5 }), 0, groundY + postHeight / 2, z));
    const foot = boxMesh(0.26, 0.05, 0.26, FRAME_DARK, { roughness: 0.75 });
    foot.castShadow = false;
    group.add(at(foot, 0, groundY + 0.025, z));
  }

  const topY = groundY + postHeight;
  group.add(at(boxMesh(0.16, 0.16, depth + 0.2, color, { roughness: 0.5 }), 0, topY + 0.08, 0));

  const curtain = boxMesh(width * 0.34, height * 0.6, depth * 0.86, SKY, {
    opacity: 0.26,
    roughness: 0.2,
    emissive: SKY,
    emissiveIntensity: 0.35,
  });
  curtain.castShadow = false;
  group.add(at(curtain, 0, groundY + height * 0.42, 0));

  group.add(at(sphereMesh(0.075, color, { emissive: color, emissiveIntensity: 0.9 }), 0, topY + 0.25, 0));

  return group;
}

/** 货架：立柱 + 层板 + 货位；包装架装满，拒收架空一些。 */
function buildRack(size: TwinVector3, color: string, baseY: number, id: string): THREE.Group {
  const group = new THREE.Group();
  const [width, height, depth] = size;
  const groundY = -baseY;

  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      group.add(
        at(
          boxMesh(0.1, height, 0.1, FRAME_DARK, { roughness: 0.7 }),
          sx * (width / 2 - 0.06),
          groundY + height / 2,
          sz * (depth / 2 - 0.06),
        ),
      );
    }
  }

  const shelves = 4;
  for (let i = 0; i < shelves; i += 1) {
    group.add(at(boxMesh(width * 0.96, 0.06, depth * 0.92, color, { roughness: 0.6 }), 0, groundY + height * (0.18 + i * 0.22), 0));
  }

  const filled = id.startsWith('pack');
  const spots = filled ? 6 : 3;
  for (let i = 0; i < spots; i += 1) {
    const shelf = i % 3;
    const y = groundY + height * (0.18 + shelf * 0.22) + 0.17;
    const x = -width / 2 + 0.42 + (i % 2) * 0.62;
    const z = -depth / 2 + 0.36 + ((i + (filled ? 1 : 0)) % 2) * 0.5;
    const cargo = boxMesh(0.34, 0.28, 0.34, CARGO_COLORS[i % CARGO_COLORS.length], { roughness: 0.5, metalness: 0.05 });
    group.add(at(cargo, x, y, z));
  }

  group.add(at(sphereMesh(0.07, color, { emissive: color, emissiveIntensity: 0.9 }), 0, groundY + height + 0.12, 0));

  return group;
}

/** 在制物料：一个带顶面封条的货箱。 */
function buildCargo(size: TwinVector3, color: string): THREE.Group {
  const group = new THREE.Group();
  group.add(boxMesh(size[0], size[1], size[2], color, { roughness: 0.45, metalness: 0.05 }));
  const tape = boxMesh(size[0] * 0.34, size[1] * 0.08, size[2] * 1.02, FRAME, { roughness: 0.7 });
  tape.castShadow = false;
  group.add(at(tape, 0, size[1] / 2, 0));
  return group;
}

/**
 * 高层货架（AS/RS）：沿长边（Z）分成若干货位，多层横梁 + 部分货位有托盘。
 * 填充与否用 (层, 位) 的确定性哈希决定 —— 不随机，刷新多少次都是同一张脸。
 */
function buildAsrsRack(size: TwinVector3, color: string, baseY: number): THREE.Group {
  const group = new THREE.Group();
  const [width, height, depth] = size;
  const groundY = -baseY;
  const levels = 5;
  const bays = Math.max(3, Math.round(depth / 2.2));
  const bayDepth = depth / bays;
  const postX = width / 2 - 0.06;

  // 立柱：每个货位分界处一对
  for (let i = 0; i <= bays; i += 1) {
    const z = -depth / 2 + i * bayDepth;
    for (const sx of [-1, 1]) {
      group.add(at(boxMesh(0.1, height, 0.1, FRAME_DARK, { roughness: 0.7 }), sx * postX, groundY + height / 2, z));
    }
  }

  // 每层两根纵梁
  for (let level = 0; level < levels; level += 1) {
    const y = groundY + (height / levels) * (level + 0.5);
    for (const sx of [-1, 1]) {
      const beam = boxMesh(0.07, 0.08, depth * 0.98, color, { roughness: 0.6 });
      beam.castShadow = false;
      group.add(at(beam, sx * (postX + 0.02), y, 0));
    }
  }

  // 货位托盘：约六成占用
  for (let level = 0; level < levels; level += 1) {
    const y = groundY + (height / levels) * (level + 0.5) + 0.24;
    for (let bay = 0; bay < bays; bay += 1) {
      if ((level * 7 + bay * 3) % 5 >= 3) continue;
      const z = -depth / 2 + bayDepth * (bay + 0.5);
      const pallet = boxMesh(width * 0.72, 0.4, bayDepth * 0.72, CARGO_COLORS[(level + bay) % CARGO_COLORS.length]!, {
        roughness: 0.55,
        metalness: 0.04,
      });
      pallet.castShadow = false;
      group.add(at(pallet, 0, y, z));
    }
  }

  // 顶部天轨（堆垛机上导轮走的那根）
  const rail = boxMesh(width * 0.5, 0.08, depth * 0.98, FRAME_DARK, { roughness: 0.6 });
  rail.castShadow = false;
  group.add(at(rail, 0, groundY + height + 0.1, 0));

  return group;
}

/** 堆垛机门架：底盘 + 车轮 + 双立柱 + 顶部天梁，沿 Z 方向行走。 */
function buildStacker(size: TwinVector3, color: string, baseY: number): THREE.Group {
  const group = new THREE.Group();
  const [width, height, length] = size;
  const groundY = -baseY;

  const chassis = boxMesh(width * 0.95, 0.26, length * 0.94, color, { roughness: 0.5, metalness: 0.2 });
  group.add(at(chassis, 0, groundY + 0.22, 0));
  const cabinet = boxMesh(width * 0.45, 0.42, length * 0.3, FRAME_DARK, { roughness: 0.6 });
  group.add(at(cabinet, -width * 0.22, groundY + 0.55, -length * 0.28));

  // 车轮：圆柱轴沿 X
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const wheel = cylinderMesh(0.13, 0.08, METAL, 12, { roughness: 0.4, metalness: 0.5 });
      wheel.rotation.z = Math.PI / 2;
      group.add(at(wheel, sx * (width / 2 - 0.02), groundY + 0.13, sz * (length / 2 - 0.22)));
    }
  }

  const mastHeight = height - 0.2;
  for (const sx of [-1, 1]) {
    group.add(
      at(boxMesh(0.12, mastHeight, 0.12, FRAME_DARK, { roughness: 0.55, metalness: 0.3 }), sx * (width / 2 - 0.14), groundY + 0.3 + mastHeight / 2, 0),
    );
  }
  group.add(at(boxMesh(width * 0.9, 0.1, 0.14, FRAME_DARK, { roughness: 0.55 }), 0, groundY + 0.3 + mastHeight, 0));
  group.add(at(sphereMesh(0.07, PEACH, { emissive: PEACH, emissiveIntensity: 0.9 }), 0, groundY + 0.3 + mastHeight + 0.14, 0));

  return group;
}

/** 载货台：平台 + 两侧导向，随门架走 Z、随起升变 Y。 */
function buildCarriage(size: TwinVector3, color: string): THREE.Group {
  const group = new THREE.Group();
  const [width, height, length] = size;
  group.add(boxMesh(width * 0.92, height * 0.36, length * 0.96, color, { roughness: 0.5, metalness: 0.2 }));
  for (const sx of [-1, 1]) {
    const guide = boxMesh(0.06, height * 0.9, length * 0.96, FRAME_DARK, { roughness: 0.6 });
    guide.castShadow = false;
    group.add(at(guide, sx * (width / 2 - 0.04), height * 0.28, 0));
  }
  return group;
}

/** 货叉：背板 + 两根对称叉齿（左右都能伸，靠实体位移决定伸向哪边）。 */
function buildFork(size: TwinVector3, color: string): THREE.Group {
  const group = new THREE.Group();
  const [width, height, depth] = size;
  const back = boxMesh(0.07, height * 1.5, depth * 0.96, FRAME_DARK, { roughness: 0.6 });
  group.add(at(back, -width / 2 + 0.04, height * 0.2, 0));
  for (const sz of [-1, 1]) {
    const prong = boxMesh(width * 0.92, height * 0.5, 0.09, color, { roughness: 0.45, metalness: 0.3 });
    prong.castShadow = false;
    group.add(at(prong, width * 0.04, 0, sz * (depth / 2 - 0.12)));
  }
  return group;
}

/**
 * 托盘：底托 + 纸箱 + 封条，堆垛机取放的那一个。
 * 整体按 size 高度居中，这样"放在台面上"就是 y = 台面 + 半高，不用在行为里补偏移。
 */
function buildPallet(size: TwinVector3, color: string): THREE.Group {
  const group = new THREE.Group();
  const [width, height, depth] = size;
  const baseH = height * 0.2;
  const cartonH = height * 0.72;
  const bottom = -height / 2;

  group.add(at(boxMesh(width, baseH, depth, FRAME_DARK, { roughness: 0.75 }), 0, bottom + baseH / 2, 0));
  group.add(
    at(
      boxMesh(width * 0.86, cartonH, depth * 0.88, color, { roughness: 0.5, metalness: 0.04 }),
      0,
      bottom + baseH + cartonH / 2,
      0,
    ),
  );
  const tape = boxMesh(width * 0.3, height * 0.06, depth * 0.9, FRAME, { roughness: 0.7 });
  tape.castShadow = false;
  group.add(at(tape, 0, bottom + baseH + cartonH, 0));
  return group;
}

/**
 * 顶升移栽机：inline 串在输送线里的分流转接台，结构对齐 r3f-tools 的 LiftTransferUnit。
 * - 8 根滚筒银行（与主线同款，顶面与台面齐平）；
 * - 两侧侧板，出口侧（南向，z<0）留开口，货从这里被横推出去；
 * - 四角顶升气缸 + 伸缩导杆（把整个滚筒组顶起）；
 * - 末端驱动电机、来料端对射光电眼、侧柱状态灯；
 * - 控制箱落在支墩上、支墩到地面。
 * 台面顶（世界 0.90）严格对齐普通输送线，直行货从上面平滑滚过。
 */
function buildTransfer(size: TwinVector3, color: string, baseY: number): THREE.Group {
  const group = new THREE.Group();
  const [width, , depth] = size;
  const groundY = -baseY;
  const deckHeight = 0.1;
  const deckCenterY = 0.25;
  const deckTop = deckCenterY + deckHeight / 2;
  const deckBottom = deckCenterY - deckHeight / 2;
  const rollerRadius = 0.05;
  const rollerCenterY = deckTop - rollerRadius;

  // 底板
  group.add(at(boxMesh(width * 0.98, 0.06, depth * 0.94, FRAME_DARK, { roughness: 0.7 }), 0, groundY + 0.04, 0));

  // 四角支腿到地面
  const legTopY = deckBottom - 0.02;
  const legHeight = Math.max(0.08, legTopY - groundY);
  const legCenterY = (legTopY + groundY) / 2;
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      group.add(at(cylinderMesh(0.05, legHeight, FRAME_DARK, 8, { roughness: 0.7 }), sx * (width / 2 - 0.2), legCenterY, sz * (depth / 2 - 0.15)));
    }
  }

  // 滚筒组（8 根，轴沿 Z，顶面与台面齐平）
  const rollerCount = 8;
  for (let i = 0; i < rollerCount; i += 1) {
    const x = -width / 2 + 0.16 + (i / (rollerCount - 1)) * (width - 0.32);
    const roller = cylinderMesh(rollerRadius, depth * 0.82, METAL, 10, { roughness: 0.35, metalness: 0.45 });
    roller.castShadow = false;
    roller.rotation.x = Math.PI / 2;
    group.add(at(roller, x, rollerCenterY, 0));
  }

  // 两侧侧板：出口侧（-Z，朝分流支线）留开口，其余侧板实封
  for (const side of [-1, 1]) {
    const plateZ = side * (depth / 2 - 0.025);
    if (side === -1) {
      group.add(at(boxMesh(width * 0.34, 0.26, 0.05, METAL, { roughness: 0.5, metalness: 0.4 }), -width * 0.2, deckCenterY, plateZ));
      group.add(at(boxMesh(width * 0.34, 0.26, 0.05, METAL, { roughness: 0.5, metalness: 0.4 }), width * 0.2, deckCenterY, plateZ));
    } else {
      group.add(at(boxMesh(width * 0.96, 0.26, 0.05, METAL, { roughness: 0.5, metalness: 0.4 }), 0, deckCenterY, plateZ));
    }
  }

  // 四角顶升气缸 + 伸缩导杆
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      group.add(at(cylinderMesh(0.045, 0.22, FRAME_DARK, 10, { roughness: 0.5, metalness: 0.4 }), sx * (width / 2 - 0.18), deckCenterY + 0.08, sz * (depth / 2 - 0.16)));
      group.add(at(cylinderMesh(0.025, 0.3, METAL, 8, { roughness: 0.4, metalness: 0.5 }), sx * (width / 2 - 0.18), deckCenterY + 0.2, sz * (depth / 2 - 0.16)));
    }
  }

  // 末端驱动电机（rounded box 近似：短方壳）
  group.add(at(boxMesh(0.22, 0.18, 0.2, METAL, { roughness: 0.45, metalness: 0.4 }), width / 2 - 0.04, rollerCenterY, 0));

  // 来料端对射光电眼（红，两角各一）
  for (const sz of [-1, 1]) {
    group.add(at(boxMesh(0.08, 0.08, 0.08, '#FF5252', { emissive: '#FF5252', emissiveIntensity: 0.6 }), -width / 2 + 0.12, deckCenterY + 0.05, sz * (depth / 2 - 0.12)));
  }

  // 侧柱 + 状态灯
  group.add(at(boxMesh(0.05, 0.42, 0.05, FRAME_DARK, { roughness: 0.6 }), -width / 2 + 0.12, deckCenterY + 0.2, depth / 2 - 0.1));
  group.add(at(sphereMesh(0.06, color, { emissive: color, emissiveIntensity: 0.9 }), -width / 2 + 0.12, deckCenterY + 0.44, depth / 2 - 0.1));

  // 控制箱 + 支墩（落地）
  group.add(at(cylinderMesh(0.04, deckCenterY - 0.18, FRAME_DARK, 8, { roughness: 0.7 }), width / 2 - 0.12, (deckCenterY - 0.18 + groundY) / 2, depth / 2 + 0.12));
  group.add(at(boxMesh(0.2, 0.26, 0.16, FRAME_DARK, { roughness: 0.6 }), width / 2 - 0.12, deckCenterY + 0.0, depth / 2 + 0.12));

  return group;
}

/**
 * 托举座（cassette）：滚筒缝隙里那组横向传动轴 + 驱动轮，平时缩在台面以下，
 * 由 `transfer-cycle` 顶起把货抬离滚筒、横向送出去。本身是浮动子实体，
 * 世界位姿每步由行为改写，模型只在本地原点附近造型即可。
 *
 * 承载面（横轴中心）定在本地 0.26：cassette 实体 y=0.6 时承载面世界 0.86，
 * 略低于台面 0.90、藏进滚筒线下；顶起 liftHeight=0.13 后实体 y=0.73，
 * 承载面世界 0.99，刚好把货（货底随行为抬到 ~1.03）抬离滚筒。
 */
function buildCassette(size: TwinVector3, color: string): THREE.Group {
  const group = new THREE.Group();
  const [width, height, depth] = size;
  const carryY = 0.26; // 横轴中心（本地），决定承载面高度

  // 横向传动轴（沿 Z 横跨皮带）
  const axle = cylinderMesh(0.05, depth * 0.9, FRAME_DARK, 10, { roughness: 0.4, metalness: 0.5 });
  axle.rotation.x = Math.PI / 2;
  group.add(at(axle, 0, carryY - 0.04, 0));

  // 驱动轮（沿 X，把货横推出去）
  for (const sz of [-1, 1]) {
    for (const sx of [-1, 1]) {
      const wheel = cylinderMesh(0.07, 0.05, METAL, 12, { roughness: 0.4, metalness: 0.5 });
      wheel.rotation.z = Math.PI / 2;
      group.add(at(wheel, sx * (width / 2 - 0.16), carryY - 0.04, sz * (depth / 2 - 0.18)));
    }
  }

  // 两侧导轨
  for (const side of [-1, 1]) {
    group.add(at(boxMesh(width * 0.9, 0.04, 0.05, color, { roughness: 0.5 }), 0, carryY - 0.06, side * (depth / 2 - 0.05)));
  }

  return group;
}

/**
 * 90°转角输送模块：把两条垂直皮带接到一起，货物在此转向。
 * 结构对齐 r3f-tools 的 `filletPolyline` 思路——皮带在转角处弯成平滑四分之一圆弧，
 * 这里用一排沿圆弧排布的滚筒表现"弯道皮带"，而非方台十字交叉。
 * 台面比普通皮带高 1cm（顶世界 0.91），避免与接入皮带 z-fighting。
 */
function buildCorner(size: TwinVector3, color: string, baseY: number): THREE.Group {
  const group = new THREE.Group();
  const [width, , depth] = size;
  const groundY = -baseY;
  const deckHeight = 0.12;
  const deckCenterY = 0.25;
  const deckTop = deckCenterY + deckHeight / 2; // 0.31 → 世界 0.91
  const deckBottom = deckCenterY - deckHeight / 2;
  const rollerRadius = 0.05;
  const rollerCenterY = deckTop - rollerRadius;

  // 方形台面（补齐拐角缺口，顶比直行皮带高 1cm）
  group.add(at(boxMesh(width * 0.98, deckHeight, depth * 0.98, color, { roughness: 0.5 }), 0, deckCenterY, 0));

  // 弯道滚筒：沿四分之一圆弧排布，表现皮带在转角处弯转
  const r = width / 2;
  const cx = width / 2; // 圆弧外心落在转角外侧角点
  const n = 5;
  for (let i = 0; i < n; i += 1) {
    const a = Math.PI + (i / (n - 1)) * (Math.PI / 2); // 从 π 扫到 3π/2，覆盖 90° 转角
    const x = cx + r * Math.cos(a);
    const z = cx + r * Math.sin(a);
    const roller = cylinderMesh(rollerRadius, width * 0.5, METAL, 8, { roughness: 0.35, metalness: 0.45 });
    roller.castShadow = false;
    roller.rotation.x = Math.PI / 2;
    group.add(at(roller, x, rollerCenterY, z));
  }

  // 两侧低包边
  for (const side of [-1, 1]) {
    group.add(
      at(
        boxMesh(width * 0.98, 0.08, 0.05, FRAME_DARK, { roughness: 0.55 }),
        0,
        deckBottom + 0.04,
        side * (depth / 2 - 0.03),
      ),
    );
  }

  // 四根支腿
  const legTopY = deckBottom - 0.02;
  const legHeight = Math.max(0.08, legTopY - groundY);
  const legCenterY = (legTopY + groundY) / 2;
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      group.add(at(cylinderMesh(0.05, legHeight, FRAME_DARK, 8, { roughness: 0.7 }), sx * (width / 2 - 0.18), legCenterY, sz * (depth / 2 - 0.18)));
    }
  }

  return group;
}

/** 按实体类型生成模型；未知类型退回货箱，保证外部数据源补出来的实体不会消失。 */
export function buildEntityMesh(entity: EntityMeshInput): THREE.Group {
  const size = entity.visual?.size ?? [0.7, 0.7, 0.7];
  const color = entity.visual?.color ?? '#94a3b8';
  const baseY = entity.transform.position[1] ?? 0;

  switch (entity.kind) {
    case 'transport':
      return buildConveyor(size[0], size[2], color, baseY, entity.id);
    case 'inspect':
      return buildInspection(size, color, baseY);
    case 'buffer':
      return buildRack(size, color, baseY, entity.id);
    case 'asrs':
      return buildAsrsRack(size, color, baseY);
    case 'stacker':
      return buildStacker(size, color, baseY);
    case 'carriage':
      return buildCarriage(size, color);
    case 'fork':
      return buildFork(size, color);
    case 'pallet':
      return buildPallet(size, color);
    case 'transfer':
      return buildTransfer(size, color, baseY);
    case 'cassette':
      return buildCassette(size, color);
    case 'corner':
      return buildCorner(size, color, baseY);
    default:
      return buildCargo(size, color);
  }
}

/** 收集一个模型上所有标准材质，供选中高亮统一改 emissive。 */
export function collectMaterials(root: THREE.Object3D): THREE.MeshStandardMaterial[] {
  const result: THREE.MeshStandardMaterial[] = [];
  root.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (mesh.isMesh && mesh.material instanceof THREE.MeshStandardMaterial) result.push(mesh.material);
  });
  return result;
}

/** 递归释放一个模型的几何体与材质。 */
export function disposeObject(root: THREE.Object3D): void {
  root.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.geometry.dispose();
    const material = mesh.material;
    if (Array.isArray(material)) material.forEach((item) => item.dispose());
    else material.dispose();
  });
}
