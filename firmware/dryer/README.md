# Прошивка ноды сушилки (ESPHome)

Спека: `docs/superpowers/specs/2026-08-30-dryer-design.md` (§5 контракт MQTT, §6 железо, §7 поведение).

## Сборка и заливка (Docker, на машине разработки)

```bash
cd firmware/dryer
cp secrets.example.yaml secrets.yaml && $EDITOR secrets.yaml
# проверка конфига без сборки
docker run --rm -v "$PWD":/config ghcr.io/esphome/esphome config dryer.yaml
# первая заливка по USB (плата подключена, порт может быть /dev/ttyUSB0 или /dev/ttyACM0)
docker run --rm -v "$PWD":/config --device=/dev/ttyUSB0 ghcr.io/esphome/esphome run dryer.yaml --device /dev/ttyUSB0
# дальше — OTA по IP ноды
docker run --rm -v "$PWD":/config ghcr.io/esphome/esphome run dryer.yaml --device <ip ноды>
# логи
docker run --rm -v "$PWD":/config ghcr.io/esphome/esphome logs dryer.yaml --device <ip ноды>
```

Каталог `.esphome/` (кэш сборки) и `secrets.yaml` в git не попадают.

## Распиновка (спека §6)

| Назначение | GPIO |
|---|---|
| SHT41 камера | SDA 21, SCL 22 |
| SHT41 комната | SDA 25, SCL 26 |
| NTC пластины (делитель 10 кОм на 3V3, NTC на GND) | 34 |
| SSR «+» | 27 (SSR «−» → GND) |
| Циркуляция (MOSFET) | 32 |
| Вытяжка ШИМ 25 кГц (MOSFET) | 33 |
| Тахометр вытяжки (подтяжка 10 кОм, 10 кОм последовательно + стабилитрон 3.3 В) | 35 |
| Кнопка → GND | 4 |
| Светодиод через 330 Ом | 16 |
| Зарезервировано под LCD 1602 | 13, 14, 17, 18, 19, 23 |

## Проверка контракта

```bash
mosquitto_sub -h 192.168.1.112 -u dryer-service -P '…' -t 'dryer/#' -v
```
Каждые 10 с должны идти все сенсоры и `text_sensor/state`. Запуск руками:
`mosquitto_pub … -t dryer/cfg/setpoint -m 60 -r` (и остальные `cfg/*`), затем
`mosquitto_pub … -t dryer/cmd/run -m START` — в течение секунды `state` = `heating`.

## PID

Стартовые `kp/ki/kd` — оценка. Автотюнинг на корпусе: временно добавить в yaml
`button: - platform: template, name: autotune, on_press: climate.pid.autotune: pid_ctrl`,
запустить при 60 °C и пустой камере, дождаться в логах «PID Autotune finished», перенести
коэффициенты в `control_parameters`, убрать кнопку. Если не сойдётся — заменить `climate: pid`
на `climate: thermostat` с `heat_deadband: 0.5` и `heat_overrun: 0.5` (гистерезис 1 °C).
