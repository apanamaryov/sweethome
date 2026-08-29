# Сушилка — эксплуатация

Спека: `docs/superpowers/specs/2026-08-30-dryer-design.md`. Модуль: `modules/dryer/README.md`.
Прошивка: `firmware/dryer/README.md`.

## Брокер MQTT на малине (разово)

`apt install mosquitto mosquitto-clients`; конфиг `/etc/mosquitto/conf.d/sweethome.conf`
(слушатель `1883` на всех интерфейсах — ноде нужен доступ из сети; анонимов нет;
persistence уже включён в дефолтном `/etc/mosquitto/mosquitto.conf` (`persistence true`,
`persistence_location /var/lib/mosquitto/`), поэтому retained переживают перезагрузку без
доп. настроек в `conf.d`); ACL `/etc/mosquitto/acl`:
`dryer-node` пишет `dryer/status|sensor|text_sensor|binary_sensor`, читает `dryer/cmd/#` и
`dryer/cfg/#`; `dryer-service` — всё в `dryer/#`. Пароли — `mosquitto_passwd`, файл `600`,
владелец `mosquitto`. Проверка: `mosquitto_sub -u dryer-service -P … -t 'dryer/#' -v`.

`deploy.sh` только предупреждает, если `mosquitto` не активен: инвертор и камеры без него
работают, сушилка покажет `ok: false` с причиной `broker` в `/api/health`.

## Сеть

DHCP-резервации на роутере для малины (`192.168.1.112`) и ноды. В прошивке брокер задан
IP малины, не mDNS.

## `.env` на малине

```
DRYER_TRANSPORT=mqtt
DRYER_MQTT_URL=mqtt://127.0.0.1:1883
DRYER_MQTT_USER=dryer-service
DRYER_MQTT_PASS=<пароль>
DRYER_MQTT_PREFIX=dryer
```

## Диагностика

- Весь обмен: `mosquitto_sub -u dryer-service -P … -t 'dryer/#' -v` — сенсоры должны идти
  каждые 10 с.
- Логи ноды: `mosquitto_sub … -t dryer/debug -v`.
- Здоровье модуля: `curl -s -H 'Authorization: Bearer …' http://192.168.1.112:3000/api/health`
  → `modules.dryer`.
- Логи сервиса: `journalctl -u sweethome -f | grep dryer`.

## Настольный стенд и первые прогоны

См. спеку §12 — чеклист повторён в задаче 18 плана `docs/superpowers/plans/2026-08-30-dryer.md`.
