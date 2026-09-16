from fastapi import status
from sqlalchemy.orm import Session

from app.common.errors import ErrorCode
from app.common.exceptions import AppException
from app.common.utils import new_id
from app.models.plan import TravelPlan
from app.models.vote import PlanVote
from app.repositories.plan_repository import PlanRepository
from app.repositories.vote_repository import VoteRepository


class VoteService:
    """投票服务。"""

    def __init__(self, db: Session) -> None:
        self.db = db
        self.plan_repo = PlanRepository(db)
        self.vote_repo = VoteRepository(db)

    def submit_vote(
        self,
        plan_id: str,
        member_id: str,
        candidate_ids: list[str],
    ) -> dict:
        """提交或更新投票。"""

        plan = self._get_plan(plan_id)
        member_ids = {member.id for member in plan.trip.members}
        if member_id not in member_ids:
            raise AppException(ErrorCode.E1014, http_status=status.HTTP_400_BAD_REQUEST)
        if not 1 <= len(set(candidate_ids)) <= 2:
            raise AppException(ErrorCode.E1012, http_status=status.HTTP_400_BAD_REQUEST)
        valid_ids = {candidate["id"] for candidate in plan.candidates}
        if any(candidate_id not in valid_ids for candidate_id in candidate_ids):
            raise AppException(ErrorCode.E1013, http_status=status.HTTP_404_NOT_FOUND)

        vote = self.vote_repo.get_by_plan_member(plan_id, member_id)
        if vote:
            vote.candidate_ids = list(dict.fromkeys(candidate_ids))
        else:
            vote = PlanVote(
                id=new_id(),
                plan_id=plan_id,
                member_id=member_id,
                candidate_ids=list(dict.fromkeys(candidate_ids)),
            )
            self.vote_repo.save(vote)
        self.db.commit()
        return self.snapshot(plan_id)

    def snapshot(self, plan_id: str) -> dict:
        """获取投票快照。"""

        plan = self._get_plan(plan_id)
        member_by_id = {member.id: member.name for member in plan.trip.members}
        votes = {
            member_by_id[vote.member_id]: vote.candidate_ids
            for vote in self.vote_repo.list_by_plan(plan_id)
        }
        tallies = {candidate["id"]: 0 for candidate in plan.candidates}
        for candidate_ids in votes.values():
            for candidate_id in candidate_ids:
                if candidate_id in tallies:
                    tallies[candidate_id] += 1

        ranked = sorted(
            [self._rank_item(candidate, tallies[candidate["id"]], votes) for candidate in plan.candidates],
            key=lambda item: (
                item["votes"],
                item["fairness_floor"],
                item["average_satisfaction"],
            ),
            reverse=True,
        )
        winner = ranked[0] if ranked and ranked[0]["votes"] > 0 else None
        all_members_voted = len(votes) == len(plan.trip.members)
        return {
            "votes": votes,
            "tallies": tallies,
            "ranked": ranked,
            "winner": winner,
            "ready_for_replan": bool(winner and winner["confirmation_complete"] and all_members_voted),
            "participation_count": len(votes),
            "member_count": len(plan.trip.members),
        }

    def _rank_item(self, candidate: dict, votes: int, all_votes: dict) -> dict:
        """构造排序项。"""

        scores = candidate.get("assessment", {}).get("member_scores", [])
        values = [item.get("preference_score", 0) for item in scores]
        required = candidate.get("required_confirmations", [])
        confirmed_by = [name for name in required if candidate["id"] in all_votes.get(name, [])]
        average = int(sum(values) / len(values)) if values else 0
        return {
            "candidate_id": candidate["id"],
            "title": candidate["title"],
            "negotiation_label": candidate.get("negotiation_label"),
            "votes": votes,
            "fairness_floor": min(values) if values else 0,
            "average_satisfaction": average,
            "required_confirmations": required,
            "confirmed_by": confirmed_by,
            "confirmation_complete": len(required) == len(confirmed_by),
        }

    def _get_plan(self, plan_id: str) -> TravelPlan:
        """获取方案并校验存在。"""

        plan = self.plan_repo.get(plan_id)
        if not plan:
            raise AppException(ErrorCode.E1005, http_status=status.HTTP_404_NOT_FOUND)
        return plan
