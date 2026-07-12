#!/bin/sh
# scripts/weekend-probe.sh — one-shot Sunday job (installed via crontab).
# Maps Dhan's sustained chain-rate ceiling with the app stopped (markets
# closed, nothing else shares the limiter), applies the probe's recommended
# CHAIN_BUDGET_RPS for Monday if it passes guardrails, restarts the app,
# and removes its own cron entry. Everything logs to ~/pta/weekend-probe-*.log.
#
# Install (one-shot for Sunday 2026-07-12 10:00 IST = 04:30 UTC):
#   (crontab -l 2>/dev/null; echo "30 4 12 7 * /home/ubuntu/pta/scripts/weekend-probe.sh") | crontab -

LOG=/home/ubuntu/pta/weekend-probe-$(date +%F).log
exec >> "$LOG" 2>&1
set -x
cd /home/ubuntu/pta || exit 1
date -u

git pull
docker compose stop app

# Fresh scripts bind-mounted over the image copy (image may predate the probe)
docker compose run --rm -v /home/ubuntu/pta/scripts:/app/scripts app \
  node scripts/probe-sustained.js > /tmp/sustained-probe-out.txt 2>&1
cat /tmp/sustained-probe-out.txt

REC=$(grep -oE "CHAIN_BUDGET_RPS=[0-9.]+" /tmp/sustained-probe-out.txt | cut -d= -f2 | head -1)
SANE=$(echo "${REC:-0}" | awk '{ print ($1 >= 0.05 && $1 <= 0.45) ? "y" : "n" }')
if [ "$SANE" = "y" ]; then
  grep -q "^CHAIN_BUDGET_RPS=" .env \
    && sed -i "s/^CHAIN_BUDGET_RPS=.*/CHAIN_BUDGET_RPS=$REC/" .env \
    || echo "CHAIN_BUDGET_RPS=$REC" >> .env
  echo "APPLIED CHAIN_BUDGET_RPS=$REC for Monday"
else
  echo "No sane recommendation ('$REC') — keeping the existing budget"
fi

docker compose up -d app
sleep 90
docker compose logs app --since 3m | grep -E "Chain scheduler|Token|Reusing"

# one-shot: remove this job from crontab
crontab -l | grep -v "weekend-probe.sh" | crontab -
echo "WEEKEND_PROBE_DONE"
