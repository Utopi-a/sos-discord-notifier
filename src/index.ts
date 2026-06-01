const DEFAULT_FIREBASE_API_KEY = "AIzaSyCpf-MZY12Q1CvjMOSait5z_FD3jFMXV1U";
const DEFAULT_SOS_API_BASE_URL = "https://sos26-api.sohosai.com";
const DEFAULT_STATE_KEY = "seen-notice-ids";

export type Env = {
  SOS_EMAIL: string;
  SOS_PASSWORD: string;
  SOS_PROJECT_ID: string;
  DISCORD_WEBHOOK_URL: string;
  NOTICE_STATE: KVNamespace;
  FIREBASE_API_KEY?: string;
  NOTICE_STATE_KEY?: string;
  SOS_API_BASE_URL?: string;
};

type FirebaseSignInResponse = {
  idToken: string;
  refreshToken: string;
  expiresIn: string;
};

type Notice = {
  id: string;
  title: string;
  owner: {
    id: string;
    name: string;
    avatarFileId: string | null;
  };
  ownerBureau: string;
  deliveredAt: string;
  isRead: boolean;
};

type NoticesResponse = {
  notices: Notice[];
};

type NoticeDetail = Notice & {
  body: string | null;
  attachments: {
    id: string;
    fileId: string;
    fileName: string;
    mimeType: string;
    size: number;
    isPublic: boolean;
    createdAt: string;
  }[];
};

type NoticeDetailResponse = {
  notice: NoticeDetail;
};

type State = {
  seenNoticeIds: string[];
};

type CheckResult = {
  checkedCount: number;
  initialized: boolean;
  postedCount: number;
  postedTitles: string[];
};

type Config = {
  firebaseApiKey: string;
  sosApiBaseUrl: string;
  stateKey: string;
};

function getConfig(env: Env): Config {
  return {
    firebaseApiKey: env.FIREBASE_API_KEY || DEFAULT_FIREBASE_API_KEY,
    sosApiBaseUrl: env.SOS_API_BASE_URL || DEFAULT_SOS_API_BASE_URL,
    stateKey: env.NOTICE_STATE_KEY || DEFAULT_STATE_KEY,
  };
}

async function readState(kv: KVNamespace, stateKey: string): Promise<State | null> {
  return kv.get<State>(stateKey, "json");
}

async function writeState(kv: KVNamespace, stateKey: string, state: State): Promise<void> {
  await kv.put(stateKey, JSON.stringify(state));
}

async function signInWithPassword(env: Env): Promise<FirebaseSignInResponse> {
  const config = getConfig(env);
  const response = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${config.firebaseApiKey}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: env.SOS_EMAIL,
        password: env.SOS_PASSWORD,
        returnSecureToken: true,
      }),
    },
  );

  if (!response.ok) {
    throw new Error(`Firebase sign-in failed: ${response.status} ${await response.text()}`);
  }

  return (await response.json()) as FirebaseSignInResponse;
}

async function fetchNotices(config: Config, projectId: string, idToken: string): Promise<Notice[]> {
  const response = await fetch(`${config.sosApiBaseUrl}/project/${projectId}/notices`, {
    headers: {
      accept: "application/json",
      authorization: `Bearer ${idToken}`,
    },
  });

  if (!response.ok) {
    throw new Error(`SOS notices request failed: ${response.status} ${await response.text()}`);
  }

  const data = (await response.json()) as NoticesResponse;
  return data.notices;
}

async function fetchNoticeDetail(
  config: Config,
  projectId: string,
  noticeId: string,
  idToken: string,
): Promise<NoticeDetail> {
  const response = await fetch(`${config.sosApiBaseUrl}/project/${projectId}/notices/${noticeId}`, {
    headers: {
      accept: "application/json",
      authorization: `Bearer ${idToken}`,
    },
  });

  if (!response.ok) {
    throw new Error(
      `SOS notice detail request failed: ${response.status} ${await response.text()}`,
    );
  }

  const data = (await response.json()) as NoticeDetailResponse;
  return data.notice;
}

