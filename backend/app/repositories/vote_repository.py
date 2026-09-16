from sqlalchemy.orm import Session

from app.models.vote import PlanVote


class VoteRepository:
    """投票仓储。"""

    def __init__(self, db: Session) -> None:
        self.db = db

    def get_by_plan_member(self, plan_id: str, member_id: str) -> PlanVote | None:
        """查询成员对某方案的投票。"""

        return (
            self.db.query(PlanVote)
            .filter(PlanVote.plan_id == plan_id, PlanVote.member_id == member_id)
            .first()
        )

    def list_by_plan(self, plan_id: str) -> list[PlanVote]:
        """查询方案全部投票。"""

        return self.db.query(PlanVote).filter(PlanVote.plan_id == plan_id).all()

    def save(self, vote: PlanVote) -> PlanVote:
        """保存投票。"""

        self.db.add(vote)
        self.db.flush()
        return vote
