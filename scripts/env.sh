# Loads either local or production env vars into the CURRENT shell.
# Must be SOURCED, not executed -- `source scripts/env.sh production` (or
# `. scripts/env.sh local`) from anywhere inside the repo, never
# `./scripts/env.sh production`, or the exported variables die with the
# subshell and this does nothing.
#
# Written to run under both bash and zsh when sourced (no ${BASH_SOURCE[0]}
# self-location -- that's bash-only and resolves inconsistently when a
# bash-shebang script is *sourced* into an interactive zsh session, which is
# exactly how this gets used). `git rev-parse --show-toplevel` finds the
# repo root the same way regardless of shell or current directory.
#
# Doesn't touch .env.local or .env.production.local themselves -- both stay
# exactly as Next.js expects them (.env.local is what `npm run dev`/
# `npm run test` read automatically; .env.production.local is otherwise
# inert, only Next.js's own production build mode or this script read it).
# This is for ad-hoc shell commands (curl, supabase CLI, psql) that need
# real values but aren't going through Next.js's own env loading at all.
#
# Usage:
#   source scripts/env.sh production   # hosted Supabase + saas.shlykoff.com
#   source scripts/env.sh local        # local Docker Supabase (same values
#                                       # `npm run dev` already uses)

_env_repo_root="$(git rev-parse --show-toplevel 2>/dev/null)"
if [ -z "$_env_repo_root" ]; then
  echo "Not inside a git repository -- cd into the project first." >&2
  return 1
fi

case "$1" in
  production | prod)
    _env_file="$_env_repo_root/.env.production.local"
    _env_label="production (hosted Supabase, saas.shlykoff.com)"
    ;;
  local | "")
    _env_file="$_env_repo_root/.env.local"
    _env_label="local (Docker Supabase, localhost:3000)"
    ;;
  *)
    echo "Usage: source scripts/env.sh [local|production]" >&2
    unset _env_repo_root
    return 1
    ;;
esac

if [ ! -f "$_env_file" ]; then
  echo "Missing $_env_file" >&2
  unset _env_repo_root _env_file _env_label
  return 1
fi

set -a
. "$_env_file"
set +a

echo "Loaded $_env_label env vars into this shell (from $(basename "$_env_file"))." >&2

unset _env_repo_root _env_file _env_label
