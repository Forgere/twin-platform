import { buildCenterScene } from './packages/plugins-logistics/src/index';

const scene = buildCenterScene({ parcels: 10, asrsParcels: 3, externalLanes: 4, aisles: 2 });
const ents = scene.entities;
console.log('TOTAL entities:', ents.length);

const rel = ents.filter((e) => /station|io-|asrs|cargo|pallet|stacker/i.test(e.id));
for (const e of rel) {
  const motion = e.motion
    ? 'motion pts=' + e.motion.points.length + ' loop=' + e.motion.loop + ' speed=' + e.motion.speed
    : 'no-motion';
  const tf = (e.transform && e.transform.position ? e.transform.position : [0, 0, 0]).map((n: number) => n.toFixed(2)).join(',');
  console.log(e.kind.padEnd(10) + ' ' + e.id.padEnd(34) + ' tf=[' + tf + '] ' + motion);
}
