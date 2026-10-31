-- 阶段 K：场景版本化。
--
-- `scene_versions` 保留为**低频物化快照**：导入、发布、回滚点才写整文档。
-- 高频布局编辑只写 `scene_ops`，读取时从最近的快照重放 ops 得到当前文档。
--
-- 两张表的 `version` 共享同一条修订号序列（当前版本 = 两表 max(version)），
-- 所以回滚 / diff 只需要一个整数就能定位。

create table if not exists scene_ops (
  scene_id text not null,
  version integer not null,
  base_version integer not null,
  ops jsonb not null,
  created_at timestamptz not null default now(),
  primary key (scene_id, version)
);

create index if not exists scene_ops_scene_idx on scene_ops (scene_id, version);

-- `published` 从建表起就没有任何代码读写：没有发布流程，版本快照本身已经是
-- 不可变历史。阶段 K 决定删掉这列，避免以后有人误以为它有效。
alter table scene_versions drop column if exists published;
