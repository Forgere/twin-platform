import type { TwinVector3 } from '@twin-platform/world-kernel';
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { getActiveTheme, cargoColorFor, type DeviceTheme } from './theme';

/**
 * 实体模型工厂：把一个 TwinEntity 的"声明"翻译成有造型的三维物件。
 *
 * 参考 VividFactory / r3f-tools 的做法，并按本项目的仿真契约补了三件事：
 * - 每个模型挂 `userData.codePath`：点中就能回答"它由 entityMeshes.ts 的哪个函数渲染"；
 * - 可动子部件（皮带箭头 shader、滚筒、状态灯、缓存货位）挂 `userData.anim`，
 *   供 `TwinSceneController` 按内核发来的 status / attrs 驱动；
 * - 颜色 / 圆角全读 `DeviceTheme`，切主题=换对象，组件不写字面量。
 *
 * 这一层只负责"长什么样"，不保存任何业务真相：尺寸取自实体声明的 `visual.size`，
 * 颜色取自 `visual.color`，全部由场景模板决定。
 */

/** 渲染层每帧从内核 status / attrs 消费的动画句柄。 */
export interface EntityAnim {
  kind: string;
  /** 输送带箭头流动 shader（仅 transport）。 */
  belt?: THREE.ShaderMaterial;
  /** 滚筒网格数组（仅 transport），按速度旋转。 */
  rollers?: THREE.Mesh[];
  /** 状态灯材质（inspect / buffer / transfer / stacker），idle↔active 变色。 */
  statusLight?: THREE.MeshStandardMaterial;
  /** 缓存货架预置货位（仅 buffer），按 attrs.fill 显隐。 */
  bufferSlots?: THREE.Mesh[];
  /** 顶升链带的链轮（仅 cassette）：顶起后按出货方向自转。 */
  sprockets?: THREE.Mesh[];
  /** 顶升链带上的链齿（仅 cassette）：沿 local Z 循环平移，链条才像在跑。 */
  chainTeeth?: { mesh: THREE.Mesh; halfSpan: number }[];
  /** 出货方向：+1 沿 local +Z，-1 沿 local -Z。决定链轮转向与链齿走向。 */
  divertSign?: number;
}

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

/** 圆角盒子：玩具工厂质感靠它；industrial 主题 radius≈0 退回方角。 */
function rbox(width: number, height: number, depth: number, color: string, options?: MaterialOptions): THREE.Mesh {
  const theme = getActiveTheme();
  const radius = Math.min(theme.cornerRadius, Math.min(width, height, depth) / 2 - 1e-3);
  const geometry = radius > 1e-4 ? new RoundedBoxGeometry(width, height, depth, 4, radius) : new THREE.BoxGeometry(width, height, depth);
  const mesh = new THREE.Mesh(geometry, material(color, options));
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

function cyl(radius: number, height: number, color: string, segments = 12, options?: MaterialOptions): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, height, segments), material(color, options));
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

function sphere(radius: number, color: string, options?: MaterialOptions): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, 10, 10), material(color, options));
  mesh.castShadow = true;
  return mesh;
}

function at<T extends THREE.Object3D>(object: T, x: number, y: number, z: number): T {
  object.position.set(x, y, z);
  return object;
}

/** 状态灯：放在设备顶端，材质引用存进 anim 供控制器 idle↔active 切换。 */
function statusLamp(y: number, theme: DeviceTheme): THREE.Mesh {
  const lamp = sphere(0.07, theme.lightIdle, { emissive: theme.lightIdle, emissiveIntensity: 0.9 });
  lamp.position.y = y;
  return lamp;
}

/**
 * 皮带箭头流动 shader：按 UV 滚动箭头，比贴图省事、可逐线调色。
 *
 * 两个关键约定（改之前踩过的坑）：
 * - **滚动必须走 `vUv.x`**：皮带面是 `PlaneGeometry(长度, 宽度)`，`u` 沿长度方向、
 *   也就是物料行进方向；拿 `vUv.y` 去滚会让箭头横穿带宽，跟 path 完全无关。
 * - **要真透明**：`depthWrite: false` + 低背景 alpha，滚筒才透得出来；
 *   只写个 0.85 常量等于没透明，还会把滚筒盖住。
 *
 * `direction` 用 local +X 定义：+1 顺着 local +X 流，-1 逆着流。
 * 沿 Z 铺的皮带在 buildConveyor 里被转了 90°，local +X 指向世界 -Z，
 * 所以"顺着 path 流"要按实际行进方向选 ±1（模板里用 `beltDirection` 声明）。
 */
