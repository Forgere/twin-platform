-- Twin Platform 初始 schema（PostgreSQL 18）
--
-- 设计要点：
-- 1. 场景是版本化的不可变行（`scene_versions`），回放会话锁定具体版本，
--    场景改了旧会话依然按老版本重放；
-- 2. `twin_events` 是不可变事实流，只 INSERT，不 UPDATE；
-- 3. `entity_state_latest` 只是事件流的物化投影，随时可以从事件重建，永远不是真相；
-- 4. 分区键用 `received_at`（挂钟）而不是 `occurred_at`（仿真时间）：仿真时间每个会话
--    都从 0 开始，按它分区会让所有会话的早期事件挤进同一个分区，失去分区意义。
--    仿真时间维度的查询走 `(scene_id, entity_id, occurred_at)` 索引。

-- ---------------------------------------------------------------------------
-- 项目与场景
-- ---------------------------------------------------------------------------

create table if not exists projects (
  id text primary key,
  name text not null,
  created_at timestamptz not null default now()
);

create table if not exists scene_versions (
  scene_id text not null,
  version integer not null,
  name text not null,
  schema_version integer not null,
  payload jsonb not null,
  published boolean not null default false,
  created_at timestamptz not null default now(),
  primary key (scene_id, version)
);

create index if not exists scene_versions_scene_idx on scene_versions (scene_id, version desc);

create table if not exists plugin_installations (
  scene_id text not null,
  plugin_id text not null,
  version text not null,
  config jsonb not null default '{}'::jsonb,
  enabled boolean not null default true,
  primary key (scene_id, plugin_id)
);

-- ---------------------------------------------------------------------------
-- 回放会话与快照
-- ---------------------------------------------------------------------------

create table if not exists replay_sessions (
  id text primary key,
  scene_id text not null,
  scene_version integer not null,
  seed bigint not null,
  step double precision not null,
  mode text not null,
  label text,
  created_at timestamptz not null,
  duration double precision,
  plugin_locks jsonb not null default '{}'::jsonb
);

create index if not exists replay_sessions_scene_idx on replay_sessions (scene_id, created_at);

create table if not exists world_snapshots (
  scene_id text not null,
  sequence bigint not null,
  time double precision not null,
  step double precision not null,
  seed bigint not null,
  rng_state bigint not null,
  mode text not null,
  entities jsonb not null,
  received_at timestamptz not null default now(),
  primary key (scene_id, sequence)
);

create index if not exists world_snapshots_time_idx on world_snapshots (scene_id, time desc);

-- ---------------------------------------------------------------------------
-- 事件流（按写库时间分区）
-- ---------------------------------------------------------------------------

create table if not exists twin_events (
  scene_id text not null,
  sequence bigint not null,
  occurred_at double precision not null,
  type text not null,
  entity_id text,
  detail text,
  payload jsonb not null default '{}'::jsonb,
  received_at timestamptz not null default now(),
  project_id text
) partition by range (received_at);

-- 默认分区：分区没提前建好时写入不该失败。
create table if not exists twin_events_default partition of twin_events default;

create index if not exists twin_events_scene_entity_idx on twin_events (scene_id, entity_id, occurred_at);
create index if not exists twin_events_scene_type_idx on twin_events (scene_id, type, occurred_at);

-- 预建未来若干个月的分区；定时任务每月跑一次即可。
create or replace function twin_ensure_event_partitions(months_ahead integer default 2)
returns void
language plpgsql as $$
declare
  month_start date := date_trunc('month', now())::date;
  part_start date;
  part_end date;
  part_name text;
  i integer;
begin
  for i in 0..months_ahead loop
    part_start := (month_start + (i || ' month')::interval)::date;
    part_end := (month_start + ((i + 1) || ' month')::interval)::date;
    part_name := format('twin_events_%s', to_char(part_start, 'YYYY_MM'));
    if not exists (select 1 from pg_class where relname = part_name) then
      execute format(
        'create table %I partition of twin_events for values from (%L) to (%L)',
        part_name, part_start, part_end
      );
    end if;
  end loop;
end;
$$;

select twin_ensure_event_partitions();

-- ---------------------------------------------------------------------------
-- 投影与聚合
-- ---------------------------------------------------------------------------

create table if not exists entity_state_latest (
  scene_id text not null,
  entity_id text not null,
  kind text not null,
  status text,
  attrs jsonb not null default '{}'::jsonb,
  transform jsonb not null,
  data_source text not null,
  updated_sequence bigint not null,
  updated_at double precision not null,
  updated_wall_at timestamptz not null default now(),
  primary key (scene_id, entity_id)
);

create table if not exists metric_rollups (
  scene_id text not null,
  metric text not null,
  entity_id text not null default '',
  bucket_start double precision not null,
  bucket_size double precision not null,
  value double precision not null,
  count bigint not null,
  updated_at timestamptz not null default now(),
  primary key (scene_id, metric, entity_id, bucket_start, bucket_size)
);

create table if not exists assets (
  id text primary key,
  kind text not null,
  uri text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
