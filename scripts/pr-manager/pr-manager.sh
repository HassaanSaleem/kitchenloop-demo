#!/bin/bash
# PR Manager - Autonomous PR merge automation
#
# Finds eligible PRs, runs audit/fix cycles, and merges them.
#
# Sequential (one PR at a time — the only mode):
#   1. Refuse to run if the owner STOP sentinel (.kitchenloop/STOP) exists
#   2. Find eligible PRs (not draft, not skipped/stuck/needs-attention/uat-failed)
#   3. Sort by merge readiness (CLEAN > BEHIND > UNSTABLE)
#   4. Mechanical protected-path guard: never merge changes to the loop's own gates
#   5. Spawn a claude --print session per PR with the prep+merge prompt
#      (--dry-run composes prep only -> RESULT: PREPPED, no merge stage reachable)
#   6. Parse the RESULT: line, update state, loop
#
# Usage:
#   ./scripts/pr-manager/pr-manager.sh              # Continuous
#   ./scripts/pr-manager/pr-manager.sh --once        # One batch then exit
#   ./scripts/pr-manager/pr-manager.sh --pr 42       # Single PR
#   ./scripts/pr-manager/pr-manager.sh --dry-run     # Prep only, never merge
#   ./scripts/pr-manager/pr-manager.sh --max-prs 5   # Up to 5 PRs then exit
#   ./scripts/pr-manager/pr-manager.sh --no-parallel  # Accepted no-op (sequential is the only mode)

set -euo pipefail

# ── Source config if available ─────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

LIB_DIR=""
if [ -d "$SCRIPT_DIR/../kitchenloop/lib" ]; then
  LIB_DIR="$SCRIPT_DIR/../kitchenloop/lib"
elif [ -d "$SCRIPT_DIR/lib" ]; then
  LIB_DIR="$SCRIPT_DIR/lib"
fi

HAS_CONFIG=false
if [ -n "$LIB_DIR" ] && [ -f "$LIB_DIR/config.sh" ]; then
  source "$LIB_DIR/config.sh"
  if config_find 2>/dev/null; then
    config_load
    source "$LIB_DIR/tickets.sh"
    HAS_CONFIG=true
  fi
  [ -f "$LIB_DIR/notify.sh" ] && source "$LIB_DIR/notify.sh"
fi
# Fallback: notify_owner is a safe no-op if notify.sh was not sourced.
command -v notify_owner >/dev/null 2>&1 || notify_owner() { :; }

# ── Base branch: env var > config > default ────────────────────────
if [ -n "${BASE_BRANCH:-}" ]; then
  : # Explicit env var takes priority
elif [ "$HAS_CONFIG" = true ]; then
  BASE_BRANCH="$(config_get_default 'repo.base_branch' 'main')"
else
  BASE_BRANCH="main"
fi

# ── Defaults ─────────────────────────────────────────────────────────
MAX_ATTEMPTS_PER_PR=3
SKIP_AFTER_FAILURES="${SKIP_AFTER_FAILURES:-1}"
PR_TIMEOUT=2700
PR_TIMEOUT_FLOOR=1800             # Minimum per-PR timeout (30 min)
BLOCKED_PR_MAX_FAILURES=2         # Fast-skip BLOCKED PRs after this many failures
POLL_INTERVAL=300
COOLDOWN_AFTER_MERGE=120
MAX_PRS=0
SPECIFIC_PR=""
ONCE=false
DRY_RUN=false
VERBOSE=0
BUDGET=0
BUDGET_START=0
CLAUDE_MAX_TURNS=80

# Author allowlist (empty = trust all)
AUTHOR_ALLOWLIST=""
if [ "$HAS_CONFIG" = true ]; then
  AUTHOR_ALLOWLIST=$(config_get_list "pr_manager.author_allowlist" 2>/dev/null | tr '\n' ',' | sed 's/,$//')
  SKIP_AFTER_FAILURES=$(config_get_default "pr_manager.skip_after_failures" "1")
fi

# ── Parse arguments ──────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case $1 in
    --once)         ONCE=true; shift ;;
    --pr)           SPECIFIC_PR="$2"; ONCE=true; shift 2 ;;
    --pr=*)         SPECIFIC_PR="${1#*=}"; ONCE=true; shift ;;
    --dry-run)      DRY_RUN=true; shift ;;
    --max-prs)      MAX_PRS="$2"; shift 2 ;;
    --max-prs=*)    MAX_PRS="${1#*=}"; shift ;;
    --timeout)      PR_TIMEOUT="$2"
                    # Enforce minimum timeout floor
                    [ "$PR_TIMEOUT" -lt "$PR_TIMEOUT_FLOOR" ] && PR_TIMEOUT="$PR_TIMEOUT_FLOOR"
                    shift 2 ;;
    --budget)       BUDGET="$2"; BUDGET_START=$(date +%s); shift 2 ;;
    --budget=*)     BUDGET="${1#*=}"; BUDGET_START=$(date +%s); shift ;;
    --max-turns)    CLAUDE_MAX_TURNS="$2"; shift 2 ;;
    --max-turns=*)  CLAUDE_MAX_TURNS="${1#*=}"; shift ;;
    --no-parallel)  shift ;;   # accepted no-op (sequential is the only mode; kept for caller compat)
    --no-tmux)      shift ;;   # accepted no-op (kept for caller compat)
    -v|--verbose)   VERBOSE=1; shift ;;
    -vv|--debug)    VERBOSE=2; shift ;;
    --help|-h)
      echo "Usage: $0 [options]"
      echo ""
      echo "Options:"
      echo "  --once              Process one batch and exit"
      echo "  --pr <number>       Process specific PR only"
      echo "  --dry-run           Prep only (RESULT: PREPPED); never merges"
      echo "  --max-prs <N>       Process up to N PRs then exit"
      echo "  --timeout <secs>    Per-PR timeout (default: 2700)"
      echo "  --budget <secs>     Overall time budget"
      echo "  --max-turns <N>     Max turns per Claude session (default: 80)"
      echo "  --no-parallel       Accepted no-op (sequential is the only mode)"
      echo "  -v, --verbose       Verbose output"
      echo "  -vv, --debug        Debug output"
      echo "  --help              Show this help"
      exit 0 ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

# ── Setup ────────────────────────────────────────────────────────────
# The agent prompt is composed at spawn time: prep-pr.md (Stages 1-8) always,
# then merge-pr.md (Stages 8.5-10) concatenated ONLY when not --dry-run.
# resolve-conflicts.md is an inline reference for prep Stage 5, not a standalone
# templated prompt, so it is not assigned here.
PREP_PROMPT_TEMPLATE="$SCRIPT_DIR/prompts/prep-pr.md"
PROMPT_TEMPLATE="$SCRIPT_DIR/prompts/merge-pr.md"
STATE_FILE="$SCRIPT_DIR/state.json"
LOG_FILE="$SCRIPT_DIR/pr-manager.log"

