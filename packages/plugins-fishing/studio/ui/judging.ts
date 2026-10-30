import { DecisionLog, type DecisionDomain, type DecisionState, type SerializedDecisionLog } from '@twin-platform/decision-core';
import { createJevJudge, createProxyJevClient } from '@twin-platform/plugins-fishing';
import type { StudioSessionPort } from '@twin-platform/studio-sdk';

/**
 * 判断者装配（规则 / Jev）与决策日志存取——决策面板与钓鱼助手共用。
 *
 * 两处必须是同一份：助手里"问判断者"产生的记录要进决策面板的校准表，
 * 不然助手用得再多，校准表也永远攒不够样本。
 */

export type JudgeMode = 'rule' | 'jev';

export interface JevStatus {
  readonly configured: boolean;
  readonly model?: string;
}

const STORAGE_KEY = 'twin.decision-log.v1';

// 插件只声明同源路径，地址与鉴权由宿主的请求端口负责。
const requestFor = (session: StudioSessionPort) => session.request ?? ((path: string, init?: RequestInit) => fetch(path, init));

export function loadDecisionLog(): DecisionLog {
  if (typeof localStorage === 'undefined') return new DecisionLog('ui');
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return new DecisionLog('ui');
    return DecisionLog.fromJSON(JSON.parse(raw) as SerializedDecisionLog);
  } catch {
    return new DecisionLog('ui');
  }
}

export function saveDecisionLog(log: DecisionLog): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(log.toJSON()));
  } catch {
    // 配额满或隐私模式：存不下就只留内存，不影响判断。
  }
}

/** 问一次服务端 Jev 是否配置；离线 / 纯静态部署一律当"未配置"。 */
export async function fetchJevStatus(session: StudioSessionPort): Promise<JevStatus> {
  try {
    const response = await requestFor(session)('/api/jev/status');
    return (await response.json()) as JevStatus;
  } catch {
    return { configured: false };
  }
}

/** 按模式装配决策域：规则用插件自带的，Jev 只换 judge，其余（Policy / 降级）不变。 */
export function judgeDomain(session: StudioSessionPort, mode: JudgeMode): DecisionDomain<DecisionState> | undefined {
  const base = session.host.decisions[0];
  if (!base) return undefined;
  if (mode === 'rule') return base;
  return { ...base, judge: createJevJudge(createProxyJevClient({ fetchImpl: requestFor(session) })) };
}
