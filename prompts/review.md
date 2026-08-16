---
description: Code review changes vs main branch. Finds bugs, missing tests, errors, security issues.
argument-hint: "[files...]"
---

Review git changes vs main/master branch.

1. Find base branch and show overview:

   ```bash
   git fetch origin main master 2>/dev/null
   for b in main master; do git rev-parse --verify origin/$b 2>/dev/null && { echo "$b"; break; }; done 2>/dev/null || echo "main"
   git branch --show-current
   git diff main...HEAD --stat 2>/dev/null || git diff master...HEAD --stat
   ```

2. Show full diff:

   ```bash
   git diff main...HEAD 2>/dev/null || git diff master...HEAD
   ```

3. Review for: bugs, security, error handling, missing tests, code quality, type safety, performance, breaking changes, and new patterns where there are existing that can be used. Focus on those you know are relevant. No guessing.

   Format:

   ```
   ## Review: <branch> → main/master
   ```
