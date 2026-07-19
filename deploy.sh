#!/usr/bin/env bash
# Деплой inverter-monitor на Raspberry Pi.
# Использование: [PI_HOST=pi@192.168.1.112] [SSH_KEY=~/.ssh/pi_key] ./deploy.sh
set -euo pipefail
cd "$(dirname "$0")"

PI_HOST="${PI_HOST:-pi@192.168.1.112}"
PI_DIR="/home/pi/inverter-monitor"

SSH=(ssh)
RSYNC_SSH="ssh"
if [ -n "${SSH_KEY:-}" ]; then
  SSH=(ssh -i "$SSH_KEY")
  RSYNC_SSH="ssh -i $SSH_KEY"
fi

echo "==> Сборка (shared + server + web)"
npm run build
npm run check

echo "==> rsync на $PI_HOST:$PI_DIR"
rsync -az --relative --delete -e "$RSYNC_SSH" \
  package.json package-lock.json \
  shared/package.json shared/dist \
  server/package.json server/dist server/systemd server/.env.example \
  web/package.json web/out \
  "$PI_HOST:$PI_DIR/"

echo "==> Установка и рестарт на Pi"
"${SSH[@]}" "$PI_HOST" bash -s <<EOF
set -euo pipefail
cd "$PI_DIR"
# Одноразовая миграция со старой раскладки (безопасна при повторных запусках)
if [ -d data ] && [ ! -e server/data ]; then mv data server/data; fi
if [ -f .env ] && [ ! -e server/.env ]; then mv .env server/.env; fi
rm -rf dist src public
npm ci -w server --omit=dev
sudo cp server/systemd/inverter-monitor.service /etc/systemd/system/inverter-monitor.service
sudo systemctl daemon-reload
sudo systemctl restart inverter-monitor
EOF

echo "==> Health-check (под может рестартовать до минуты)"
HOST_ONLY="${PI_HOST#*@}"
for i in $(seq 1 30); do
  code=$(curl -s -o /dev/null -w '%{http_code}' "http://$HOST_ONLY:3000/api/health" || true)
  # 200 = auth выключена, 401 = auth включена; оба значат «сервер жив»
  if [ "$code" = "200" ] || [ "$code" = "401" ]; then
    echo "OK (HTTP $code)"
    exit 0
  fi
  sleep 2
done
echo "FAIL: сервер не ответил за 60 с — смотри: ssh $PI_HOST journalctl -u inverter-monitor -n 50" >&2
exit 1