# ── SIGTERM trap ─────────────────────────────────────────────────────
CHILD_PIDS=""
cleanup_on_signal() {
  local sig="$1"
  log "Received SIG${sig} -- graceful shutdown"
  for pid in $CHILD_PIDS; do
    kill "$pid" 2>/dev/null || true
  done
  sleep 2
  for pid in $CHILD_PIDS; do
    kill -9 "$pid" 2>/dev/null || true
  done
  log "PR Manager interrupted. Merged: ${MERGED_COUNT:-0}"
  exit 1
}
trap 'cleanup_on_signal TERM' TERM
trap 'cleanup_on_signal INT' INT

# ── Budget helpers ───────────────────────────────────────────────────
budget_remaining() {
  if [ "$BUDGET" -le 0 ]; then echo "999999"; return; fi
  local elapsed=$(( $(date +%s) - BUDGET_START ))
  local remaining=$(( BUDGET - elapsed ))
  [ "$remaining" -lt 0 ] && echo "0" || echo "$remaining"
}

has_budget() {
  local rem; rem=$(budget_remaining); [ "$rem" -ge 300 ]
}

if [ ! -f "$PREP_PROMPT_TEMPLATE" ]; then
  echo "ERROR: Missing prompt template: $PREP_PROMPT_TEMPLATE"
  exit 1
fi
if [ ! -f "$PROMPT_TEMPLATE" ]; then
  echo "ERROR: Missing prompt template: $PROMPT_TEMPLATE"
  exit 1
fi

if [ ! -f "$STATE_FILE" ]; then
  echo '{"pr_attempts": {}, "total_merged": 0, "total_stuck": 0}' > "$STATE_FILE"
fi

# ── ANSI stripping ───────────────────────────────────────────────────
strip_ansi() {
  perl -pe 's/\x1b\[[0-9;]*[a-zA-Z]//g; s/\x1b\([AB]//g; s/\x00//g'
}

# ── Logging ──────────────────────────────────────────────────────────
log() {
  local msg="$(date '+%Y-%m-%d %H:%M:%S') | $*"
  echo "$msg"
  echo "$msg" >> "$LOG_FILE"
}

# ── Owner escalation gate ────────────────────────────────────────────
STOP_FILE="$REPO_ROOT/.kitchenloop/STOP"
ESCALATIONS="$REPO_ROOT/ESCALATIONS.md"

# The owner's emergency brake. When the sentinel exists, no loop phase may
# run — pr-manager's output (a squash merge to the base branch) is irreversible,
# so it must refuse to spawn any session while STOP is set.
stop_active() { [ -f "$STOP_FILE" ]; }

# Escape a value for use as a sed replacement (delimiter '|'); strip newlines.
_sed_escape() { printf '%s' "$1" | sed 's/[&|\]/\\&/g' | tr -d '\n'; }

# Append an escalation to ESCALATIONS.md (idempotent by ID). Every stop-for-the-owner
# is one row here — never buried in prose or a PR comment. Inserts the row as the
# last row of the escalations table and its context paragraph at the end of the file.
add_escalation_row() {
  local id="$1" say="$2" question="$3" recommendation="$4" blocks="$5" context="$6"
  [ -f "$ESCALATIONS" ] || return 0
  # Idempotent: skip if a row/context for this ID already exists.
  if grep -qF "| $id |" "$ESCALATIONS" 2>/dev/null; then
    return 0
  fi
  local since; since=$(date -u +"%Y-%m-%d")
  local row="| $id | \`$say\` | $question | $recommendation | $since | $blocks |"
  local ctx="**$id context:** $context"
  local tmp; tmp=$(mktemp)
  awk -v row="$row" -v ctx="$ctx" '
    /^\|/ { last_was_table=1; print; next }
    { if (last_was_table==1) { print row; last_was_table=0 } print }
    END { print ""; print ctx }
  ' "$ESCALATIONS" > "$tmp" 2>/dev/null && mv "$tmp" "$ESCALATIONS" || rm -f "$tmp"
  log "ESCALATIONS: filed escalation $id (say: $say)"
  notify_owner "KitchenLoop needs you — new ESCALATIONS.md entry ($id)" \
    "$question Say \`$say\` to answer. Blocks: $blocks"
}

# ── Memory management ────────────────────────────────────────────────
get_available_memory_mb() {
  if command -v vm_stat &>/dev/null; then
    local vm; vm=$(vm_stat 2>/dev/null)
    local page_size; page_size=$(echo "$vm" | awk '/page size of/ {for(i=1;i<=NF;i++) if($i ~ /^[0-9]+$/) print $i}')
    page_size="${page_size:-16384}"
    local free inactive purgeable
    free=$(echo "$vm" | awk '/Pages free/ {gsub(/\./,"",$3); print $3}')
    inactive=$(echo "$vm" | awk '/Pages inactive/ {gsub(/\./,"",$3); print $3}')
    purgeable=$(echo "$vm" | awk '/Pages purgeable/ {gsub(/\./,"",$3); print $3}')
    echo $(( (${free:-0} + ${inactive:-0} + ${purgeable:-0}) * page_size / 1048576 ))
    return
  fi
  if [ -f /proc/meminfo ]; then
    awk '/MemAvailable:/ {print int($2/1024)}' /proc/meminfo; return
  fi
  echo 999999
}

check_memory_budget() {
  local min_mb="${1:-${PR_MANAGER_MIN_FREE_MB:-500}}"
  local avail; avail=$(get_available_memory_mb)
  [ "$avail" -ge "$min_mb" ]
}

cleanup_orphan_processes() {
  local killed=0
  # Spawned sessions run as `exec -a claude-pr-merger claude ...` so their argv
  # carries a stable tag this pattern can match (the claude prompt is on stdin,
  # so the temp-file path never appears in claude's own command line).
  for pid in $(pgrep -f 'claude-pr-merger' 2>/dev/null || true); do
    if [ "$pid" != "$$" ] && [ "$pid" != "$PPID" ]; then
      kill "$pid" 2>/dev/null && killed=$((killed + 1)) || true
    fi
  done
  # Clean up temp files in the SAME dir where we create them (${TMPDIR:-/tmp};
  # on macOS TMPDIR is /var/folders/..., not /tmp), but EXCLUDE active output
  # files (pr-merger-out-*) to avoid deleting a file mid-processing.
  find "${TMPDIR:-/tmp}" -maxdepth 1 -name 'pr-merger-*' ! -name 'pr-merger-out-*' -delete 2>/dev/null || true
  [ "$killed" -gt 0 ] && log "Cleaned up $killed orphan processes" || true
}

