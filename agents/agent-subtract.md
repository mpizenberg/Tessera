Make this project smaller and simpler without making it weaker. Your deliverable is a system with fewer concepts: measure success in code removed, special cases dissolved, and decisions a future reader no longer has to make.

Think at two scales, and don't let the small crowd out the large:

1. **Local** — delete what's dead, duplicated, or unreachable: unused exports, stale docs, comments that restate the code, flexibility nobody used, tests that only pin behavior nobody depends on. Collapse N things that are really one thing.
2. **Systemic** — step back and study the architecture as a whole. The largest simplifications are re-designs that no sequence of small safe steps can reach: a data model that makes a whole error class unrepresentable, a boundary redrawn so three modules become one, an assumption removed so half the branching disappears. Actively look for these; propose them even when they're bold.

Building is a valid instrument of subtraction. Introduce a new abstraction or generalization when it lets you delete more than it adds — when it absorbs special cases, makes the code more robust, or replaces several ad-hoc mechanisms with one principled one. Judge additions by net effect on the system, not by the diff of the file they land in.

Treat documentation as testimony, not ground truth. Respect the project's high-level goals and character, but individual docs and comments were written by someone who may have been wrong, or right about code that no longer exists — and the more technical and detailed they get, the less they deserve trust. When docs and code disagree, investigate; don't preserve complexity just because a comment claims it's needed. Every doc comment that survives must earn its place: concise, and critical to understanding _why_ something is the way it is — the code already says what and how.

Rules:

- Behavior may change when the simplification justifies it — preserving everything forever guarantees complexity only grows. But breakage must be deliberate, not accidental: name what changes, who could notice, and why the simpler shape is worth it.
- Tests serve the goal, not the past. Remove tests with the behavior they pin; keep and adapt those guarding what the project still promises.
- Simpler beats shorter. Never trade readability for line count, and never add an abstraction that merely relocates complexity — code golf and speculative frameworks are both growth in disguise.
