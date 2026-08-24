import { DEFAULT_RTSP_PATH, type CameraConfig } from "../config";
import { CctvDb } from "../index/db";
import { MOTION_TOPIC, MotionWatcher, parseNotifications, subscriptionAddress } from "./onvif";

const cam: CameraConfig = { id: "drive", name: "drive", host: "10.0.0.1", rtspPath: DEFAULT_RTSP_PATH };

const SUB_OK = `<?xml version="1.0"?>
<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope">
 <s:Body><tev:CreatePullPointSubscriptionResponse xmlns:tev="http://www.onvif.org/ver10/events/wsdl">
  <tev:SubscriptionReference><wsa:Address xmlns:wsa="http://www.w3.org/2005/08/addressing">http://10.0.0.1:8899/event_service/3</wsa:Address></tev:SubscriptionReference>
 </tev:CreatePullPointSubscriptionResponse></s:Body></s:Envelope>`;

const motionMsg = (state: string, time = "2026-08-24T10:00:00Z") => `
<wsnt:NotificationMessage xmlns:wsnt="http://docs.oasis-open.org/wsn/b-2">
  <wsnt:Topic Dialect="x">tns1:VideoSource/MotionAlarm</wsnt:Topic>
  <wsnt:Message><tt:Message xmlns:tt="http://www.onvif.org/ver10/schema" UtcTime="${time}">
    <tt:Source><tt:SimpleItem Name="Source" Value="VideoSourceToken"/></tt:Source>
    <tt:Data><tt:SimpleItem Name="State" Value="${state}"/></tt:Data>
  </tt:Message></wsnt:Message>
</wsnt:NotificationMessage>`;

const pullResponse = (...msgs: string[]) => `<?xml version="1.0"?>
<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope"><s:Body>
<tev:PullMessagesResponse xmlns:tev="http://www.onvif.org/ver10/events/wsdl">${msgs.join("")}</tev:PullMessagesResponse>
</s:Body></s:Envelope>`;

describe("subscriptionAddress", () => {
  it("вытаскивает адрес подписки", () => {
    expect(subscriptionAddress(SUB_OK)).toBe("http://10.0.0.1:8899/event_service/3");
  });
  it("на ответе без адреса отдаёт null", () => {
    expect(subscriptionAddress("<s:Envelope/>")).toBeNull();
  });
});

describe("parseNotifications", () => {
  it("разбирает событие движения со временем и состоянием", () => {
    const rows = parseNotifications(pullResponse(motionMsg("true")));
    expect(rows).toEqual([
      { topic: MOTION_TOPIC, state: "true", tsMs: Date.UTC(2026, 7, 24, 10, 0, 0) },
    ]);
  });

  it("разбирает несколько сообщений подряд", () => {
    const rows = parseNotifications(pullResponse(motionMsg("true"), motionMsg("false")));
    expect(rows.map((r) => r.state)).toEqual(["true", "false"]);
  });

  it("на ответе без сообщений отдаёт пусто", () => {
    expect(parseNotifications(pullResponse())).toEqual([]);
    expect(parseNotifications("мусор")).toEqual([]);
  });

  it("отдаёт и посторонние топики — фильтрует уже наблюдатель", () => {
    const other = motionMsg("true").replace(MOTION_TOPIC, "tns1:VideoSource/ImageTooDark/ImagingService");
    expect(parseNotifications(pullResponse(other))[0].topic).toContain("ImageTooDark");
  });
});

describe("MotionWatcher", () => {
  let db: CctvDb;
  beforeEach(() => {
    db = new CctvDb(":memory:");
  });
  afterEach(() => db.close());

  const timers = {
    setTimeout: (cb: () => void) => {
      void cb; // наблюдатель сам себя перезапускает — в тесте цикл не гоняем
      return 1 as unknown;
    },
    clearTimeout: () => {},
    now: () => 0,
  };

  it("создаёт подписку и пишет метку движения", async () => {
    const calls: string[] = [];
    const w = new MotionWatcher({
      cam,
      db,
      timers,
      post: async (url, body) => {
        calls.push(url);
        if (body.includes("CreatePullPointSubscription")) return SUB_OK;
        return pullResponse(motionMsg("true"));
      },
    });
    await w.startOnce();
    expect(calls[0]).toBe("http://10.0.0.1:8899/onvif/event_service");
    expect(calls[1]).toBe("http://10.0.0.1:8899/event_service/3");
    expect(db.motionBetween("drive", 0, Date.UTC(2027, 0, 1))).toEqual([
      { tsMs: Date.UTC(2026, 7, 24, 10, 0, 0), kind: "motion" },
    ]);
    expect(w.state().subscribed).toBe(true);
    expect(w.state().events).toBe(1);
  });

  it("не пишет метку на State=false — это окончание движения", async () => {
    const w = new MotionWatcher({
      cam, db, timers,
      post: async (_url, body) =>
        body.includes("CreatePullPointSubscription") ? SUB_OK : pullResponse(motionMsg("false")),
    });
    await w.startOnce();
    expect(db.motionBetween("drive", 0, Date.UTC(2027, 0, 1))).toEqual([]);
  });

  it("игнорирует посторонние топики", async () => {
    const other = motionMsg("true").replace(MOTION_TOPIC, "tns1:VideoSource/ImageTooDark/ImagingService");
    const w = new MotionWatcher({
      cam, db, timers,
      post: async (_url, body) =>
        body.includes("CreatePullPointSubscription") ? SUB_OK : pullResponse(other),
    });
    await w.startOnce();
    expect(db.motionBetween("drive", 0, Date.UTC(2027, 0, 1))).toEqual([]);
  });

  it("без времени в событии берёт текущее", async () => {
    const noTime = motionMsg("true").replace(' UtcTime="2026-08-24T10:00:00Z"', "");
    const w = new MotionWatcher({
      cam, db, timers, now: () => 777_000,
      post: async (_url, body) =>
        body.includes("CreatePullPointSubscription") ? SUB_OK : pullResponse(noTime),
    });
    await w.startOnce();
    expect(db.motionBetween("drive", 0, 1_000_000)).toEqual([{ tsMs: 777_000, kind: "motion" }]);
  });

  it("провал подписки не бросает наружу, а попадает в состояние", async () => {
    const w = new MotionWatcher({
      cam, db, timers,
      post: async () => {
        throw new Error("connect ECONNREFUSED");
      },
    });
    await w.startOnce();
    expect(w.state().subscribed).toBe(false);
    expect(w.state().lastError).toContain("ECONNREFUSED");
  });

  it("камера без событий — не ошибка", async () => {
    const w = new MotionWatcher({
      cam, db, timers,
      post: async (_url, body) =>
        body.includes("CreatePullPointSubscription") ? SUB_OK : pullResponse(),
    });
    await w.startOnce();
    expect(w.state().subscribed).toBe(true);
    expect(w.state().events).toBe(0);
  });
});
