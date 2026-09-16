from sqlalchemy.orm import Session

from app.models.agent_task import AgentTask


class TaskRepository:
    """异步任务仓储。"""

    def __init__(self, db: Session) -> None:
        self.db = db

    def save(self, task: AgentTask) -> AgentTask:
        """保存任务。"""

        self.db.add(task)
        self.db.flush()
        return task

    def get(self, task_id: str) -> AgentTask | None:
        """查询任务。"""

        return self.db.query(AgentTask).filter(AgentTask.id == task_id).first()

    def list_by_trip(self, trip_id: str, limit: int = 20) -> list[AgentTask]:
        """查询旅行关联任务。"""

        return (
            self.db.query(AgentTask)
            .filter(AgentTask.trip_id == trip_id)
            .order_by(AgentTask.created_at.desc())
            .limit(limit)
            .all()
        )

    def list_pending(self, limit: int = 5) -> list[AgentTask]:
        """查询待处理任务。"""

        return (
            self.db.query(AgentTask)
            .filter(AgentTask.status == "pending")
            .order_by(AgentTask.created_at.asc())
            .limit(limit)
            .all()
        )
