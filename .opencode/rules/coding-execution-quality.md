---
name: coding-execution-quality
description: Mandatory analysis, implementation, and verification procedure for all coding tasks
alwaysApply: true
---

# Coding Execution and Quality Gate Rules

This rule must be applied to all coding tasks without exception.

## Language Policy (Required)

Rule, skill, and agent documents must always be written in English.

## Analyze Mode (Required)

Before any implementation starts, follow this sequence:

1. Parallel context gathering
   - Launch 1-2 explore agents in parallel to inspect codebase patterns, structure, and implementation locations.
   - For tasks involving external libraries or references, launch 1-2 librarian agents in parallel.
   - In parallel, use direct tools: Grep, AST-grep, and LSP.
2. Specialist consultation by complexity
   - Use Oracle for conventional architecture, debugging, or complex logic problems.
   - Use Artistry for non-conventional problems that require creative approaches.
3. Synthesis before implementation
   - Summarize and compare collected findings, then choose an evidence-based implementation direction.

## Mandatory 19-Step Workflow

You must perform all 19 steps in order:

1. Create a plan.
2. Review the plan.
3. Review whether the review result is valid.
4. Review whether the plan is excessive.
5. Implement.
6. Review whether the implementation matches the objective.
7. Review for potential bugs, critical issues, and security problems.
8. Review whether the improvements introduced new issues.
9. Split very large functions/files into appropriate sizes.
10. Review and apply integration/reuse opportunities with existing code.
11. Confirm there are no side effects.
12. Review all changes again.
13. Clean up code that became unnecessary during implementation.
14. Review whether code quality is high enough.
15. Verify there are no issues in user flows.
16. Re-review related areas found during review to remove omissions.
17. Perform a final review for deployable quality.
18. Commit and create a PR.
19. Write a memory document so the current working approach can be reproduced in future restarts.

## Operating Principles

- Apply this procedure to every coding task without exception.
- Do not mark work complete after performing only a subset of steps.
- Issues found during review must be fixed immediately or explicitly documented.
