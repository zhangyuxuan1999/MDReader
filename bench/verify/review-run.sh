#!/bin/zsh
# bench/verify/review-run.sh — runs the static-review verifier scripts sequentially against :5205.
# Usage: PORT=5205 zsh bench/verify/review-run.sh [script names without .mjs]  → bench/verify/review-batch2.log
cd "$(dirname "$0")/../.." || exit 1
LOG=bench/verify/review-batch2.log
: > "$LOG"
SCRIPTS=("$@")
if [ ${#SCRIPTS[@]} -eq 0 ]; then
  SCRIPTS=(review-docswitch review-dispose review-restart review-restart-draft review-mode-scroll review-enter-toc review-enter-profile review-paste review-overlay review-export-silence review-typing)
fi
for s in "${SCRIPTS[@]}"; do
  echo "##### $s  ($(date +%T))" | tee -a "$LOG"
  PORT=${PORT:-5205} node "bench/verify/$s.mjs" >> "$LOG" 2>&1 || echo "!!! $s exited with $?" | tee -a "$LOG"
done
echo "##### done ($(date +%T))" | tee -a "$LOG"
