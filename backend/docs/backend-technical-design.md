# 多人共识旅行 Agent 后端技术文档

## 1. 目标

后端从原 Node.js 原型拆分为可独立部署的 Python 服务，负责：

- 创建多人旅行；
- 保存成员硬约束与软偏好；
- 生成三种协商候选方案；
- 存储旅行方案到 MySQL；
- 支持成员单选或双选认可投票；
- 根据胜出方向收敛最终方案；
- 提供统一错误码；
- 预留 log 与 trace 入库框架。

北京三人旅行案例仅作为回归测试样本，不写入业务逻辑。

## 2. 技术栈

| 层级 | 技术 |
|---|---|
| Web 框架 | FastAPI |
| 语言 | Python 3.11+ |
| ORM | SQLAlchemy 2.x |
| 数据库 | MySQL 5.7+ |
| MySQL 驱动 | PyMySQL |
| 配置 | pydantic-settings + `.env` |
| API 风格 | REST + JSON |

## 3. 目录结构

```text
backend/
  app/
    api/v1/endpoints/      # 路由层
    common/                # 通用能力：错误、响应、数据库、日志、工具
    core/                  # 配置
    models/                # SQLAlchemy 模型
    repositories/          # 数据访问层
    schemas/               # Pydantic 入参与出参
    services/              # 业务服务与 Agent 编排
    main.py                # FastAPI 入口
  scripts/schema.sql       # MySQL 建表脚本
  requirements.txt
  .env.example
```

## 4. 模块职责

### API 层

只负责：

- 解析请求；
- 调用 Service；
- 返回统一响应。

不直接写 SQL，不直接拼业务逻辑。

### Service 层

负责业务编排：

- `TripService`：创建旅行、查询旅行；
- `AgentService`：生成候选方案、根据胜出方向收敛最终方案；
- `VoteService`：提交投票、统计票数、判断是否可以重规划。

### Repository 层

只封装数据库查询和保存，降低 ORM 与业务逻辑耦合。

### Common 层

通用能力放在 `app/common/`：

- `database.py`：数据库引擎和会话；
- `errors.py`：全局错误码；
- `exceptions.py`：业务异常；
- `response.py`：统一响应；
- `middleware.py`：请求 ID 和耗时；
- `logger.py`：log / trace 入库预留框架；
- `utils.py`：ID、时间、数值工具。

## 5. API 设计

### 健康检查

```http
GET /api/v1/health
```

### 创建旅行

```http
POST /api/v1/trips
```

保存共同旅行边界和 2～8 位成员约束。

### 查询旅行

```http
GET /api/v1/trips/{trip_id}
GET /api/v1/trips?limit=20
```

### 同步生成候选方案

```http
POST /api/v1/trips/{trip_id}/plans
```

同步调用腾讯地图和 LLM，输出三种协商方向：

1. 分组支线；
2. 降低部分必去等级；
3. 放宽最严格瓶颈约束。

候选方案会写入 `travel_plans.candidates`。

### 异步生成候选方案

```http
POST /api/v1/trips/{trip_id}/plan-tasks
GET /api/v1/tasks/{task_id}
```

第一步创建任务并立即返回 `task_id`。任务由独立 `worker.py` 进程执行，API 服务不再承担耗时 Agent 工作。
第二步轮询任务状态，成功后 `result` 字段中包含方案数据。

### 查询方案

```http
GET /api/v1/plans/{plan_id}
```

### 提交投票

```http
POST /api/v1/plans/{plan_id}/votes
```

请求示例：

```json
{
  "member_id": "成员ID",
  "candidate_ids": ["plan-a", "plan-b"]
}
```

每个成员必须选择 1～2 个方案。

### 查询投票快照

```http
GET /api/v1/plans/{plan_id}/votes
```

返回：

- 每个成员的投票；
- 每个候选方案票数；
- 当前排序；
- 胜出方向；
- 是否满足进入最终重规划的条件。

### 收敛最终方案

```http
POST /api/v1/plans/{plan_id}/resolve
```

只有全员已投票，且胜出方向所需确认成员都已确认时才允许执行。

## 6. 数据库设计

核心表：

- `trips`：旅行主表；
- `trip_members`：成员约束与偏好；
- `travel_plans`：候选方案和最终方案；
- `plan_votes`：成员投票；
- `agent_tasks`：数据库驱动异步任务队列。

P2 预留表：

- `app_logs`：业务日志；
- `trace_logs`：链路追踪。

建表脚本：

```text
backend/scripts/schema.sql
```

## 7. 错误码规范

