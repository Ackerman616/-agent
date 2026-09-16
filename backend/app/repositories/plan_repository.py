from sqlalchemy.orm import Session, selectinload

from app.models.plan import TravelPlan


class PlanRepository:
    """方案仓储。"""

    def __init__(self, db: Session) -> None:
        self.db = db

    def save(self, plan: TravelPlan) -> TravelPlan:
        """保存方案。"""

        self.db.add(plan)
        self.db.flush()
        return plan

    def get(self, plan_id: str) -> TravelPlan | None:
        """查询方案。"""

        return (
            self.db.query(TravelPlan)
            .options(selectinload(TravelPlan.votes))
            .filter(TravelPlan.id == plan_id)
            .first()
        )
