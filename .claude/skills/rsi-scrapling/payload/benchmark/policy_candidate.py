"""Refine the strongest observed branch after first comparing the roots.

Only revealed observations affect choices; no access to unrevealed scores.
"""
from dream_rsi.policy.api import LLMDesignedMethod, SimResult, finalize_result

class OptimalPolicy(LLMDesignedMethod):
    NAME = 'observed_best_first'

    def solve(self, question, budget=None):
        question.reset()
        result = SimResult()
        while not question.done and (budget is None or question.budget_spent < budget):
            legal = question.legal_actions()
            if not legal:
                break
            roots = [a for a in legal if question.meta(a).attempt == 0]
            if roots:
                action = min(roots, key=lambda a: question.meta(a).branch)
            else:
                observed = question.observed()
                def priority(a):
                    meta = question.meta(a)
                    parent = observed.get(meta.parent_id)
                    return (-(parent.score if parent else 0), meta.attempt, meta.branch)
                action = min(legal, key=priority)
            question.probe(action)
            result.curve.append((question.budget_spent, question.best_so_far))
        return finalize_result(question, result)
