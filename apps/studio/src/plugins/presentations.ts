import { selectPresentation } from '@twin-platform/studio-sdk';
import { fishingPresentation } from '@twin-platform/plugins-fishing/studio';
import type { StudioSession } from '../scene/studioSession';

/** 唯一浏览器插件装配入口；纯会话目录不加载 TSX、CSS 或 Three。 */
const PRESENTATIONS = [fishingPresentation];

export function presentationFor(session: StudioSession) {
  return selectPresentation(session.host, session.world.scene, PRESENTATIONS);
}