错误码格式为 `Exxxx`，不允许重复。

| 错误码 | 含义 |
|---|---|
| E1001 | 请求参数校验失败 |
| E1002 | 请求体格式错误 |
| E1003 | 资源不存在 |
| E1004 | 旅行不存在 |
| E1005 | 方案不存在 |
| E1006 | 成员不存在 |
| E1007 | 成员称呼不能重复 |
| E1008 | 同行成员数量必须为 2 至 8 人 |
| E1009 | 成员可参与时间窗口不合法 |
| E1010 | 数据库操作失败 |
| E1011 | 方案尚未满足投票或收敛条件 |
| E1012 | 每位成员必须选择 1 至 2 个候选方案 |
| E1013 | 候选方案不存在 |
| E1014 | 投票成员不在本次旅行中 |
| E1015 | 胜出协商方向尚未完成必要成员确认 |
| E1016 | Agent 生成失败 |
| E1017 | 外部服务调用失败 |
| E1018 | 日志写入失败 |
| E1019 | 方案严格校验未通过 |
| E1020 | 请求方法或路径不支持 |
| E1021 | 异步任务不存在 |
| E1022 | 异步任务状态不允许操作 |

## 8. 日志与 Trace 设计

当前已创建：

- `app_logs`；
- `trace_logs`；
- `app/common/logger.py`。

P2 接入计划：

1. 在中间件记录请求开始和结束；
2. 业务异常写入 `app_logs`；
3. Agent 每个阶段写入 `trace_logs`；
4. 后续改为异步队列写入，避免阻塞接口；
5. 日志中只保存脱敏后的上下文，不写 API Key。

## 9. 独立部署

### 安装依赖

```powershell
cd backend
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
```

### 初始化数据库

```powershell
mysql -h 127.0.0.1 -uroot -p < scripts/schema.sql
```

### 配置环境变量

```powershell
copy .env.example .env
```

填写 MySQL 连接信息。

### 启动服务

```powershell
uvicorn app.main:app --host 0.0.0.0 --port 8000
```

访问：

```text
http://127.0.0.1:8000/docs
```

## 10. 前端接入方案

当前前端已从原 Node NDJSON 接口改为调用独立 FastAPI 后端：

- `public/api.js`：统一封装 `GET` / `POST`、`API_BASE` 和错误处理；
- `public/app.js`：只负责页面状态、表单读取、任务轮询、方案展示和投票；
- 页面可配置 `API Base`，默认 `http://127.0.0.1:8000/api/v1`；
- 生成方案走异步任务接口，避免浏览器长时间阻塞；
- 投票和最终收敛均调用 FastAPI 的 REST 接口。

前端调用顺序：

```text
POST /trips
POST /trips/{trip_id}/plan-tasks
GET  /tasks/{task_id} 轮询
GET  /plans/{plan_id}
POST /plans/{plan_id}/votes
GET  /plans/{plan_id}/votes
POST /plans/{plan_id}/resolve
```

## 11. 后续扩展

当前后端已经具备核心业务闭环、数据库持久化、真实 LLM、腾讯地图和独立 Worker。

已接入能力：

- `app/common/llm_client.py`：OpenAI 兼容 LLM 通用客户端；
- `app/common/tencent_map_client.py`：腾讯地图 POI 与路线通用客户端；
- `agent_tasks`：数据库驱动任务队列表；
- `worker.py`：独立 Worker 进程，轮询 `agent_tasks` 并执行 Agent；
- `POST /api/v1/trips/{trip_id}/plan-tasks`：只创建任务，不在 API 进程中执行；
- `GET /api/v1/tasks/{task_id}`：查询任务状态；
- `AgentService`：先调用腾讯地图搜索 POI，再调用 LLM 输出三种候选，随后继续调用
  腾讯地图路线接口补充相邻节点路线证据。

独立 Worker 启动方式：

```powershell
cd backend
python worker.py --interval 2 --batch-size 3
```

只执行一轮用于调试：

```powershell
python worker.py --once
```

下一步计划：

1. 为 Worker 增加任务抢占锁和多实例并发安全；
2. 为 LLM 与腾讯地图调用增加重试、限流、缓存和成本统计；
3. 将 Agent 每个阶段写入 `trace_logs`，业务异常写入 `app_logs`；
4. 增加用户体系、成员邀请链接和权限校验；
5. 接入 Alembic 管理迁移版本；
6. 增加端到端测试：创建旅行、异步生成、投票、最终收敛；
7. 后续如需更强并发，可将 MySQL 轮询 Worker 替换为 Celery / RQ / Dramatiq。