function beltMaterial(theme: DeviceTheme, direction: number, repeat: number): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    transparent: true,
    // 透明面别写深度，否则会把下面的滚筒挡掉、还容易和台面 z-fighting。
    depthWrite: false,
    side: THREE.DoubleSide,
    uniforms: {
      time: { value: 0 },
      color: { value: new THREE.Color(theme.accent) },
      /** 一条皮带上排几个箭头（按长度算，保证箭头间距不随段长拉伸）。 */
      repeat: { value: repeat },
      /** 每秒流动几个箭头周期。 */
      speed: { value: 0.55 },
      direction: { value: direction },
      /** 人字形箭头的后掠量（周期占比）：0 是直条，越大越尖。 */
      chevron: { value: 0.42 },
      alpha: { value: 0.85 },
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float time;
      uniform vec3 color;
      uniform float repeat;
      uniform float speed;
      uniform float direction;
      uniform float chevron;
      uniform float alpha;
      varying vec2 vUv;
      void main() {
        // fwd：沿行进方向的长度坐标（0 → 1），direction 负责掉头
        float fwd = direction >= 0.0 ? vUv.x : 1.0 - vUv.x;
        // across：0 在带宽中心、1 在两侧边缘，用来把直条拗成人字形
        float across = abs(vUv.y - 0.5) * 2.0;
        float u = fwd * repeat + across * chevron - time * speed;
        float k = fract(u);
        // 箭头：头锐（k→1 处截断）尾渐隐，指向行进方向
        float arrow = smoothstep(0.35, 1.0, k);
        vec3 c = mix(color * 0.4, color, arrow);
        // 底噪几乎全透明（露出滚筒），箭头处才提亮提实
        gl_FragColor = vec4(c, mix(0.10, 0.85, arrow) * alpha);
      }
    `,
  });
}

/** 输送段：皮带箭头面 + 滚筒（旋转）+ 两侧低边框 + 支腿 + 来料端电机 + 状态灯。 */
function buildConveyor(
  sizeX: number,
  sizeZ: number,
  color: string,
  baseY: number,
  id: string,
  /** 箭头流动方向：+1 顺 local +X，-1 逆行。沿 Z 铺设时 local +X 指向世界 -Z。 */
  direction = 1,
): THREE.Group {
  const theme = getActiveTheme();
  const group = new THREE.Group();
  group.userData.codePath = 'entityMeshes.ts:buildConveyor';
  const alongZ = sizeZ > sizeX;
  const length = alongZ ? sizeZ : sizeX;
  const width = alongZ ? sizeX : sizeZ;
  if (alongZ) group.rotation.y = Math.PI / 2;

  const deckHeight = 0.1;
  const deckCenterY = 0.25;
  const deckTop = deckCenterY + deckHeight / 2;
  const deckBottom = deckCenterY - deckHeight / 2;
  const rollerRadius = 0.05;
  const rollerCenterY = deckTop - rollerRadius;

  // 皮带箭头面：盖在滚筒上方，UV.x 沿皮带长度方向滚动箭头。
  // 箭头间距按 1.1m 一个折算成 repeat，长皮带不会把箭头拉长。
  const belt = new THREE.Mesh(
    new THREE.PlaneGeometry(length * 0.96, width * 0.82),
    beltMaterial(theme, direction, Math.max(1, Math.round(length / 1.1))),
  );
  belt.rotation.x = -Math.PI / 2;
  belt.position.y = deckTop + 0.005;
  belt.renderOrder = 2;
  belt.castShadow = false;
  belt.receiveShadow = false;
  group.add(belt);

  group.add(at(rbox(length * 0.98, 0.04, width * 0.9, theme.frameDark, { roughness: 0.7 }), 0, deckBottom - 0.02, 0));

  for (const side of [-1, 1]) {
    group.add(at(rbox(length * 0.98, 0.07, 0.06, theme.frame, { roughness: 0.6 }), 0, deckBottom - 0.05 / 2 + 0.02, side * (width / 2 - 0.05)));
  }

  const rollers: THREE.Mesh[] = [];
  const rollerCount = Math.max(3, Math.round(length / 0.32));
  for (let i = 0; i <= rollerCount; i += 1) {
    const x = -length / 2 + 0.16 + (i / rollerCount) * (length - 0.32);
    const roller = cyl(rollerRadius, width * 0.84, theme.roller, 10, { roughness: 0.35, metalness: 0.45 });
    roller.castShadow = false;
    roller.rotation.x = Math.PI / 2;
    roller.position.set(x, rollerCenterY, 0);
    rollers.push(roller);
    group.add(roller);
  }

  const groundY = -baseY;
  const legSpacing = 1.35;
  const nLegs = Math.max(1, Math.round(length / legSpacing));
  const legTopY = deckBottom - 0.02;
  const legHeight = Math.max(0.08, legTopY - groundY);
  const legCenterY = (legTopY + groundY) / 2;
  for (let i = 0; i <= nLegs; i += 1) {
    const lx = -length / 2 + (i / nLegs) * length;
    for (const sz of [-1, 1]) {
      group.add(at(cyl(0.045, legHeight, theme.frameDark, 8, { roughness: 0.7 }), lx, legCenterY, sz * (width / 2 - 0.12)));
    }
  }

  const motorX = -length / 2 + 0.3;
  group.add(at(cyl(0.06, 0.14, theme.metal, 12, { roughness: 0.4, metalness: 0.5 }), motorX, rollerCenterY, width / 2 + 0.04));
  group.add(at(cyl(0.04, 0.05, theme.frameDark, 12), motorX, rollerCenterY, width / 2 + 0.12));

  if (id.startsWith('sorter')) {
    group.add(at(rbox(0.16, 0.16, 0.72, theme.accent, { roughness: 0.5 }), 0, deckCenterY + 0.18, width / 2 + 0.22));
  }

  const lamp = statusLamp(deckCenterY + 0.5, theme);
  group.add(lamp);

  group.userData.anim = { kind: 'transport', belt: belt.material as THREE.ShaderMaterial, rollers, rollerSign: direction, statusLight: lamp.material as THREE.MeshStandardMaterial } as EntityAnim;
  return group;
}

/** 检测站：跨在皮带上方的拱门 + 半透明光幕 + 状态灯。 */
function buildInspection(size: TwinVector3, color: string, baseY: number): THREE.Group {
  const theme = getActiveTheme();
  const group = new THREE.Group();
  group.userData.codePath = 'entityMeshes.ts:buildInspection';
  const [width, height, depth] = size;
  const groundY = -baseY;
  const postHeight = height * 0.95;

  for (const side of [-1, 1]) {
    const z = side * (depth / 2 + 0.04);
    group.add(at(rbox(0.13, postHeight, 0.13, color, { roughness: 0.5 }), 0, groundY + postHeight / 2, z));
    const foot = rbox(0.26, 0.05, 0.26, theme.frameDark, { roughness: 0.75 });
    foot.castShadow = false;
    group.add(at(foot, 0, groundY + 0.025, z));
  }

  const topY = groundY + postHeight;
  group.add(at(rbox(0.16, 0.16, depth + 0.2, color, { roughness: 0.5 }), 0, topY + 0.08, 0));

  const curtain = new THREE.Mesh(
    new THREE.PlaneGeometry(width * 0.34, height * 0.6),
    material(theme.roller, { opacity: 0.26, roughness: 0.2, emissive: theme.roller, emissiveIntensity: 0.35 }),
  );
  curtain.castShadow = false;
  curtain.position.set(0, groundY + height * 0.42, 0);
  group.add(curtain);

  const lamp = statusLamp(topY + 0.25, theme);
  group.add(lamp);

  group.userData.anim = { kind: 'inspect', statusLight: lamp.material as THREE.MeshStandardMaterial } as EntityAnim;
  return group;
}

/**
 * 缓存货架：立柱 + 层板 + 货位。货位按 `attrs.fill` 实时显隐
 *（由 buffer-fill 行为算出来），不再写死"包装架满 / 拒收架空"。
 */
function buildRack(size: TwinVector3, color: string, baseY: number): THREE.Group {
  const theme = getActiveTheme();
  const group = new THREE.Group();
  group.userData.codePath = 'entityMeshes.ts:buildRack';
  const [width, height, depth] = size;
  const groundY = -baseY;

  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      group.add(at(rbox(0.1, height, 0.1, theme.frameDark, { roughness: 0.7 }), sx * (width / 2 - 0.06), groundY + height / 2, sz * (depth / 2 - 0.06)));
    }
  }

  const shelves = 4;
  for (let i = 0; i < shelves; i += 1) {
    group.add(at(rbox(width * 0.96, 0.06, depth * 0.92, color, { roughness: 0.6 }), 0, groundY + height * (0.18 + i * 0.22), 0));
  }

  // 预置货位：初始隐藏，applyState 按 fill 比例点亮前 N 个。
  const slots: THREE.Mesh[] = [];
  const slotCount = 8;
  for (let i = 0; i < slotCount; i += 1) {
    const shelf = i % shelves;
    const x = -width / 2 + 0.42 + (i % 2) * 0.62;
    const z = -depth / 2 + 0.36 + (i % 4 >= 2 ? 0.5 : 0);
    const cargo = rbox(0.34, 0.28, 0.34, theme.cargoColors[i % theme.cargoColors.length]!, { roughness: 0.5, metalness: 0.05 });
    cargo.position.set(x, groundY + height * (0.18 + shelf * 0.22) + 0.17, z);
    cargo.visible = false;
    slots.push(cargo);
    group.add(cargo);
  }

  const lamp = statusLamp(groundY + height + 0.12, theme);
  group.add(lamp);

  group.userData.anim = { kind: 'buffer', statusLight: lamp.material as THREE.MeshStandardMaterial, bufferSlots: slots } as EntityAnim;
  return group;
}

/** 在制物料：带顶面封条的货箱（非实例化路径的兜底，实例化走 CargoPool）。 */
function buildCargo(size: TwinVector3, color: string): THREE.Group {
  const group = new THREE.Group();
  group.userData.codePath = 'entityMeshes.ts:buildCargo';
  group.add(rbox(size[0], size[1], size[2], color, { roughness: 0.45, metalness: 0.05 }));
  const tape = rbox(size[0] * 0.34, size[1] * 0.08, size[2] * 1.02, getActiveTheme().frame, { roughness: 0.7 });
  tape.castShadow = false;
  group.add(at(tape, 0, size[1] / 2, 0));
  return group;
}

/** 高层货架（AS/RS）：货位 + 横梁 + 部分托盘（确定性哈希，刷新同脸）。 */
function buildAsrsRack(size: TwinVector3, color: string, baseY: number): THREE.Group {
  const theme = getActiveTheme();
  const group = new THREE.Group();
  group.userData.codePath = 'entityMeshes.ts:buildAsrsRack';
  const [width, height, depth] = size;
  const groundY = -baseY;
  const levels = 5;
  const bays = Math.max(3, Math.round(depth / 2.2));
  const bayDepth = depth / bays;
  const postX = width / 2 - 0.06;

  for (let i = 0; i <= bays; i += 1) {
    const z = -depth / 2 + i * bayDepth;
    for (const sx of [-1, 1]) {
      group.add(at(rbox(0.1, height, 0.1, theme.frameDark, { roughness: 0.7 }), sx * postX, groundY + height / 2, z));
    }
  }

  for (let level = 0; level < levels; level += 1) {
    const y = groundY + (height / levels) * (level + 0.5);
    for (const sx of [-1, 1]) {
      const beam = rbox(0.07, 0.08, depth * 0.98, color, { roughness: 0.6 });
      beam.castShadow = false;
      group.add(at(beam, sx * (postX + 0.02), y, 0));
    }
  }

  for (let level = 0; level < levels; level += 1) {
    const y = groundY + (height / levels) * (level + 0.5) + 0.24;
    for (let bay = 0; bay < bays; bay += 1) {
      if ((level * 7 + bay * 3) % 5 >= 3) continue;
      const z = -depth / 2 + bayDepth * (bay + 0.5);
      const pallet = rbox(width * 0.72, 0.4, bayDepth * 0.72, theme.cargoColors[(level + bay) % theme.cargoColors.length]!, { roughness: 0.55, metalness: 0.04 });
      pallet.castShadow = false;
      group.add(at(pallet, 0, y, z));
    }
  }

  group.add(at(rbox(width * 0.5, 0.08, depth * 0.98, theme.frameDark, { roughness: 0.6 }), 0, groundY + height + 0.1, 0));
  return group;
}

/** 堆垛机门架：底盘 + 车轮 + 双立柱 + 顶部天梁 + 状态灯。 */
function buildStacker(size: TwinVector3, color: string, baseY: number): THREE.Group {
  const theme = getActiveTheme();
  const group = new THREE.Group();
  group.userData.codePath = 'entityMeshes.ts:buildStacker';
  const [width, height, length] = size;
  const groundY = -baseY;

  group.add(at(rbox(width * 0.95, 0.26, length * 0.94, color, { roughness: 0.5, metalness: 0.2 }), 0, groundY + 0.22, 0));
  group.add(at(rbox(width * 0.45, 0.42, length * 0.3, theme.frameDark, { roughness: 0.6 }), -width * 0.22, groundY + 0.55, -length * 0.28));

  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const wheel = cyl(0.13, 0.08, theme.metal, 12, { roughness: 0.4, metalness: 0.5 });
      wheel.rotation.z = Math.PI / 2;
      group.add(at(wheel, sx * (width / 2 - 0.02), groundY + 0.13, sz * (length / 2 - 0.22)));
    }
  }

  const mastHeight = height - 0.2;
  for (const sx of [-1, 1]) {
    group.add(at(rbox(0.12, mastHeight, 0.12, theme.frameDark, { roughness: 0.55, metalness: 0.3 }), sx * (width / 2 - 0.14), groundY + 0.3 + mastHeight / 2, 0));
  }
  group.add(at(rbox(width * 0.9, 0.1, 0.14, theme.frameDark, { roughness: 0.55 }), 0, groundY + 0.3 + mastHeight, 0));
  const lamp = statusLamp(groundY + 0.3 + mastHeight + 0.14, theme);
  group.add(lamp);

  group.userData.anim = { kind: 'stacker', statusLight: lamp.material as THREE.MeshStandardMaterial } as EntityAnim;
  return group;
}

/** 载货台：平台 + 两侧导向。 */
function buildCarriage(size: TwinVector3, color: string): THREE.Group {
  const group = new THREE.Group();
  group.userData.codePath = 'entityMeshes.ts:buildCarriage';
  const [width, height, length] = size;
  group.add(rbox(width * 0.92, height * 0.36, length * 0.96, color, { roughness: 0.5, metalness: 0.2 }));
  for (const sx of [-1, 1]) {
    const guide = rbox(0.06, height * 0.9, length * 0.96, getActiveTheme().frameDark, { roughness: 0.6 });
    guide.castShadow = false;
    group.add(at(guide, sx * (width / 2 - 0.04), height * 0.28, 0));
  }
  return group;
}

/** 货叉：背板 + 两根对称叉齿。 */
function buildFork(size: TwinVector3, color: string): THREE.Group {
  const theme = getActiveTheme();
  const group = new THREE.Group();
  group.userData.codePath = 'entityMeshes.ts:buildFork';
  const [width, height, depth] = size;
  const back = rbox(0.07, height * 1.5, depth * 0.96, theme.frameDark, { roughness: 0.6 });
  group.add(at(back, -width / 2 + 0.04, height * 0.2, 0));
  for (const sz of [-1, 1]) {
    const prong = rbox(width * 0.92, height * 0.5, 0.09, color, { roughness: 0.45, metalness: 0.3 });
    prong.castShadow = false;
    group.add(at(prong, width * 0.04, 0, sz * (depth / 2 - 0.12)));
  }
  return group;
}

/** 托盘：底托 + 纸箱 + 封条。 */
function buildPallet(size: TwinVector3, color: string): THREE.Group {
  const theme = getActiveTheme();
  const group = new THREE.Group();
  group.userData.codePath = 'entityMeshes.ts:buildPallet';
  const [width, height, depth] = size;
  const baseH = height * 0.2;
  const cartonH = height * 0.72;
  const bottom = -height / 2;

  group.add(at(rbox(width, baseH, depth, theme.frameDark, { roughness: 0.75 }), 0, bottom + baseH / 2, 0));
  group.add(at(rbox(width * 0.86, cartonH, depth * 0.88, color, { roughness: 0.5, metalness: 0.04 }), 0, bottom + baseH + cartonH / 2, 0));
  const tape = rbox(width * 0.3, height * 0.06, depth * 0.9, theme.frame, { roughness: 0.7 });
  tape.castShadow = false;
  group.add(at(tape, 0, bottom + baseH + cartonH, 0));
  return group;
}

/** 顶升移栽机：滚筒银行 + 侧板（出口侧留开口）+ 四角顶升气缸 + 状态灯。 */
/**
 * 顶升移栽机的滚筒根数。滚筒与链带共用一套节距——链带必须正好落在
 * 两根滚筒之间的缝里，所以两个 build 函数都用下面这几个常量算 X。
 */
const TRANSFER_ROLLERS = 8;

const transferPitch = (width: number): number => (width - 0.32) / (TRANSFER_ROLLERS - 1);

/** 第 i 根滚筒中心的 X。 */
const transferRollerX = (width: number, i: number): number => -width / 2 + 0.16 + i * transferPitch(width);

/** 第 i 条链带中心的 X —— 正好在两根滚筒的缝正中。 */
const transferStrandX = (width: number, i: number): number => -width / 2 + 0.16 + (i + 0.5) * transferPitch(width);

/**
 * 顶升移栽机机身：平常就是一段**顺流向**的滚筒输送线，货直着滚过去；
 * 只有 declare 了 divertIds 的货来了，滚筒缝里的链带才顶起来，把它**垂直**
 * 送出去。所以这里不再铺皮带面——主线到机身处就是断开的。
 *
 * @param direction 主线流向：+1 沿 local +X。
 * @param divertSign 顶升后的出货方向：+1 沿 local +Z，-1 沿 local -Z。
 */
function buildTransfer(
  size: TwinVector3,
  color: string,
  baseY: number,
  direction = 1,
  divertSign = -1,
): THREE.Group {
  const theme = getActiveTheme();
  const group = new THREE.Group();
  group.userData.codePath = 'entityMeshes.ts:buildTransfer';
  const [width, , depth] = size;
  const groundY = -baseY;
  const deckHeight = 0.1;
  const deckCenterY = 0.25;
  const deckTop = deckCenterY + deckHeight / 2;
  const deckBottom = deckCenterY - deckHeight / 2;
  const rollerRadius = 0.05;
  const rollerCenterY = deckTop - rollerRadius;

  group.add(at(rbox(width * 0.98, 0.06, depth * 0.94, theme.frameDark, { roughness: 0.7 }), 0, groundY + 0.04, 0));

  const legTopY = deckBottom - 0.02;
  const legHeight = Math.max(0.08, legTopY - groundY);
  const legCenterY = (legTopY + groundY) / 2;
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      group.add(at(cyl(0.05, legHeight, theme.frameDark, 8, { roughness: 0.7 }), sx * (width / 2 - 0.2), legCenterY, sz * (depth / 2 - 0.15)));
    }
  }

  // 滚筒：沿流向（local X）排布，轴垂直于流向（local Z）。货物平常就压在这排
  // 滚筒上顺着滚过去；滚筒之间留出的缝，就是顶升链带的藏身处。
  const rollers: THREE.Mesh[] = [];
  for (let i = 0; i < TRANSFER_ROLLERS; i += 1) {
    const roller = cyl(rollerRadius, depth * 0.82, theme.roller, 10, { roughness: 0.35, metalness: 0.45 });
    roller.castShadow = false;
    roller.rotation.x = Math.PI / 2;
    roller.position.set(transferRollerX(width, i), rollerCenterY, 0);
    rollers.push(roller);
    group.add(roller);
  }

  // 侧板：出货侧开长口（货才出得去），对侧整块挡料。
  // 开口必须盖住整组链带的 X 跨度（约 1.1m），两端只留立柱。
  const openZ = -divertSign * (depth / 2 - 0.025);
  const solidZ = divertSign * (depth / 2 - 0.025);
  group.add(at(rbox(width * 0.96, 0.26, 0.05, theme.metal, { roughness: 0.5, metalness: 0.4 }), 0, deckCenterY, solidZ));
  for (const sx of [-1, 1]) {
    group.add(
      at(rbox(0.18, 0.26, 0.05, theme.metal, { roughness: 0.5, metalness: 0.4 }), sx * (width / 2 - 0.09), deckCenterY, openZ),
    );
  }

  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      group.add(at(cyl(0.045, 0.22, theme.frameDark, 10, { roughness: 0.5, metalness: 0.4 }), sx * (width / 2 - 0.18), deckCenterY + 0.08, sz * (depth / 2 - 0.16)));
      group.add(at(cyl(0.025, 0.3, theme.metal, 8, { roughness: 0.4, metalness: 0.5 }), sx * (width / 2 - 0.18), deckCenterY + 0.2, sz * (depth / 2 - 0.16)));
    }
  }

  group.add(at(rbox(0.22, 0.18, 0.2, theme.metal, { roughness: 0.45, metalness: 0.4 }), width / 2 - 0.04, rollerCenterY, 0));

  for (const sz of [-1, 1]) {
    group.add(at(rbox(0.08, 0.08, 0.08, '#FF5252', { emissive: '#FF5252', emissiveIntensity: 0.6 }), -width / 2 + 0.12, deckCenterY + 0.05, sz * (depth / 2 - 0.12)));
  }

  // 流向指示：挡料侧台面上两个小箭头，指的就是主线滚动方向 ——
  // 平常（不顶升）这台机器就等同于一段顺流向的滚筒输送线。
  const flowGeo = new THREE.ConeGeometry(0.06, 0.18, 4);
  const flowMat = new THREE.MeshStandardMaterial({ color: theme.accent, roughness: 0.45 });
  for (const sx of [-1, 1]) {
    const arrow = new THREE.Mesh(flowGeo, flowMat);
    arrow.rotation.z = direction > 0 ? -Math.PI / 2 : Math.PI / 2;
    arrow.position.set(sx * (width / 2 - 0.32), deckTop + 0.05, divertSign * (depth / 2 - 0.12));
    group.add(arrow);
  }

  const lamp = statusLamp(deckCenterY + 0.5, theme);
  group.add(lamp);

  group.userData.anim = {
    kind: 'transfer',
    rollers,
    rollerSign: direction,
    statusLight: lamp.material as THREE.MeshStandardMaterial,
  } as EntityAnim;
  return group;
}

/**
 * 托举座（cassette）：**坐在滚筒缝里**的那组顶升链带。
 *
 * 它和机身共用同一套节距，所以每条链带都正好卡在两根滚筒之间：
 * - idle —— 链带顶低于滚筒顶，整组缩在缝里，货压在滚筒上顺流向滚过去；
 * - 顶起 —— 整组链带抬 `liftHeight`，链带顶高过滚筒顶把货托离滚筒，
 *   链轮转起来把他沿 local ±Z **垂直**送出去，然后落回缝里。
 *
 * @param divertSign 出货方向：+1 沿 local +Z，-1 沿 local -Z。
 */
function buildCassette(size: TwinVector3, color: string, divertSign = -1): THREE.Group {
  const theme = getActiveTheme();
  const group = new THREE.Group();
  group.userData.codePath = 'entityMeshes.ts:buildCassette';
  const [width, , depth] = size;

  // 链带顶：比滚筒顶（0.30）低 3.5cm，是"缩在缝里"的那个状态。
  const chainTop = 0.265;
  const strandLen = depth * 0.86;
  const halfSpan = strandLen / 2;
  const strandW = 0.06;

  // 链带组的底板：把几条链带串成一套机构，整体压在滚筒缝下方。
  group.add(at(rbox(width * 0.84, 0.035, strandLen * 0.9, color, { roughness: 0.5 }), 0, chainTop - 0.085, 0));

  const sprockets: THREE.Mesh[] = [];
  const chainTeeth: { mesh: THREE.Mesh; halfSpan: number }[] = [];
  const toothGeo = new THREE.BoxGeometry(strandW * 0.9, 0.014, 0.035);
  const toothMat = new THREE.MeshStandardMaterial({ color: theme.frameDark, roughness: 0.5, metalness: 0.35 });

  // 链带只占中间几条缝（最外侧两条留空，免得蹭到侧板立柱）。
  for (let i = 1; i < TRANSFER_ROLLERS - 2; i += 1) {
    const x = transferStrandX(width, i);

    // 链带本体：沿 local Z 铺满台面，货从进到出全程有链托着。
    group.add(at(rbox(strandW, 0.055, strandLen, theme.frameDark, { roughness: 0.55, metalness: 0.3 }), x, chainTop - 0.0275, 0));

    // 两端链轮：轴沿 local X（rotation.z = 90°），转起来链带才跑。
    for (const sz of [-1, 1]) {
      const sprocket = cyl(0.045, strandW * 1.6, theme.metal, 12, { roughness: 0.4, metalness: 0.5 });
      sprocket.rotation.z = Math.PI / 2;
      sprocket.position.set(x, chainTop - 0.045, sz * halfSpan);
      sprockets.push(sprocket);
      group.add(sprocket);
    }

    // 链齿：沿 local Z 均布，动画里循环平移，一眼看出链条往哪跑。
    const toothCount = 5;
    for (let t = 0; t < toothCount; t += 1) {
      const tooth = new THREE.Mesh(toothGeo, toothMat);
      tooth.position.set(x, chainTop + 0.007, -halfSpan + ((t + 0.5) / toothCount) * strandLen);
      chainTeeth.push({ mesh: tooth, halfSpan });
      group.add(tooth);
    }
  }

  group.userData.anim = { kind: 'cassette', sprockets, chainTeeth, divertSign } as EntityAnim;
  return group;
}

/** 90° 转角输送模块：方形台面 + 弯道滚筒 + 低包边 + 支腿。 */
function buildCorner(size: TwinVector3, color: string, baseY: number): THREE.Group {
  const theme = getActiveTheme();
  const group = new THREE.Group();
  group.userData.codePath = 'entityMeshes.ts:buildCorner';
  const [width, , depth] = size;
  const groundY = -baseY;
  const deckHeight = 0.12;
  const deckCenterY = 0.25;
  const deckTop = deckCenterY + deckHeight / 2;
  const deckBottom = deckCenterY - deckHeight / 2;
  const rollerRadius = 0.05;
  const rollerCenterY = deckTop - rollerRadius;

  group.add(at(rbox(width * 0.98, deckHeight, depth * 0.98, color, { roughness: 0.5 }), 0, deckCenterY, 0));

  const rollers: THREE.Mesh[] = [];
  const r = width / 2;
  const cx = width / 2;
  const n = 5;
  for (let i = 0; i < n; i += 1) {
    const a = Math.PI + (i / (n - 1)) * (Math.PI / 2);
    const x = cx + r * Math.cos(a);
    const z = cx + r * Math.sin(a);
    const roller = cyl(rollerRadius, width * 0.5, theme.roller, 8, { roughness: 0.35, metalness: 0.45 });
    roller.castShadow = false;
    roller.rotation.x = Math.PI / 2;
    roller.position.set(x, rollerCenterY, z);
    rollers.push(roller);
    group.add(roller);
  }

  for (const side of [-1, 1]) {
    group.add(at(rbox(width * 0.98, 0.08, 0.05, theme.frameDark, { roughness: 0.55 }), 0, deckBottom + 0.04, side * (depth / 2 - 0.03)));
  }

  const legTopY = deckBottom - 0.02;
  const legHeight = Math.max(0.08, legTopY - groundY);
  const legCenterY = (legTopY + groundY) / 2;
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      group.add(at(cyl(0.05, legHeight, theme.frameDark, 8, { roughness: 0.7 }), sx * (width / 2 - 0.18), legCenterY, sz * (depth / 2 - 0.18)));
    }
  }

  const lamp = statusLamp(deckCenterY + 0.5, theme);
  group.add(lamp);

  group.userData.anim = { kind: 'transport', rollers, statusLight: lamp.material as THREE.MeshStandardMaterial } as EntityAnim;
  return group;
}

/** 按实体类型生成模型；未知类型退回货箱，保证外部数据源补出来的实体不会消失。 */
export function buildEntityMesh(entity: EntityMeshInput): THREE.Group {
  const size = entity.visual?.size ?? [0.7, 0.7, 0.7];
  const color = entity.visual?.color ?? '#94a3b8';
  const baseY = entity.transform.position[1] ?? 0;

  switch (entity.kind) {
    case 'transport': {
      // 箭头方向由场景模板用 `config.beltDirection` 声明（沿行进方向为 +1）。
      const raw = entity.config?.beltDirection;
      const direction = typeof raw === 'number' && raw < 0 ? -1 : 1;
      return buildConveyor(size[0], size[2], color, baseY, entity.id, direction);
    }
    case 'inspect':
      return buildInspection(size, color, baseY);
    case 'buffer':
      return buildRack(size, color, baseY);
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
    case 'transfer': {
      // 流向与出货方向都由场景模板声明：主线东行为 +1，往 +Z 出货为 +1。
      const rawDir = entity.config?.beltDirection;
      const rawSign = entity.config?.divertSign;
      return buildTransfer(
        size,
        color,
        baseY,
        typeof rawDir === 'number' && rawDir < 0 ? -1 : 1,
        typeof rawSign === 'number' && rawSign > 0 ? 1 : -1,
      );
    }
    case 'cassette': {
      const rawSign = entity.config?.divertSign;
      return buildCassette(size, color, typeof rawSign === 'number' && rawSign > 0 ? 1 : -1);
    }
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

/** 给非实例化兜底用的货物色（实例化走 CargoPool 的颜色轮转）。 */
export function fallbackCargoColor(id: string): string {
  return cargoColorFor(getActiveTheme(), id);
}
