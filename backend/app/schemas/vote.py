from pydantic import BaseModel, Field


class VoteCreate(BaseModel):
    """提交认可投票。"""

    member_id: str
    candidate_ids: list[str] = Field(..., min_length=1, max_length=2)


class VoteSnapshot(BaseModel):
    """投票快照。"""

    votes: dict[str, list[str]]
    tallies: dict[str, int]
    ranked: list[dict]
    winner: dict | None = None
    ready_for_replan: bool
    participation_count: int
    member_count: int
