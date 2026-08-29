import { EventEmitter } from "events";
import { MqttNodeLink, type MqttClientLike } from "./mqtt";

class FakeClient extends EventEmitter implements MqttClientLike {
  subs: string[] = [];
  pubs: { topic: string; payload: string; retain: boolean; qos: number }[] = [];
  ended = false;
  subscribe(topic: string): void {
    this.subs.push(topic);
  }
  publish(topic: string, payload: string, opts: { qos: 0 | 1 | 2; retain: boolean }): void {
    this.pubs.push({ topic, payload, retain: opts.retain, qos: opts.qos });
  }
  end(): void {
    this.ended = true;
  }
  /** Сообщение «от брокера». */
  msg(topic: string, payload: string): void {
    this.emit("message", topic, Buffer.from(payload));
  }
}

const NOW = Date.UTC(2026, 7, 30, 12, 0, 0);

function make() {
  const client = new FakeClient();
  let now = NOW;
  const connectArgs: unknown[] = [];
  const link = new MqttNodeLink({
    url: "mqtt://broker:1883",
    user: "dryer-service",
    pass: "secret",
    prefix: "dryer",
    connect: (url, opts) => {
      connectArgs.push(url, opts);
      return client;
    },
    now: () => now,
  });
  link.start();
  client.emit("connect");
  const online = () => {
    client.msg("dryer/status", "online");
    client.msg("dryer/text_sensor/state/state", "drying");
  };
  return { client, link, connectArgs, online, setNow: (t: number) => (now = t) };
}

describe("MqttNodeLink", () => {
  it("подключается с учёткой и подписывается на весь префикс", () => {
    const { client, connectArgs } = make();
    expect(connectArgs[0]).toBe("mqtt://broker:1883");
    expect(connectArgs[1]).toMatchObject({ username: "dryer-service", password: "secret", reconnectPeriod: 5000 });
    expect(client.subs).toEqual(["dryer/#"]);
  });

  it("собирает снапшот из сенсоров; nan → null; неизвестное состояние → null", () => {
    const { client, link, online } = make();
    online();
    client.msg("dryer/sensor/chamber_temperature/state", "58.2");
    client.msg("dryer/sensor/chamber_humidity/state", "42.1");
    client.msg("dryer/sensor/ambient_temperature/state", "23.4");
    client.msg("dryer/sensor/ambient_humidity/state", "55");
    client.msg("dryer/sensor/plate_temperature/state", "84");
    client.msg("dryer/sensor/humidity_excess/state", "6.2");
    client.msg("dryer/sensor/heater_duty/state", "71");
    client.msg("dryer/sensor/exhaust_duty/state", "50");
    client.msg("dryer/sensor/exhaust_rpm/state", "nan");
    client.msg("dryer/sensor/run_elapsed/state", "11520");
    client.msg("dryer/sensor/setpoint/state", "60");
    client.msg("dryer/sensor/max_minutes/state", "840");
    client.msg("dryer/sensor/uptime/state", "12345");
    client.msg("dryer/text_sensor/stop_reason/state", "command");
    const v = link.view(NOW, 60_000);
    expect(v).toEqual({
      online: true,
      updatedAt: NOW,
      state: "drying",
      stopReason: "command",
      chamber: { temp: 58.2, rh: 42.1 },
      ambient: { temp: 23.4, rh: 55 },
      plateTemp: 84,
      excess: 6.2,
      heaterDuty: 71,
      exhaustDuty: 50,
      exhaustRpm: null,
      runElapsed: 11520,
      setpoint: 60,
      maxMinutes: 840,
    });
    expect(link.uptime()).toBe(12345);
    client.msg("dryer/text_sensor/state/state", "weird");
    expect(link.view(NOW, 60_000).state).toBeNull();
  });

  it("offline по LWT и по тишине дольше staleAfterMs", () => {
    const { client, link, online, setNow } = make();
    online();
    expect(link.view(NOW, 60_000).online).toBe(true);
    setNow(NOW + 61_000);
    expect(link.view(NOW + 61_000, 60_000).online).toBe(false);
    expect(link.view(NOW + 61_000, 60_000).state).toBe("drying"); // последние известные значения остаются
    client.msg("dryer/status", "offline");
    expect(link.view(NOW + 61_000, 600_000).online).toBe(false);
  });

  it("чужие топики и мусор игнорирует", () => {
    const { client, link } = make();
    client.msg("heating/boiler/status", "online");
    client.msg("dryer/sensor/chamber_temperature", "1"); // без /state
    client.msg("dryer/sensor/chamber_temperature/state", "abc");
    const v = link.view(NOW, 60_000);
    expect(v.online).toBe(false);
    expect(v.chamber.temp).toBeNull();
  });

  it("публикует cfg retained и cmd/run НЕ retained", () => {
    const { client, link } = make();
    link.publishCfg({ setpoint: 60, maxMinutes: 840, exhaustMin: 25, exhaustGain: 4 });
    link.sendRun("START");
    expect(client.pubs).toEqual([
      { topic: "dryer/cfg/setpoint", payload: "60", retain: true, qos: 1 },
      { topic: "dryer/cfg/max_minutes", payload: "840", retain: true, qos: 1 },
      { topic: "dryer/cfg/exhaust_min", payload: "25", retain: true, qos: 1 },
      { topic: "dryer/cfg/exhaust_gain", payload: "4", retain: true, qos: 1 },
      { topic: "dryer/cmd/run", payload: "START", retain: false, qos: 1 },
    ]);
  });

  it("connected() следит за connect/close; stop() закрывает клиента", () => {
    const { client, link } = make();
    expect(link.connected()).toBe(true);
    client.emit("close");
    expect(link.connected()).toBe(false);
    link.stop();
    expect(client.ended).toBe(true);
    expect(link.connected()).toBe(false);
  });
});
