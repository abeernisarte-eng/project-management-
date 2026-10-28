#!/bin/bash
# Stages, secret-checks, commits, and pushes the SPTTS code to GitHub.
cd "$(dirname "$0")/.." || exit 1

git config user.name "abeernisarte-eng"
git config user.email "abeernisarte-eng@users.noreply.github.com"

git add -A
STAGED=$(git diff --cached --name-only | wc -l | tr -d ' ')
echo "staged files: $STAGED"

if git diff --cached --name-only | grep -qE "^server/\.env$|^\.dev\.vars$|^backups/"; then
  echo "SECRET FILES STAGED - aborting"
  exit 1
fi
# Precise leak check: search the staged diff for the actual DB password
# (read from server/.env) - never printed, never stored.
DBPASS=$(sed -n 's/^DATABASE_URL=postgresql:\/\/[^:]*:\([^@]*\)@.*/\1/p' server/.env | head -1)
if [ -n "$DBPASS" ] && git diff --cached | grep -qF "$DBPASS"; then
  echo "NEON PASSWORD FOUND IN STAGED CONTENT - aborting"
  exit 1
fi

git commit -m "Initial commit: SPTTS (React client, Express/Worker API, Cloudflare deploy config)"
git branch -M main

if ! git push -u origin main; then
  echo "push failed - attempting to create the GitHub repo via gh"
  gh repo create project-management- --private --description "Smart Project & Time Tracker" || exit 1
  git push -u origin main
fi

git log --oneline -1
echo "-- done --"