# ── State helpers ────────────────────────────────────────────────────
get_attempts() {
  local pr_num="$1"
  jq -r --arg pr "$pr_num" '.pr_attempts[$pr].attempts // 0' "$STATE_FILE" 2>/dev/null || echo 0
}

get_last_rejected_sha() {
  local pr_num="$1"
  jq -r --arg pr "$pr_num" '.pr_attempts[$pr].rejected_sha // ""' "$STATE_FILE" 2>/dev/null || echo ""
}

update_state() {
  local pr_num="$1" result="$2"
  local ts; ts=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
  local tmp; tmp=$(mktemp)
  jq --arg pr "$pr_num" --arg res "$result" --arg ts "$ts" '
    .pr_attempts //= {} |
    .pr_attempts[$pr] //= {"attempts": 0} |
    .pr_attempts[$pr].attempts += 1 |
    .pr_attempts[$pr].last_result = $res |
    .pr_attempts[$pr].ts = $ts |
    if $res == "MERGED" then .total_merged = ((.total_merged // 0) + 1) | del(.pr_attempts[$pr].followup_ticket) | del(.pr_attempts[$pr].escalated) else . end |
    if $res == "STUCK" then .total_stuck = ((.total_stuck // 0) + 1) else . end
  ' "$STATE_FILE" > "$tmp" && mv "$tmp" "$STATE_FILE"
}

# Record the HEAD SHA when a PR is rejected (NOT_MERGEABLE/STUCK)
# so we can skip re-evaluation if no new commits have been pushed
record_rejection_sha() {
  local pr_num="$1" head_sha="$2" reason="$3"
  local tmp; tmp=$(mktemp)
  jq --arg pr "$pr_num" --arg sha "$head_sha" --arg reason "$reason" '
    .pr_attempts[$pr].rejected_sha = $sha |
    .pr_attempts[$pr].rejection_reason = $reason
  ' "$STATE_FILE" > "$tmp" && mv "$tmp" "$STATE_FILE"
}

# ── Label helpers ────────────────────────────────────────────────────
add_label() { gh pr edit "$1" --add-label "$2" > /dev/null 2>&1 || true; }
remove_label() { gh pr edit "$1" --remove-label "$2" > /dev/null 2>&1 || true; }

# ── Ticket transition on merge ───────────────────────────────────────
update_tickets_on_merge() {
  local pr_num="$1"
  if [ "$HAS_CONFIG" = true ]; then
    local ticket_ids
    ticket_ids=$(ticket_extract_ids_from_pr "$pr_num")
    if [ -n "$ticket_ids" ]; then
      log "PR #$pr_num: transitioning tickets to done: $ticket_ids"
      while IFS= read -r tid; do
        [ -z "$tid" ] && continue
        ticket_transition "$tid" "done"
        ticket_add_comment "$tid" "Fixed in PR #$pr_num"
      done <<< "$ticket_ids"
    fi
  fi
}

# ── Template helper ──────────────────────────────────────────────────
# Substitutes each {{TOKEN}} explicitly. The base branch is a {{BASE_BRANCH}}
# placeholder (NOT a literal 's|main|...|' rewrite, which would corrupt any
# prompt word containing 'main' such as 'remains'/'domain'). Every replacement
# value is sed-escaped so a PR title containing | & or \ cannot break or inject
# into the sed program.
template_prompt() {
  local template_file="$1" output_file="$2" pr_num="$3" pr_title="$4"
  local head_branch="$5" base_branch="$6" pr_url="$7" merge_state="$8"
  local worktree="${9:-}"
  local pr_title_e head_branch_e base_branch_e pr_url_e merge_state_e repo_root_e worktree_e sha_e
  pr_title_e=$(_sed_escape "$pr_title")
  head_branch_e=$(_sed_escape "$head_branch")
  base_branch_e=$(_sed_escape "$base_branch")
  pr_url_e=$(_sed_escape "$pr_url")
  merge_state_e=$(_sed_escape "$merge_state")
  repo_root_e=$(_sed_escape "$REPO_ROOT")
  worktree_e=$(_sed_escape "$worktree")
  sha_e=$(_sed_escape "${VERIFIED_HEAD_SHA:-}")
  sed \
    -e "s|{{PR_NUMBER}}|${pr_num}|g" \
    -e "s|{{PR_TITLE}}|${pr_title_e}|g" \
    -e "s|{{HEAD_BRANCH}}|${head_branch_e}|g" \
    -e "s|{{BASE_BRANCH}}|${base_branch_e}|g" \
    -e "s|{{PR_URL}}|${pr_url_e}|g" \
    -e "s|{{MERGE_STATE}}|${merge_state_e}|g" \
    -e "s|{{REPO_ROOT}}|${repo_root_e}|g" \
    -e "s|{{DRY_RUN}}|${DRY_RUN}|g" \
    -e "s|{{WORKTREE}}|${worktree_e}|g" \
    -e "s|{{VERIFIED_HEAD_SHA}}|${sha_e}|g" \
    "$template_file" > "$output_file"
}

# ── PR JSON parsing ─────────────────────────────────────────────────
parse_pr_json() {
  local pr_json="$1"
  local parsed
  parsed=$(echo "$pr_json" | jq -r '[
    (.number | tostring), .title, .headRefName,
    (.baseRefName // "main"), (.mergeStateStatus // "UNKNOWN"), (.url // "N/A")
  ] | join("\u001f")')
  IFS=$'\x1f' read -r pr_num pr_title head_branch base_branch merge_state pr_url <<< "$parsed"
}

# ── Author check ─────────────────────────────────────────────────────
is_allowed_author() {
  local author="$1"
  if [ -z "$AUTHOR_ALLOWLIST" ]; then
    return 0  # Empty allowlist = trust all
  fi
  echo ",$AUTHOR_ALLOWLIST," | grep -q ",$author,"
}

# ── Find eligible PRs ───────────────────────────────────────────────
find_prs() {
  if [ -n "$SPECIFIC_PR" ]; then
    local author
    author=$(gh pr view "$SPECIFIC_PR" --json author --jq '.author.login' 2>/dev/null || echo "")
    if ! is_allowed_author "$author"; then
      log "PR #$SPECIFIC_PR is authored by '$author', not in allowlist. Skipping."
      return
    fi
    gh pr view "$SPECIFIC_PR" --json number,title,headRefName,baseRefName,mergeStateStatus,isDraft,labels,url \
      --jq '{number, title, headRefName, baseRefName, mergeStateStatus, isDraft, url, labels: [.labels[].name]}'
    return
  fi

  # Build author filter
  local author_flag=""
  if [ -n "$AUTHOR_ALLOWLIST" ]; then
    # Use the first author for the filter (gh only supports one --author)
    local first_author
    first_author=$(echo "$AUTHOR_ALLOWLIST" | cut -d',' -f1)
    author_flag="--author $first_author"
  fi

  gh pr list --state open --base "$BASE_BRANCH" $author_flag \
    --json number,title,headRefName,baseRefName,mergeStateStatus,isDraft,labels,url,author \
    --jq "
      [.[] | select(.isDraft == false) |
       select(.labels | map(.name) |
         (contains([\"pr-manager:skip\"]) or contains([\"pr-manager:stuck\"]) or contains([\"pr-manager:needs-attention\"]) or contains([\"uat-failed\"])) | not
       )] |
      sort_by(
        (if .mergeStateStatus == \"CLEAN\" then 0
         elif .mergeStateStatus == \"BEHIND\" then 1
         elif .mergeStateStatus == \"UNSTABLE\" then 2
         else 3 end),
        (if (.title | test(\"^fix[:(]\")) then 0
         elif (.title | test(\"^improve[:(]\")) then 1
         elif (.title | test(\"^feat[:(]\")) then 2
         else 3 end),
        .number
      ) | .[] |
      {number, title, headRefName, baseRefName, mergeStateStatus, isDraft, url, labels: [.labels[].name]}
    "
}

# ── Progress monitor ────────────────────────────────────────────────
progress_monitor() {
  local outfile="$1" pr_num="$2"
  local last_stage="" dots=0
  while true; do
    sleep 15
    [ ! -f "$outfile" ] && continue
    local current_stage
    current_stage=$(grep -oE 'Stage [0-9]+:' "$outfile" 2>/dev/null | tail -1 || true)
    if [ -n "$current_stage" ] && [ "$current_stage" != "$last_stage" ]; then
      local stage_line
      stage_line=$(grep -m1 "$current_stage" "$outfile" 2>/dev/null | head -1 || true)
      [ -n "$stage_line" ] && echo "" && echo "  PR #$pr_num >> $stage_line"
      last_stage="$current_stage"; dots=0
    else
      printf "."; dots=$((dots + 1))
      [ "$dots" -ge 40 ] && echo " ($(date '+%H:%M:%S'))" && dots=0
    fi
  done
}

# ── Pre-merge deletion check ──────────────────────────────────────────
# Prevents accidental file deletions by AI agents during rebase/conflicts.
# Any file deleted by the PR must be documented in the PR description.
check_pr_deletions() {
  local pr_num="$1" head_branch="$2"
  local pr_body
  pr_body=$(gh pr view "$pr_num" --json body --jq '.body' 2>/dev/null || echo "")

  # Fail closed: if we can't fetch, block the merge
  if ! git fetch origin "$BASE_BRANCH" "$head_branch" --quiet 2>/dev/null; then
    log "PR #$pr_num: deletion check BLOCKED — git fetch failed (fail-closed)"
    return 1
  fi

  local checked_head_sha
  checked_head_sha=$(git rev-parse "origin/$head_branch" 2>/dev/null || echo "")

  local deleted_files
  deleted_files=$(git diff --name-only --diff-filter=D "origin/${BASE_BRANCH}...origin/${head_branch}" 2>/dev/null || echo "")

  if [ -z "$deleted_files" ]; then
    # TOCTOU: verify HEAD hasn't moved even on the clean path
    local current_head
    current_head=$(git rev-parse "origin/$head_branch" 2>/dev/null || echo "")
    if [ -n "$checked_head_sha" ] && [ "$checked_head_sha" != "$current_head" ]; then
      log "PR #$pr_num: BLOCKED — HEAD changed during deletion check ($checked_head_sha -> $current_head), re-fetch required"
      return 1
    fi
    VERIFIED_HEAD_SHA="$checked_head_sha"
    return 0  # No deletions, HEAD stable, safe to proceed
  fi

  local unexpected=""
  while IFS= read -r filepath; do
    [ -z "$filepath" ] && continue
    # Skip if file doesn't exist on base branch (already absent)
    if ! git cat-file -e "origin/${BASE_BRANCH}:${filepath}" 2>/dev/null; then
      continue
    fi
    # Check if deletion is documented in PR description (exact path match)
    if [ -n "$pr_body" ] && printf '%s' "$pr_body" | grep -qF "$filepath"; then
      continue
    fi
    unexpected="${unexpected}${filepath}\n"
  done <<< "$deleted_files"

  if [ -n "$unexpected" ]; then
    log "PR #$pr_num: BLOCKED — unexpected file deletions detected:"
    printf '%b' "$unexpected" | while IFS= read -r f; do
      [ -n "$f" ] && log "  - $f"
    done
    log "PR #$pr_num: To unblock, add the full repo-relative path(s) to the PR description"

    # TOCTOU: verify HEAD hasn't changed since we checked
    local current_head
    current_head=$(git rev-parse "origin/$head_branch" 2>/dev/null || echo "")
    if [ "$checked_head_sha" != "$current_head" ]; then
      log "PR #$pr_num: WARNING — HEAD changed during deletion check ($checked_head_sha -> $current_head)"
    fi

    return 1
  fi

  VERIFIED_HEAD_SHA="$checked_head_sha"
  return 0
}

# ── Protected-path guard ─────────────────────────────────────────────
# The loop may not merge changes to its own gates. Mechanical deny-list check,
# run BEFORE spawning the agent: any PR that touches a protected artifact is
# NOT_MERGEABLE and gets an ESCALATIONS.md entry (a loop-authored gate change is
# an owner decision, never a loop merge).
PROTECTED_PATHS="\
.kitchenloop/quality-bar.md
.kitchenloop/unbeatable-tests.md
.kitchenloop/uat-cards/
scripts/pr-manager/
scripts/kitchenloop/prompts/
kitchenloop.yaml
MANDATE.md
ESCALATIONS.md
.specify/memory/constitution.md
docs/architecture/system-architecture.md
.claude/agents/uat-evaluator.md
.claude/skills/kitchenloop-quality-sweep/"

# Sets two globals (must be called directly, NOT in $(...), so the assignments
# land in the current shell): PROTECTED_CHECK_OK=1 when `gh pr diff` was readable
# (0 when it failed — the agent's own Stage 1.5 check is the backstop then), and
# PROTECTED_HIT_FILE to the first protected path the PR touches (empty = none).
PROTECTED_CHECK_OK=0
PROTECTED_HIT_FILE=""
protected_path_hit() {
  local pr_num="$1"
  PROTECTED_CHECK_OK=0
  PROTECTED_HIT_FILE=""
  local changed
  changed=$(gh pr diff "$pr_num" --name-only 2>/dev/null) || return 1
  PROTECTED_CHECK_OK=1
  local f sp
  while IFS= read -r f; do
    [ -z "$f" ] && continue
    while IFS= read -r sp; do
      [ -z "$sp" ] && continue
      case "$sp" in
        */)  # directory prefix
          case "$f" in "$sp"*) PROTECTED_HIT_FILE="$f"; return 0 ;; esac ;;
        *)   # exact file
          [ "$f" = "$sp" ] && { PROTECTED_HIT_FILE="$f"; return 0; } ;;
      esac
    done <<< "$PROTECTED_PATHS"
  done <<< "$changed"
  return 1
}

# ── Security/design-blocked PR retirement ────────────────────────────
# PRs blocked by security guardrails or architecture constraints should
# not be retried — they need human intervention by design.
is_design_blocked() {
  local pr_num="$1"
  local rejection_reason
  rejection_reason=$(jq -r --arg pr "$pr_num" '.pr_attempts[$pr].rejection_reason // ""' "$STATE_FILE" 2>/dev/null || echo "")
  if [ -z "$rejection_reason" ]; then
    return 1
  fi
  # Check for security/architecture keywords in the rejection reason
  if echo "$rejection_reason" | grep -qiE 'security|auth|credential|permission|secret|breaking.change|architecture|design'; then
    return 0
  fi
  return 1
}

retire_design_blocked_pr() {
  local pr_num="$1"
  local rejection_reason
  rejection_reason=$(jq -r --arg pr "$pr_num" '.pr_attempts[$pr].rejection_reason // "design-level concern"' "$STATE_FILE" 2>/dev/null || echo "design-level concern")

  log "PR #$pr_num: retiring — blocked by design-level concern: $rejection_reason"
  gh pr comment "$pr_num" --body "$(cat <<RETIRE
## PR Retired — Design-Level Block

This PR has been retired because it is blocked by a design-level concern that cannot be resolved by automated fixes:

> $rejection_reason

The linked ticket (if any) has been moved back for rethinking. A new approach is needed.

_Retired by PR Manager_
RETIRE
)" 2>/dev/null || true
  gh pr close "$pr_num" 2>/dev/null || true
  add_label "$pr_num" "pr-manager:retired"

  # Route linked tickets back to todo with needs-rethink
  if [ "$HAS_CONFIG" = true ]; then
    local ticket_ids
    ticket_ids=$(ticket_extract_ids_from_pr "$pr_num" 2>/dev/null || echo "")
    if [ -n "$ticket_ids" ]; then
      while IFS= read -r tid; do
        [ -z "$tid" ] && continue
        ticket_transition "$tid" "todo" 2>/dev/null || true
        ticket_add_comment "$tid" "PR #$pr_num retired (design-level block: $rejection_reason). Needs a new approach." 2>/dev/null || true
      done <<< "$ticket_ids"
    fi
  fi
}

# ── Escalation (fires when a PR is skipped/capped) ───────────────────
# Creates a follow-up ticket (idempotent) and posts a one-time escalation
# comment with the failure history. Called at the moment the needs-attention /
# stuck label is applied, so the escalation ladder is reachable regardless of
# skip_after_failures (once needs-attention is set, find_prs stops returning the
# PR, so nothing fires on "later attempts" — the trigger must be here).
escalate_stuck_pr() {
  local pr_num="$1" attempts="$2"

  # 1. Follow-up ticket (idempotent via .followup_ticket)
  if [ "$HAS_CONFIG" = true ]; then
    local has_followup
    has_followup=$(jq -r --arg pr "$pr_num" '.pr_attempts[$pr].followup_ticket // ""' "$STATE_FILE" 2>/dev/null || echo "")
    if [ -z "$has_followup" ]; then
      local failure_type="retryable"
      is_design_blocked "$pr_num" && failure_type="needs_redesign"
      local rejection_reason pr_title followup_id
      rejection_reason=$(jq -r --arg pr "$pr_num" '.pr_attempts[$pr].rejection_reason // "unknown"' "$STATE_FILE" 2>/dev/null || echo "unknown")
      pr_title=$(gh pr view "$pr_num" --json title --jq '.title' 2>/dev/null || echo "PR #$pr_num")
      log "PR #$pr_num: creating follow-up ticket ($failure_type) after $attempts failures"
      followup_id=$(ticket_create \
        "Follow-up: PR #$pr_num blocked ($failure_type)" \
        "PR #$pr_num ($pr_title) has failed $attempts merge attempts.\n\n**Failure type**: $failure_type\n**Last rejection**: $rejection_reason\n\nOriginal PR: #$pr_num\n\n_Created by PR Manager escalation_" \
        2>/dev/null || echo "")
      if [ -n "$followup_id" ]; then
        local tmp_state
        tmp_state=$(jq --arg pr "$pr_num" --arg tid "$followup_id" \
          '.pr_attempts[$pr].followup_ticket = $tid' "$STATE_FILE" 2>/dev/null) && \
          echo "$tmp_state" > "$STATE_FILE"
        gh pr comment "$pr_num" --body "Follow-up ticket created: #$followup_id ($failure_type)" 2>/dev/null || true
        log "PR #$pr_num: follow-up ticket #$followup_id created"
      fi
    fi
  fi

  # 2. One-time escalation comment with failure history (idempotent via .escalated)
  local escalated
  escalated=$(jq -r --arg pr "$pr_num" '.pr_attempts[$pr].escalated // false' "$STATE_FILE" 2>/dev/null || echo "false")
  if [ "$escalated" != "true" ]; then
    local failure_history
    failure_history=$(jq -r --arg pr "$pr_num" '
      .pr_attempts[$pr] | "Attempts: \(.attempts), Last result: \(.last_result // "unknown"), Last SHA: \(.rejected_sha // "unknown"), Reason: \(.rejection_reason // "unknown")"
    ' "$STATE_FILE" 2>/dev/null || echo "unknown")
    gh pr comment "$pr_num" --body "$(cat <<ESCALATION
## PR Manager Escalation — needs human attention after $attempts attempt(s)

This PR has failed $attempts merge attempt(s) and has been set aside for a human.

**Failure history**: $failure_history

**Action needed**: Either:
1. Fix the underlying issue and push new commits
2. Close the PR if the approach needs rethinking
3. Remove the \`pr-manager:needs-attention\` label to retry

_Escalated by PR Manager_
ESCALATION
)" 2>/dev/null || true
    local tmp_esc
    tmp_esc=$(jq --arg pr "$pr_num" '.pr_attempts[$pr].escalated = true' "$STATE_FILE" 2>/dev/null) && \
      echo "$tmp_esc" > "$STATE_FILE"
    log "PR #$pr_num: escalation comment posted"
  fi
}

# ── BLOCKED PR fast-skip check ───────────────────────────────────────
# After N failed attempts on a BLOCKED PR with only CI failures (no human
# review changes requested), skip spawning Claude and label for human attention.
blocked_should_fast_skip() {
  local pr_num="$1" merge_state="$2" attempts="$3"
  if [ "$merge_state" != "BLOCKED" ] && [ "$merge_state" != "UNSTABLE" ]; then
    return 1  # Not blocked, don't skip
  fi
  if [ "$attempts" -lt "$BLOCKED_PR_MAX_FAILURES" ]; then
    return 1  # Haven't hit the threshold yet
  fi
  # Check if failures are CI-only (no human review changes requested)
  local review_decision
  review_decision=$(gh pr view "$pr_num" --json reviewDecision --jq '.reviewDecision' 2>/dev/null || echo "")
  if [ "$review_decision" = "CHANGES_REQUESTED" ]; then
    return 1  # Human requested changes — needs Claude to address them
  fi
  return 0  # Fast-skip: BLOCKED + enough failures + no human changes requested
}

# ── Process a single PR (sequential mode) ────────────────────────────
process_pr() {
  local pr_json="$1"
  parse_pr_json "$pr_json"

  # Memory check
  local mem_retries=0
  while ! check_memory_budget; do
    mem_retries=$((mem_retries + 1))
    if [ "$mem_retries" -ge 10 ]; then
      log "PR #$pr_num: SKIPPED - insufficient memory"; return 1
    fi
    cleanup_orphan_processes; sleep 30
  done

  local attempts; attempts=$(get_attempts "$pr_num")

  # Hard cap: after MAX_ATTEMPTS_PER_PR, mark stuck permanently and escalate.
  # (With skip_after_failures < MAX this is a safety net; whichever threshold is
  # lower fires first.)
  if [ "$attempts" -ge "$MAX_ATTEMPTS_PER_PR" ]; then
    log "PR #$pr_num: exceeded $MAX_ATTEMPTS_PER_PR attempts — escalating (stuck)"
    add_label "$pr_num" "pr-manager:stuck"
    update_state "$pr_num" "STUCK"
    escalate_stuck_pr "$pr_num" "$attempts"
    add_label "$pr_num" "pr-manager:needs-attention"
    return 1
  fi

  # Skip + escalate the moment the failure threshold is reached. The escalation
  # (follow-up ticket + comment) MUST fire here: once needs-attention is applied,
  # find_prs excludes the PR, so no "later attempt" can ever trigger it.
  if [ "$attempts" -ge "$SKIP_AFTER_FAILURES" ]; then
    # PRs blocked by a security/architecture concern are retired for human
    # redesign rather than retried.
    if is_design_blocked "$pr_num"; then
      retire_design_blocked_pr "$pr_num"
      update_state "$pr_num" "STUCK"
      return 1
    fi
    log "PR #$pr_num: $attempts prior failure(s), skipping (needs-attention)"
    escalate_stuck_pr "$pr_num" "$attempts"
    add_label "$pr_num" "pr-manager:needs-attention"
    return 1
  fi

  # Fast-skip BLOCKED PRs that have failed too many times with only CI issues
  if blocked_should_fast_skip "$pr_num" "$merge_state" "$attempts"; then
    log "PR #$pr_num: fast-skip BLOCKED ($attempts prior failures, CI-only issues)"
    add_label "$pr_num" "pr-manager:needs-attention"
    update_state "$pr_num" "STUCK"
    return 1
  fi

  # Gate rejection memory: skip PRs that were rejected and have no new commits
  local rejected_sha
  rejected_sha=$(get_last_rejected_sha "$pr_num")
  if [ -n "$rejected_sha" ]; then
    local current_sha
    current_sha=$(gh pr view "$pr_num" --json headRefOid --jq '.headRefOid' 2>/dev/null || echo "")
    if [ "$rejected_sha" = "$current_sha" ]; then
      local prev_reason
      prev_reason=$(jq -r --arg pr "$pr_num" '.pr_attempts[$pr].rejection_reason // "unknown"' "$STATE_FILE" 2>/dev/null || echo "unknown")
      log "PR #$pr_num: skipped — previously rejected at $rejected_sha (reason: $prev_reason), no new commits"
      return 1
    fi
  fi

  add_label "$pr_num" "pr-manager:processing"
  log "Processing PR #$pr_num: $pr_title (state: $merge_state, attempt: $((attempts+1)))"

  # Protected-path guard (mechanical, before spawning): the loop may not merge
  # changes to its own gates. Any hit -> NOT_MERGEABLE + ESCALATIONS.md entry + skip.
  # Called directly (not in $(...)) so PROTECTED_CHECK_OK/PROTECTED_HIT_FILE land here.
  protected_path_hit "$pr_num" || true
  if [ "$PROTECTED_CHECK_OK" = "1" ] && [ -n "$PROTECTED_HIT_FILE" ]; then
    local protected_file="$PROTECTED_HIT_FILE"
    log "PR #$pr_num: NOT_MERGEABLE — touches protected gate '$protected_file' (owner decision)"
    add_escalation_row \
      "PRM-PROT-$pr_num" \
      "review pr $pr_num" \
      "PR #$pr_num changes a protected loop gate (\`$protected_file\`); the loop may not merge it." \
      "Review the change by hand; land it yourself if intended, or close the PR. The loop will not auto-merge protected-gate edits." \
      "PR #$pr_num merge" \
      "The mechanical protected-path guard matched \`$protected_file\` in PR #$pr_num's diff. Protected-gate changes are owner gates, never loop commits, so the PR is marked NOT_MERGEABLE and set aside."
    remove_label "$pr_num" "pr-manager:processing"
    add_label "$pr_num" "pr-manager:needs-attention"
    update_state "$pr_num" "NOT_MERGEABLE"
    local protected_head_sha
    protected_head_sha=$(gh pr view "$pr_num" --json headRefOid --jq '.headRefOid' 2>/dev/null || echo "")
    [ -n "$protected_head_sha" ] && record_rejection_sha "$pr_num" "$protected_head_sha" "NOT_MERGEABLE"
    return 1
  fi

  # Pre-merge deletion check: block PRs with unexpected file deletions
  # On success, VERIFIED_HEAD_SHA is set to the pinned commit for merge
  VERIFIED_HEAD_SHA=""
  if ! check_pr_deletions "$pr_num" "$head_branch"; then
    log "PR #$pr_num: STUCK — unexpected file deletions (requires human review)"
    remove_label "$pr_num" "pr-manager:processing"
    add_label "$pr_num" "pr-manager:needs-attention"
    update_state "$pr_num" "STUCK"
    return 1
  fi

  # Compose the agent prompt: prep-pr.md (Stages 1-8) always; merge-pr.md
  # (Stages 8.5-10) concatenated ONLY when NOT --dry-run. With DRY_RUN=true the
  # merge stages are literally absent from the prompt (no merge stage reachable);
  # the prep pipeline's Gate Decision ends at RESULT: PREPPED.
  local prompt_tmp; prompt_tmp=$(mktemp "${TMPDIR:-/tmp}/pr-merger-XXXXXX")
  template_prompt "$PREP_PROMPT_TEMPLATE" "$prompt_tmp" "$pr_num" "$pr_title" "$head_branch" "$base_branch" "$pr_url" "$merge_state"
  if [ "$DRY_RUN" != true ]; then
    local merge_tmp; merge_tmp=$(mktemp "${TMPDIR:-/tmp}/pr-merger-XXXXXX")
    template_prompt "$PROMPT_TEMPLATE" "$merge_tmp" "$pr_num" "$pr_title" "$head_branch" "$base_branch" "$pr_url" "$merge_state"
    printf '\n\n' >> "$prompt_tmp"
    cat "$merge_tmp" >> "$prompt_tmp"
    rm -f "$merge_tmp"
  fi

  # Deterministic output file path per PR number (not mktemp) to avoid race
  # condition where cleanup_orphan_processes deletes the active output file
  local outfile="${TMPDIR:-/tmp}/pr-merger-out-${pr_num}"
  true > "$outfile"  # Pre-create and truncate
  local timed_out=false

  # Start progress monitor
  progress_monitor "$outfile" "$pr_num" &
  local monitor_pid=$!

  # Run claude (with fast-failure retry)
  local max_fast_retries=2
  local fast_retry=0
  local exit_code=0
  local start_ts

  while true; do
    start_ts=$(date +%s)
    # `exec -a claude-pr-merger` tags the process argv so cleanup_orphan_processes
    # can find leftover sessions (the prompt is piped on stdin, so no temp-file
    # path appears in claude's own command line). exec also makes claude_pid the
    # real claude PID for the watchdog's process-group kill.
    cat "$prompt_tmp" | (cd "$REPO_ROOT" && exec -a claude-pr-merger \
      claude --dangerously-skip-permissions --print \
      --max-turns "$CLAUDE_MAX_TURNS") > "$outfile" 2>&1 &
    local claude_pid=$!
    CHILD_PIDS="$CHILD_PIDS $claude_pid"

    # Watchdog: kill process group on timeout (macOS zombie fix)
    ( sleep "$PR_TIMEOUT"; touch "${outfile}.timeout"
      local pgid
      pgid=$(ps -o pgid= -p "$claude_pid" 2>/dev/null | tr -d ' ')
      [ -n "$pgid" ] && kill -- -"$pgid" 2>/dev/null || kill "$claude_pid" 2>/dev/null || true
      sleep 10
      pgid=$(ps -o pgid= -p "$claude_pid" 2>/dev/null | tr -d ' ')
      [ -n "$pgid" ] && kill -9 -- -"$pgid" 2>/dev/null || kill -9 "$claude_pid" 2>/dev/null || true
    ) &
    local watchdog=$!

    exit_code=0
    wait "$claude_pid" 2>/dev/null || exit_code=$?

    kill "$watchdog" 2>/dev/null || true; wait "$watchdog" 2>/dev/null 2>&1 || true

    # Detect fast failures: non-zero exit in <60s (init errors, permission issues)
    local elapsed=$(( $(date +%s) - start_ts ))
    if [ "$exit_code" -ne 0 ] && [ "$elapsed" -lt 60 ] && [ "$fast_retry" -lt "$max_fast_retries" ]; then
      fast_retry=$((fast_retry + 1))
      local backoff=$(( fast_retry * 10 ))
      log "PR #$pr_num: fast failure (exit $exit_code in ${elapsed}s), retry $fast_retry/$max_fast_retries in ${backoff}s"
      sleep "$backoff"
      true > "$outfile"  # Reset outfile for retry
      continue
    fi
    break
  done

  kill "$monitor_pid" 2>/dev/null || true

  if [ -f "${outfile}.timeout" ]; then
    timed_out=true; rm -f "${outfile}.timeout"
  fi

  # Parse result (strip ANSI codes before grep to avoid false negatives)
  local clean_outfile
  clean_outfile=$(mktemp "${TMPDIR:-/tmp}/pr-merger-clean-XXXXXX")
  strip_ansi < "$outfile" > "$clean_outfile" 2>/dev/null || cp "$outfile" "$clean_outfile"

  # Post-run assertion: if outfile is 0 bytes and process exited 0, something is wrong
  if [ ! -s "$clean_outfile" ] && [ "$exit_code" -eq 0 ]; then
    log "PR #$pr_num: ERROR — outfile is 0 bytes despite exit code 0 (agent failed to produce output)"
  fi

  # Extract RESULT regardless of exit code — a SIGTERMed process (exit 143)
  # may have already written RESULT: MERGED before being killed
  local result="UNKNOWN"
  local last_bytes=""
  last_bytes=$(tail -c 500 "$clean_outfile" 2>/dev/null || true)

  # Anchored RESULT greps to avoid matching mid-string in log messages
  if printf '%s\n' "$last_bytes" | grep -qE '^RESULT: MERGED' 2>/dev/null; then
    result="MERGED"
  elif grep -qE '^RESULT: MERGED' "$clean_outfile" 2>/dev/null; then
    result="MERGED"
  elif printf '%s\n' "$last_bytes" | grep -qE '^RESULT: PREPPED' 2>/dev/null; then
    result="PREPPED"
  elif grep -qE '^RESULT: PREPPED' "$clean_outfile" 2>/dev/null; then
    result="PREPPED"
  elif printf '%s\n' "$last_bytes" | grep -qE '^RESULT: STUCK' 2>/dev/null; then
    result="STUCK"
  elif grep -qE '^RESULT: STUCK' "$clean_outfile" 2>/dev/null; then
    result="STUCK"
  elif printf '%s\n' "$last_bytes" | grep -qE '^RESULT: NOT_MERGEABLE' 2>/dev/null; then
    result="NOT_MERGEABLE"
  elif grep -qE '^RESULT: NOT_MERGEABLE' "$clean_outfile" 2>/dev/null; then
    result="NOT_MERGEABLE"
  fi

  # If no RESULT line found, apply fallback logic
  if [ "$result" = "UNKNOWN" ]; then
    if [ "$timed_out" = true ]; then
      result="TIMEOUT"
    elif [ "$exit_code" -ne 0 ]; then
      result="FAILED"
    fi
  fi

  # GitHub API fallback: if RESULT is still UNKNOWN or FAILED, check if the PR
  # was actually merged on GitHub (handles cases where output was truncated)
  if [ "$result" = "UNKNOWN" ] || [ "$result" = "FAILED" ] || [ "$result" = "TIMEOUT" ]; then
    local gh_state
    gh_state=$(gh pr view "$pr_num" --json state,mergedAt --jq '.state' 2>/dev/null || echo "")
    if [ "$gh_state" = "MERGED" ]; then
      log "PR #$pr_num: GitHub API confirms MERGED (overriding result=$result)"
      result="MERGED"
    fi
  fi

  # Log discrepancy between exit code and RESULT line
  if [ "$exit_code" -ne 0 ] && [ "$result" = "MERGED" ]; then
    log "PR #$pr_num: NOTE — exit code $exit_code but RESULT=MERGED (honouring merge)"
  fi

  rm -f "$clean_outfile"

  log "PR #$pr_num: Result=$result (exit=$exit_code)"
  update_state "$pr_num" "$result"

  # NOTE: the attempt counter is reset ONLY on result=MERGED (in the case block
  # below). A previous version also reset it whenever mergeStateStatus was CLEAN,
  # regardless of the session result — that let a CLEAN PR whose session kept
  # timing out / crashing / emitting an unparseable sentinel (TIMEOUT/FAILED/
  # UNKNOWN) retry forever, since the counter never reached SKIP_AFTER_FAILURES.
  # A successful session is the only thing that earns a counter reset.

  case "$result" in
    MERGED)
      remove_label "$pr_num" "pr-manager:processing"
      update_tickets_on_merge "$pr_num"
      # C8: Reset attempt count and clear rejection memory on successful merge
      local tmp_reset; tmp_reset=$(mktemp)
      jq --arg pr "$pr_num" '
        .pr_attempts[$pr].attempts = 0 |
        .pr_attempts[$pr].rejected_sha = null |
        .pr_attempts[$pr].rejection_reason = null
      ' "$STATE_FILE" > "$tmp_reset" 2>/dev/null && mv "$tmp_reset" "$STATE_FILE" || rm -f "$tmp_reset"
      MERGED_COUNT=$((MERGED_COUNT + 1))
      sleep "$COOLDOWN_AFTER_MERGE"
      ;;
    PREPPED)
      remove_label "$pr_num" "pr-manager:processing"
      ;;
    STUCK|NOT_MERGEABLE)
      remove_label "$pr_num" "pr-manager:processing"
      add_label "$pr_num" "pr-manager:needs-attention"
      # Record rejection SHA for gate memory — skip re-evaluation until new commits
      local current_head_sha
      current_head_sha=$(gh pr view "$pr_num" --json headRefOid --jq '.headRefOid' 2>/dev/null || echo "")
      if [ -n "$current_head_sha" ]; then
        record_rejection_sha "$pr_num" "$current_head_sha" "$result"
      fi
      ;;
    *)
      remove_label "$pr_num" "pr-manager:processing"
      ;;
  esac

  rm -f "$prompt_tmp" "$outfile"
  return 0
}

# ── Main loop ────────────────────────────────────────────────────────
cleanup_orphan_processes
MERGED_COUNT=0
PROCESSED_COUNT=0

# Owner emergency brake: refuse to start if the STOP sentinel is present.
# pr-manager's output (a squash merge to $BASE_BRANCH) is irreversible, so it
# must not spawn any session while the owner's brake is set.
if stop_active; then
  log "STOP sentinel present ($STOP_FILE) — refusing to run. Contents:"
  sed 's/^/  | /' "$STOP_FILE" 2>/dev/null || true
  exit 0
fi

log "PR Manager started (base=$BASE_BRANCH, max_prs=$MAX_PRS, once=$ONCE, budget=$BUDGET)"

while true; do
  # STOP check at the top of every poll cycle — the owner may set the brake
  # while the daemon is sleeping between batches.
  if stop_active; then
    log "STOP sentinel appeared ($STOP_FILE) — stopping. Merged: $MERGED_COUNT, Processed: $PROCESSED_COUNT"
    sed 's/^/  | /' "$STOP_FILE" 2>/dev/null || true
    break
  fi

  if ! has_budget; then
    log "Budget exhausted. Merged: $MERGED_COUNT, Processed: $PROCESSED_COUNT"
    break
  fi

  pr_list=$(find_prs 2>/dev/null)

  if [ -z "$pr_list" ]; then
    if [ "$ONCE" = true ]; then
      log "No eligible PRs found. Exiting."
      break
    fi
    log "No eligible PRs. Sleeping ${POLL_INTERVAL}s..."
    sleep "$POLL_INTERVAL"
    continue
  fi

  while IFS= read -r pr_json; do
    [ -z "$pr_json" ] && continue

    # STOP check before EACH PR — never start a merge session once the brake is set.
    if stop_active; then
      log "STOP sentinel appeared ($STOP_FILE) — stopping mid-batch."
      break 2
    fi

    if [ "$MAX_PRS" -gt 0 ] && [ "$PROCESSED_COUNT" -ge "$MAX_PRS" ]; then
      log "Reached max PRs ($MAX_PRS). Stopping."
      break 2
    fi

    if ! has_budget; then
      log "Budget exhausted during batch."
      break 2
    fi

    process_pr "$pr_json" || true
    PROCESSED_COUNT=$((PROCESSED_COUNT + 1))

  done <<< "$pr_list"

  if [ "$ONCE" = true ]; then
    break
  fi

  log "Batch complete. Merged: $MERGED_COUNT. Sleeping ${POLL_INTERVAL}s..."
  sleep "$POLL_INTERVAL"
done

log "PR Manager finished. Merged: $MERGED_COUNT, Processed: $PROCESSED_COUNT"
