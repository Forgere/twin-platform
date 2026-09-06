import type { TwinEntity, TwinScene } from '@twin-platform/scene-schema';

export interface WorldEvent {
  sequence: number;
  occurredAt: number;
  type: string;
  entityId?: string;
  payload?: Record<string, unknown>;
}

export interface WorldSnapshot {
  sequence: number;
  time: number;
  entities: TwinEntity[];
}

export class TwinWorld {
  private readonly entities = new Map<string, TwinEntity>();
  private readonly events: WorldEvent[] = [];
  private time = 0;

  constructor(scene: TwinScene) {
    for (const entity of scene.entities) this.entities.set(entity.id, structuredClone(entity));
  }

  dispatch(type: string, options: Omit<WorldEvent, 'sequence' | 'occurredAt' | 'type'> = {}): WorldEvent {
    const event: WorldEvent = { sequence: this.events.length + 1, occurredAt: this.time, type, ...options };
    this.events.push(event);
    return event;
  }

  advance(deltaSeconds: number): void {
    if (!Number.isFinite(deltaSeconds) || deltaSeconds < 0) throw new Error('deltaSeconds 必须是非负有限数字。');
    this.time += deltaSeconds;
  }

  snapshot(): WorldSnapshot {
    return { sequence: this.events.length, time: this.time, entities: [...this.entities.values()].map((entity) => structuredClone(entity)) };
  }

  getEventLog(): readonly WorldEvent[] { return this.events; }
}
