import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker, { type Env } from "./index.js";

const FIREBASE_URL = "https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword";
const SOS_API_BASE_URL = "https://sos.example.test";
const DISCORD_WEBHOOK_URL = "https://discord.example.test/webhook";
const PROJECT_ID = "project-1";
const STATE_KEY = "test-seen";

type FetchCall = {
  body: string | null;
  method: string;
  url: string;
};

class MemoryKv {
  readonly store = new Map<string, string>();

  async get<T>(key: string, type?: "json"): Promise<T | string | null> {
    const value = this.store.get(key);
    if (!value) {
      return null;
    }

    return type === "json" ? (JSON.parse(value) as T) : value;
  }

  async put(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }
}

function makeNotice(id: string, deliveredAt: string, title = `Notice ${id}`) {
  return {
    id,
    title,
    owner: {
      id: "owner-1",
      name: "Owner",
      avatarFileId: null,
    },
    ownerBureau: "本部",
    deliveredAt,
    isRead: false,
  };
}

function makeEnv(kv = new MemoryKv()): Env {
  return {
    SOS_EMAIL: "user@example.test",
    SOS_PASSWORD: "password",
    SOS_PROJECT_ID: PROJECT_ID,
    DISCORD_WEBHOOK_URL,
    NOTICE_STATE: kv as unknown as KVNamespace,
    FIREBASE_API_KEY: "firebase-key",
    NOTICE_STATE_KEY: STATE_KEY,
    SOS_API_BASE_URL,
  };
}

function installFetchMock(
  notices: ReturnType<typeof makeNotice>[],
  details: Record<string, ReturnType<typeof makeNotice> & { body: string; attachments: unknown[] }>,
) {
  const calls: FetchCall[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : input.toString();
    calls.push({
      body: typeof init?.body === "string" ? init.body : null,
      method: init?.method || "GET",
      url,
    });

    if (url.startsWith(FIREBASE_URL)) {
      return Response.json({
        idToken: "id-token",
        refreshToken: "refresh-token",
        expiresIn: "3600",
      });
    }

    if (url === `${SOS_API_BASE_URL}/project/${PROJECT_ID}/notices`) {
      return Response.json({ notices });
    }

    const detailPrefix = `${SOS_API_BASE_URL}/project/${PROJECT_ID}/notices/`;
    if (url.startsWith(detailPrefix)) {
      const noticeId = url.slice(detailPrefix.length);
      return Response.json({ notice: details[noticeId] });
    }

    if (url === DISCORD_WEBHOOK_URL) {
      return new Response(null, { status: 204 });
    }

    return new Response(`Unexpected URL: ${url}`, { status: 500 });
  });

  vi.stubGlobal("fetch", fetchMock);
  return { calls, fetchMock };
}

