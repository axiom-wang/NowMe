-- 点数（contracts 12）：没有自己模型 Key 的用户用平台的 AI 生成 / 修改页面时扣点数。
-- 两类账户：个人（user）与墙的额度（wall，组织者从自己的余额转入，给这面墙的成员用）。
--
-- credit_balances 是当前余额（不能为负）；credit_entries 是只追加的流水，每一笔都记下变动后的余额，
-- 两张表总是在同一个事务里一起写。流水不可修改、不可删除（下面的触发器），对账以流水为准。

CREATE TABLE credit_balances (
  account_kind  TEXT NOT NULL CHECK (account_kind IN ('user', 'wall')),
  account_id    TEXT NOT NULL,
  balance       INTEGER NOT NULL DEFAULT 0 CHECK (balance >= 0),
  updated_at    TEXT NOT NULL,
  PRIMARY KEY (account_kind, account_id)
);

CREATE TABLE credit_entries (
  id             TEXT PRIMARY KEY CHECK (id GLOB 'cre_*'),
  account_kind   TEXT NOT NULL CHECK (account_kind IN ('user', 'wall')),
  account_id     TEXT NOT NULL,
  delta          INTEGER NOT NULL CHECK (delta <> 0),
  balance_after  INTEGER NOT NULL CHECK (balance_after >= 0),
  -- redeem 兑换码；grant 运营发放；signup 注册赠送；adjust 运营调整；
  -- sponsor_out / sponsor_in 组织者把个人点数转给墙；sponsor_return 墙关闭时退回组织者；
  -- job 生成 / 修改任务扣点；job_refund 任务没成功时退回
  reason         TEXT NOT NULL CHECK (reason IN ('redeem', 'grant', 'signup', 'adjust', 'sponsor_out', 'sponsor_in', 'sponsor_return', 'job', 'job_refund')),
  -- 关联对象：任务 ID、兑换码 ID、墙 ID（按 reason 而定）
  ref_id         TEXT,
  -- 谁触发的：用墙的额度时是那位成员；运营发放时为空
  actor_id       TEXT,
  created_at     TEXT NOT NULL
);
CREATE INDEX credit_entries_account ON credit_entries (account_kind, account_id, created_at);
-- 同一个任务只扣一次、只退一次；同一个兑换码只入账一次；注册赠送每人一次
CREATE UNIQUE INDEX credit_entries_once ON credit_entries (reason, ref_id) WHERE reason IN ('job', 'job_refund', 'redeem');
CREATE UNIQUE INDEX credit_entries_signup ON credit_entries (account_id) WHERE reason = 'signup';
-- 某位成员用了这面墙多少额度
CREATE INDEX credit_entries_wall_actor ON credit_entries (account_id, actor_id) WHERE account_kind = 'wall';

CREATE TRIGGER credit_entries_no_update BEFORE UPDATE ON credit_entries
BEGIN
  SELECT RAISE(ABORT, 'credit_entries 只追加，不能修改');
END;
CREATE TRIGGER credit_entries_no_delete BEFORE DELETE ON credit_entries
BEGIN
  SELECT RAISE(ABORT, 'credit_entries 只追加，不能删除');
END;

-- 兑换码：明文只在生成时输出一次，库里只有哈希。用过即作废。
CREATE TABLE redeem_codes (
  id           TEXT PRIMARY KEY CHECK (id GLOB 'rdc_*'),
  code_hash    TEXT NOT NULL UNIQUE,
  credits      INTEGER NOT NULL CHECK (credits BETWEEN 1 AND 100000),
  -- 批次备注（运营自己看，例如 “2026-12 招新”）
  batch        TEXT,
  expires_at   TEXT,
  redeemed_by  TEXT REFERENCES users (id),
  redeemed_at  TEXT,
  created_at   TEXT NOT NULL,
  CHECK ((redeemed_by IS NULL) = (redeemed_at IS NULL))
);

-- 墙的额度设置：每位成员最多能用这面墙多少点（0 表示不限，只受墙的余额限制）。
CREATE TABLE wall_sponsorships (
  wall_id     TEXT PRIMARY KEY REFERENCES walls (id),
  member_cap  INTEGER NOT NULL DEFAULT 0 CHECK (member_cap BETWEEN 0 AND 10000),
  updated_at  TEXT NOT NULL
);