function htmlToDiscordText(html: string | null): string {
  if (!html) {
    return "";
  }

  const placeholders: string[] = [];
  const protect = (value: string) => {
    const index = placeholders.push(value) - 1;
    return `%%SOS_NOTICE_MARKDOWN_${index}%%`;
  };

  const restorePlaceholders = (value: string) =>
    value.replace(/%%SOS_NOTICE_MARKDOWN_(\d+)%%/g, (_, index: string) => {
      return placeholders[Number(index)] || "";
    });

  return restorePlaceholders(
    html
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
      .replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_, content: string) =>
        protect(`\`\`\`\n${htmlToDiscordText(content)}\n\`\`\``),
      )
      .replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (_, content: string) =>
        protect(`\`${htmlToDiscordText(content).replace(/`/g, "\\`")}\``),
      )
      .replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, "**$2**")
      .replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi, "*$2*")
      .replace(/<(s|strike|del)\b[^>]*>([\s\S]*?)<\/\1>/gi, "~~$2~~")
      .replace(/<u\b[^>]*>([\s\S]*?)<\/u>/gi, "__$1__")
      .replace(/<h[1-6]\b[^>]*>([\s\S]*?)<\/h[1-6]>/gi, "\n**$1**\n")
      .replace(/<a\b[^>]*href=(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi, (_, _quote, href, text) => {
        const label = htmlToDiscordText(text);
        return label ? `[${label}](${decodeHtmlEntities(href)})` : decodeHtmlEntities(href);
      })
      .replace(/<blockquote\b[^>]*>([\s\S]*?)<\/blockquote>/gi, (_, content: string) =>
        htmlToDiscordText(content)
          .split("\n")
          .filter(Boolean)
          .map((line) => `> ${line}`)
          .join("\n"),
      )
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<li\b[^>]*>/gi, "\n- ")
      .replace(/<\/li>/gi, "\n")
      .replace(/<\/(p|div|section|article|ul|ol)>/gi, "\n")
      .replace(/<(p|div|section|article|ul|ol)\b[^>]*>/gi, "")
      .replace(/<[^>]*>/g, ""),
  )
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/gi, "'");
}

function truncateForDiscord(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength - 1)}…`;
}

async function postToDiscord(webhookUrl: string, notice: NoticeDetail): Promise<void> {
  const deliveredAt = new Date(notice.deliveredAt).toLocaleString("ja-JP", {
    timeZone: "Asia/Tokyo",
  });
  const body = htmlToDiscordText(notice.body);
  const attachmentText =
    notice.attachments.length > 0
      ? `\n\n添付: ${notice.attachments.map((attachment) => attachment.fileName).join(", ")}`
      : "";

  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      embeds: [
        {
          title: notice.title,
          description: truncateForDiscord(
            [`${notice.ownerBureau} / ${deliveredAt}`, body, attachmentText]
              .filter(Boolean)
              .join("\n\n"),
            4096,
          ),
          color: notice.isRead ? 0x64748b : 0xef4444,
        },
      ],
    }),
  });

  if (!response.ok) {
    throw new Error(`Discord webhook failed: ${response.status} ${await response.text()}`);
  }
}

async function checkOnce(env: Env): Promise<CheckResult> {
  const config = getConfig(env);
  const auth = await signInWithPassword(env);
  const notices = await fetchNotices(config, env.SOS_PROJECT_ID, auth.idToken);
  const state = await readState(env.NOTICE_STATE, config.stateKey);

  if (!state) {
    await writeState(env.NOTICE_STATE, config.stateKey, {
      seenNoticeIds: notices.map((notice) => notice.id),
    });
    return {
      checkedCount: notices.length,
      initialized: true,
      postedCount: 0,
      postedTitles: [],
    };
  }

  const seen = new Set(state.seenNoticeIds);
  const newNotices = notices
    .filter((notice) => !seen.has(notice.id))
    .sort((a, b) => Date.parse(a.deliveredAt) - Date.parse(b.deliveredAt));

  const postedTitles: string[] = [];
  for (const notice of newNotices) {
    const detail = await fetchNoticeDetail(config, env.SOS_PROJECT_ID, notice.id, auth.idToken);
    await postToDiscord(env.DISCORD_WEBHOOK_URL, detail);
    seen.add(notice.id);
    postedTitles.push(notice.title);
    console.log(`Posted: ${notice.title}`);
  }

  await writeState(env.NOTICE_STATE, config.stateKey, {
    seenNoticeIds: notices.map((notice) => notice.id),
  });
  return {
    checkedCount: notices.length,
    initialized: false,
    postedCount: newNotices.length,
    postedTitles,
  };
}

export default {
  async fetch(_request: Request, env: Env): Promise<Response> {
    const result = await checkOnce(env);
    return Response.json(result);
  },

  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(
      checkOnce(env).then((result) => {
        console.log(JSON.stringify(result));
      }),
    );
  },
};
