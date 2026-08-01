#!/usr/bin/env bash
# Деплой sweethome на Raspberry Pi.
# Использование: [PI_HOST=pi@raspberrypi.local] [SSH_KEY=~/.ssh/pi_key] ./deploy.sh
set -euo pipefail
cd "$(dirname "$0")"

PI_HOST="${PI_HOST:-pi@raspberrypi.local}"
PI_DIR="/home/pi/sweethome"
OLD_DIR="/home/pi/inverter-monitor"

SSH=(ssh)
RSYNC_SSH="ssh"
if [ -n "${SSH_KEY:-}" ]; then
  SSH=(ssh -i "$SSH_KEY")
  RSYNC_SSH="ssh -i $SSH_KEY"
fi

echo "==> Сборка (packages + modules + server + web)"
npm run build
npm run check

echo "==> Одноразовая миграция каталога на Pi (безопасна при повторных запусках)"
"${SSH[@]}" "$PI_HOST" bash -s <<EOF
set -euo pipefail
if [ -d "$OLD_DIR" ] && [ ! -d "$PI_DIR" ]; then
  sudo systemctl disable --now inverter-monitor 2>/dev/null || true
  mv "$OLD_DIR" "$PI_DIR"
  # Раскладка данных: модульные файлы инвертора уезжают в data/inverter/
  mkdir -p "$PI_DIR/server/data/inverter"
  [ -f "$PI_DIR/server/data/stats.db" ] && mv "$PI_DIR/server/data/stats.db" "$PI_DIR/server/data/inverter/stats.db" || true
  [ -f "$PI_DIR/server/data/baseline.json" ] && mv "$PI_DIR/server/data/baseline.json" "$PI_DIR/server/data/inverter/baseline.json" || true
  sudo rm -f /etc/systemd/system/inverter-monitor.service
fi
EOF

echo "==> rsync на $PI_HOST:$PI_DIR"
rsync -az --relative --delete -e "$RSYNC_SSH" \
  package.json package-lock.json \
  packages/shared/package.json packages/shared/dist \
  packages/inverter-shared/package.json packages/inverter-shared/dist \
  packages/inverter-mcp/package.json packages/inverter-mcp/dist \
  modules/inverter/package.json modules/inverter/dist \
  server/package.json server/dist server/systemd server/.env.example \
  web/package.json web/out \
  "$PI_HOST:$PI_DIR/"

echo "==> Установка и рестарт на Pi"
"${SSH[@]}" "$PI_HOST" bash -s <<EOF
set -euo pipefail
cd "$PI_DIR"
rm -rf shared mcp   # каталоги старой раскладки, если остались
npm ci -w server -w modules/inverter -w packages/inverter-mcp --omit=dev
sudo cp server/systemd/sweethome.service /etc/systemd/system/sweethome.service
sudo systemctl daemon-reload
sudo systemctl enable sweethome >/dev/null 2>&1 || true
sudo systemctl restart sweethome
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
echo "FAIL: сервер не ответил за 60 с — смотри: ssh $PI_HOST journalctl -u sweethome -n 50" >&2
exit 1
