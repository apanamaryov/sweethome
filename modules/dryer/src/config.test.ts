import path from "path";
import { loadDryerConfig } from "./config";

describe("loadDryerConfig", () => {
  it("значения по умолчанию соответствуют спеке §8", () => {
    const cfg = loadDryerConfig("/data", {});
    expect(cfg).toEqual({
      enabled: true,
      transport: "mqtt",
      mqttUrl: "mqtt://127.0.0.1:1883",
      mqttUser: null,
      mqttPass: null,
      prefix: "dryer",
      dataDir: path.join("/data", "dryer"),
      tickMs: 10_000,
    });
  });

  it("переопределения из env применяются", () => {
    const cfg = loadDryerConfig("/data", {
      DRYER_TRANSPORT: "mock",
      DRYER_MQTT_URL: "mqtt://broker:1884",
      DRYER_MQTT_USER: "u",
      DRYER_MQTT_PASS: "p",
      DRYER_MQTT_PREFIX: "home/dryer",
      DRYER_TICK_MS: "500",
    });
    expect(cfg.transport).toBe("mock");
    expect(cfg.mqttUrl).toBe("mqtt://broker:1884");
    expect(cfg.mqttUser).toBe("u");
    expect(cfg.mqttPass).toBe("p");
    expect(cfg.prefix).toBe("home/dryer");
    expect(cfg.tickMs).toBe(500);
  });

  it("DRYER_ENABLED=false выключает модуль; неизвестный транспорт откатывается на mqtt", () => {
    expect(loadDryerConfig("/data", { DRYER_ENABLED: "false" }).enabled).toBe(false);
    expect(loadDryerConfig("/data", { DRYER_TRANSPORT: "serial" }).transport).toBe("mqtt");
  });

  it("срезает хвостовой слэш у префикса", () => {
    expect(loadDryerConfig("/data", { DRYER_MQTT_PREFIX: "dryer/" }).prefix).toBe("dryer");
  });
});