describe("SOS Discord notifier", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("initializes state on first run without posting existing notices", async () => {
    const kv = new MemoryKv();
    const env = makeEnv(kv);
    const notices = [
      makeNotice("notice-1", "2026-06-01T00:00:00.000Z"),
      makeNotice("notice-2", "2026-06-01T01:00:00.000Z"),
    ];
    const { calls } = installFetchMock(notices, {});

    const response = await worker.fetch(new Request("https://worker.example.test/"), env);

    await expect(response.json()).resolves.toEqual({
      checkedCount: 2,
      initialized: true,
      postedCount: 0,
      postedTitles: [],
    });
    expect(JSON.parse(kv.store.get(STATE_KEY) ?? "{}")).toEqual({
      seenNoticeIds: ["notice-1", "notice-2"],
    });
    expect(calls.some((call) => call.url === DISCORD_WEBHOOK_URL)).toBe(false);
  });

  it("posts only unseen notices with fetched details, oldest first", async () => {
    const kv = new MemoryKv();
    kv.store.set(STATE_KEY, JSON.stringify({ seenNoticeIds: ["notice-1"] }));
    const env = makeEnv(kv);
    const notices = [
      makeNotice("notice-3", "2026-06-01T03:00:00.000Z", "Newer"),
      makeNotice("notice-1", "2026-06-01T00:00:00.000Z", "Seen"),
      makeNotice("notice-2", "2026-06-01T02:00:00.000Z", "Older"),
    ];
    const details = {
      "notice-2": {
        ...notices[2],
        body: [
          "<h2>重要</h2>",
          '<p><strong>太字</strong>と<em>斜体</em>、<a href="https://example.test">詳細</a></p>',
          "<blockquote>引用&amp;補足</blockquote>",
          "<ul><li>持ち物</li><li><code>student-id</code></li></ul>",
        ].join(""),
        attachments: [
          {
            fileName: "guide.pdf",
          },
        ],
      },
      "notice-3": {
        ...notices[0],
        body: "<p>追加本文</p>",
        attachments: [],
      },
    };
    const { calls } = installFetchMock(notices, details);

    const response = await worker.fetch(new Request("https://worker.example.test/"), env);

    await expect(response.json()).resolves.toEqual({
      checkedCount: 3,
      initialized: false,
      postedCount: 2,
      postedTitles: ["Older", "Newer"],
    });

    const discordCalls = calls.filter((call) => call.url === DISCORD_WEBHOOK_URL);
    expect(discordCalls).toHaveLength(2);
    expect(discordCalls.map((call) => JSON.parse(call.body ?? "{}").embeds[0].title)).toEqual([
      "Older",
      "Newer",
    ]);
    expect(discordCalls.map((call) => JSON.parse(call.body ?? "{}").embeds[0].color)).toEqual([
      0x2563eb, 0x2563eb,
    ]);
    expect(discordCalls.map((call) => JSON.parse(call.body ?? "{}").embeds[0].footer)).toEqual([
      undefined,
      undefined,
    ]);
    const firstDescription = JSON.parse(discordCalls[0]?.body ?? "{}").embeds[0].description;
    expect(firstDescription).toContain("**重要**");
    expect(firstDescription).toContain("**太字**と*斜体*、[詳細](https://example.test)");
    expect(firstDescription).toContain("> 引用&補足");
    expect(firstDescription).toContain("- `student-id`");
    expect(firstDescription).toContain("添付: guide.pdf");
    expect(firstDescription).toContain(
      "詳細は[SOSのお知らせページ](https://sos26.sohosai.com/project/notice)を確認してください。",
    );
    expect(JSON.parse(kv.store.get(STATE_KEY) ?? "{}")).toEqual({
      seenNoticeIds: ["notice-3", "notice-1", "notice-2"],
    });
  });

  it("limits Discord embed descriptions to the embed description size", async () => {
    const kv = new MemoryKv();
    kv.store.set(STATE_KEY, JSON.stringify({ seenNoticeIds: [] }));
    const env = makeEnv(kv);
    const notices = [makeNotice("notice-1", "2026-06-01T00:00:00.000Z", "Long")];
    const details = {
      "notice-1": {
        ...notices[0],
        body: `<p>${"a".repeat(5000)}</p>`,
        attachments: [],
      },
    };
    const { calls } = installFetchMock(notices, details);

    await worker.fetch(new Request("https://worker.example.test/"), env);

    const discordCall = calls.find((call) => call.url === DISCORD_WEBHOOK_URL);
    const description = JSON.parse(discordCall?.body ?? "{}").embeds[0].description;
    expect(description).toHaveLength(4096);
    expect(description).toContain("…");
    expect(
      description.endsWith(
        "詳細は[SOSのお知らせページ](https://sos26.sohosai.com/project/notice)を確認してください。",
      ),
    ).toBe(true);
  });

  it("runs the same check from the scheduled handler", async () => {
    const kv = new MemoryKv();
    const env = makeEnv(kv);
    const notices = [makeNotice("notice-1", "2026-06-01T00:00:00.000Z")];
    installFetchMock(notices, {});
    const waitUntil = vi.fn<(promise: Promise<unknown>) => void>();

    worker.scheduled({} as ScheduledController, env, {
      waitUntil,
    } as unknown as ExecutionContext);

    expect(waitUntil).toHaveBeenCalledTimes(1);
    await waitUntil.mock.calls[0]?.[0];
    expect(JSON.parse(kv.store.get(STATE_KEY) ?? "{}")).toEqual({
      seenNoticeIds: ["notice-1"],
    });
  });
});
