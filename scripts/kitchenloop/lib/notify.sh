#!/bin/bash
# notify.sh — actively surface owner escalations and stops.
#
# The Kitchen Loop is file-based and pull-driven: it writes ESCALATIONS.md
# entries and the .kitchenloop/STOP sentinel and expects the owner to notice.
# This helper pushes those moments to the owner so an unattended overnight
# batch does not sit silently on an escalation entry.
#
# Channels (best-effort, additive, never fatal to the loop):
#   - terminal bell + a NOTIFY line in the loop log         (always)
#   - macOS desktop notification via osascript              (when notify.desktop != false)
#   - Slack incoming webhook via curl                       (when $KITCHENLOOP_SLACK_WEBHOOK is set)
#
# The Slack webhook URL is a secret: it lives in .env (git-ignored, sourced by
# the loop), never in kitchenloop.yaml. notify.desktop is a non-secret toggle
# in kitchenloop.yaml. This file is sourced AFTER config.sh so it may use
# config_get_default; it degrades gracefully if that function is absent.
#
# Sourced by scripts/kitchenloop/kitchenloop.sh and scripts/pr-manager/pr-manager.sh.

# notify_owner "title" "body"
# Never returns non-zero and never lets a channel failure escape (safe under set -e).
notify_owner() {
  local title="${1:-KitchenLoop}" body="${2:-}"

  # Always: terminal bell + structured log line (cheap, local, no deps).
  printf '\a' 2>/dev/null || true
  if [ -n "${LOG_FILE:-}" ]; then
    { echo "$(date) | NOTIFY | ${title} — ${body}" >> "$LOG_FILE"; } 2>/dev/null || true
  fi
  echo "  [notify] ${title} — ${body}"

  # Resolve the desktop toggle (default on). Tolerate config.sh not being loaded.
  local want_desktop="true"
  if command -v config_get_default >/dev/null 2>&1; then
    want_desktop=$(config_get_default "notify.desktop" "true" 2>/dev/null || echo "true")
  fi

  # macOS desktop notification. osascript is picky about quotes — sanitize.
  if [ "$want_desktop" != "false" ] \
     && [ "$(uname 2>/dev/null || echo unknown)" = "Darwin" ] \
     && command -v osascript >/dev/null 2>&1; then
    local d_title d_body
    d_title=$(printf '%s' "$title" | tr -d '"\\' | tr '\n' ' ' | cut -c1-120)
    d_body=$(printf '%s' "$body"  | tr -d '"\\' | tr '\n' ' ' | cut -c1-240)
    osascript -e "display notification \"${d_body}\" with title \"${d_title}\" sound name \"Ping\"" >/dev/null 2>&1 || true
  fi

  # Slack incoming webhook (any OS). Backgrounded + time-bounded so a slow or
  # unreachable webhook can never stall or fail the loop.
  local webhook="${KITCHENLOOP_SLACK_WEBHOOK:-}"
  if [ -n "$webhook" ] && command -v curl >/dev/null 2>&1; then
    local s_title s_body payload
    s_title=$(printf '%s' "$title" | sed 's/\\/\\\\/g; s/"/\\"/g' | tr '\n' ' ')
    s_body=$(printf '%s' "$body"   | sed 's/\\/\\\\/g; s/"/\\"/g' | tr '\n' ' ' | cut -c1-500)
    payload=$(printf '{"text":"*%s*\n%s"}' "$s_title" "$s_body")
    ( curl -sf -m 10 -X POST -H 'Content-type: application/json' \
        --data "$payload" "$webhook" >/dev/null 2>&1 || true ) &
  fi

  return 0
}
