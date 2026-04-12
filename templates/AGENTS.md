# Mind Keg -- Agent Instructions

You have persistent memory via Mind Keg. Follow these rules:

## Session Start

Call `get_context` with the current repository path to load prior knowledge.
If you know what task you're working on, include `task_description` for
task-scoped results.

## During Work

When you discover something non-obvious -- a gotcha, an architectural decision,
a debugging insight, a code review finding -- ask the user before storing:

> "I found that [X]. Want me to save this to Mind Keg?
> Should it apply to: this repo / this workspace / globally?"

Wait for the user's answer, then call `store` with the chosen scope and
appropriate type (learning, decision, finding, or gotcha).

## Session End

If you made significant discoveries during the session, summarize them and
offer to store any the user wants to keep.

If you completed a significant task (implementation, refactor, debugging
session), call `complete_run` with a summary.

## Rules

- Always ask before storing. Never store silently.
- Deprecate wrong knowledge instead of deleting it.
- Flag knowledge as stale when you suspect it's outdated but aren't sure.
- Use short, focused queries (1-3 keywords) when searching.
