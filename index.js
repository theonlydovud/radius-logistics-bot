import "dotenv/config";

import axios from "axios";
import * as cheerio from "cheerio";
import { GoogleGenAI } from "@google/genai";

// ============================================================
// CONFIG
// ============================================================

const INSTAGRAM_PROFILE = {
  username: "radius_logistics.uz",
  url: "https://www.instagram.com/radius_logistics.uz/"
};

const SOURCES = [
  {
    name: "LogiStan",
    username: "logistan",
    url: "https://t.me/s/logistan"
  },
  {
    name: "Транспорт и логистика",
    username: "transportandlogistic",
    url: "https://t.me/s/transportandlogistic"
  },
  {
    name: "Логистика и ЖД",
    username: "railway_and_logistics",
    url: "https://t.me/s/railway_and_logistics"
  },
  {
    name: "TRANSASIA LOGISTICS",
    username: "talogistics",
    url: "https://t.me/s/talogistics"
  }
];

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHANNEL_ID = process.env.TELEGRAM_CHANNEL_ID;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const PEXELS_API_KEY = process.env.PEXELS_API_KEY;

const GEMINI_MODEL = "gemini-3.5-flash-lite";

const MAX_POST_LENGTH = 1000;
const POSTS_PER_SOURCE = 20;
const FRESH_HOURS = 24;

const INSTAGRAM_POSTS_TO_CHECK = 12;
const INSTAGRAM_MAX_AGE_DAYS = 14;

const REVIEW_CHAT_ID = 6043514100;

const MAX_LANGUAGE_REPAIRS = 2;

let pendingReview = null;
let lastUpdateId = 0;

// ============================================================
// VALIDATION
// ============================================================

if (!BOT_TOKEN) {
  throw new Error("❌ TELEGRAM_BOT_TOKEN отсутствует в .env");
}

if (!CHANNEL_ID) {
  throw new Error("❌ TELEGRAM_CHANNEL_ID отсутствует в .env");
}

if (!GEMINI_API_KEY) {
  throw new Error("❌ GEMINI_API_KEY отсутствует в .env");
}

if (!PEXELS_API_KEY) {
  throw new Error("❌ PEXELS_API_KEY отсутствует в .env");
}

const ai = new GoogleGenAI({
  apiKey: GEMINI_API_KEY
});

// ============================================================
// TELEGRAM API
// ============================================================

async function telegram(method, data) {
  const response = await fetch(
    `https://api.telegram.org/bot${BOT_TOKEN}/${method}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(data)
    }
  );

  const result = await response.json();

  if (!result.ok) {
    throw new Error(
      `Telegram ${method}: ${result.description || "Unknown error"}`
    );
  }

  return result.result;
}

// ============================================================
// HTTP
// ============================================================

async function getPage(url) {
  const response = await axios.get(url, {
    timeout: 20000,
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140 Safari/537.36",
      "Accept-Language": "en-US,en;q=0.9"
    }
  });

  return response.data;
}

// ============================================================
// CLEAN TEXT
// ============================================================

function cleanText(text) {
  if (!text) return "";

  return text
    .replace(/\u00a0/g, " ")
    .replace(/\r/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ============================================================
// REMOVE GEMINI FENCES / MARKDOWN
// ============================================================

function cleanGeminiOutput(text) {
  if (!text) return "";

  return text
    .replace(/^```(?:text|markdown|html|json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

// ============================================================
// TELEGRAM SOURCES
// ============================================================

async function getTelegramPosts(source) {
  console.log(`\n📡 Читаем @${source.username}...`);

  const html = await getPage(source.url);
  const $ = cheerio.load(html);

  const posts = [];

  $(".tgme_widget_message").each((index, element) => {
    const message = $(element);

    const text =
      message
        .find(".tgme_widget_message_text")
        .first()
        .text()
        .trim() || "";

    const timeElement = message.find("time").first();
    const datetime = timeElement.attr("datetime");

    let date = datetime ? new Date(datetime) : null;

    if (!date || Number.isNaN(date.getTime())) {
      date = null;
    }

    const postLink =
      message
        .find(".tgme_widget_message_date")
        .attr("href") || null;

    if (!text || text.length < 80) {
      return;
    }

    const lower = text.toLowerCase();

    if (
      lower.includes("подписывайтесь на канал") ||
      lower.includes("реклама") ||
      lower.includes("реклам") ||
      lower.includes("разместить рекламу")
    ) {
      return;
    }

    posts.push({
      source: source.name,
      username: source.username,
      text: cleanText(text),
      url: postLink,
      date
    });
  });

  posts.sort((a, b) => {
    const aTime = a.date?.getTime() || 0;
    const bTime = b.date?.getTime() || 0;

    return bTime - aTime;
  });

  const result = posts.slice(0, POSTS_PER_SOURCE);

  console.log(
    `   📰 Найдено подходящих постов: ${result.length}`
  );

  return result;
}

// ============================================================
// COLLECT TELEGRAM NEWS
// ============================================================

async function collectNews() {
  console.log("\n==============================");
  console.log("📡 СОБИРАЕМ TELEGRAM НОВОСТИ");
  console.log("==============================");

  const all = [];

  for (const source of SOURCES) {
    try {
      const posts = await getTelegramPosts(source);
      all.push(...posts);
    } catch (error) {
      console.log(
        `⚠️ Ошибка ${source.name}: ${error.message}`
      );
    }
  }

  all.sort((a, b) => {
    const aTime = a.date?.getTime() || 0;
    const bTime = b.date?.getTime() || 0;

    return bTime - aTime;
  });

  console.log(
    `\n📚 Всего собрано кандидатов: ${all.length}`
  );

  return all;
}

// ============================================================
// REMOVE DUPLICATES
// ============================================================

function removeDuplicates(posts) {
  const result = [];

  for (const post of posts) {
    const normalized = post.text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .trim();

    const words = normalized
      .split(/\s+/)
      .slice(0, 25)
      .join(" ");

    const duplicate = result.some((existing) => {
      const existingNormalized = existing.text
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, " ")
        .trim();

      const existingWords = existingNormalized
        .split(/\s+/)
        .slice(0, 25)
        .join(" ");

      return (
        words === existingWords ||
        (post.url && existing.url && post.url === existing.url)
      );
    });

    if (!duplicate) {
      result.push(post);
    }
  }

  console.log(
    `🧹 После удаления дублей: ${result.length}`
  );

  return result;
}

// ============================================================
// FRESHNESS
// ============================================================

function isFresh(post) {
  if (!post.date) {
    return false;
  }

  const age =
    Date.now() - post.date.getTime();

  const hours =
    age / (1000 * 60 * 60);

  return hours >= 0 && hours <= FRESH_HOURS;
}

// ============================================================
// INSTAGRAM
// ============================================================

async function getInstagramProfileData() {
  console.log("\n==============================");
  console.log("📸 ПРОВЕРЯЕМ INSTAGRAM");
  console.log("==============================");

  const url =
    `https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(
      INSTAGRAM_PROFILE.username
    )}`;

  try {
    const response = await axios.get(url, {
      timeout: 20000,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140 Safari/537.36",
        "Accept": "application/json",
        "X-IG-App-ID": "936619743392459",
        "Referer": INSTAGRAM_PROFILE.url
      }
    });

    return response.data;
  } catch (error) {
    console.log(
      `⚠️ Instagram API не ответил: ${error.message}`
    );

    return null;
  }
}

// ============================================================
// INSTAGRAM HTML FALLBACK
// ============================================================

async function getInstagramHtmlPosts() {
  console.log("🔄 Пробуем Instagram HTML fallback...");

  try {
    const html = await getPage(
      INSTAGRAM_PROFILE.url
    );

    const $ = cheerio.load(html);

    const posts = [];

    $('meta[property="og:image"]').each((index, element) => {
      const imageUrl = $(element).attr("content");

      if (!imageUrl) return;

      posts.push({
        id: `instagram-html-${index}`,
        shortcode: null,
        url: INSTAGRAM_PROFILE.url,
        caption: "",
        mediaType: "IMAGE",
        mediaUrl: imageUrl,
        date: null
      });
    });

    return posts.slice(0, INSTAGRAM_POSTS_TO_CHECK);
  } catch (error) {
    console.log(
      `⚠️ Instagram HTML fallback тоже не сработал: ${error.message}`
    );

    return [];
  }
}

// ============================================================
// EXTRACT INSTAGRAM POSTS
// ============================================================

async function getInstagramPosts() {
  const data =
    await getInstagramProfileData();

  const edges =
    data?.data?.user?.edge_owner_to_timeline_media?.edges || [];

  if (!edges.length) {
    return await getInstagramHtmlPosts();
  }

  const posts = [];

  for (const edge of edges.slice(0, INSTAGRAM_POSTS_TO_CHECK)) {
    const node = edge?.node;

    if (!node) continue;

    const timestamp =
      node.taken_at_timestamp
        ? new Date(node.taken_at_timestamp * 1000)
        : null;

    if (
      timestamp &&
      Date.now() - timestamp.getTime() >
        INSTAGRAM_MAX_AGE_DAYS * 24 * 60 * 60 * 1000
    ) {
      continue;
    }

    let mediaUrl =
      node.display_url ||
      node.thumbnail_src ||
      null;

    let mediaType =
      node.is_video ? "VIDEO" : "IMAGE";

    let videoUrl =
      node.video_url || null;

    // Carousel
    const children =
      node.edge_sidecar_to_children?.edges || [];

    if (
      children.length > 0 &&
      !mediaUrl
    ) {
      const firstChild = children[0]?.node;

      if (firstChild) {
        mediaUrl =
          firstChild.display_url ||
          firstChild.thumbnail_src ||
          null;

        if (firstChild.is_video) {
          mediaType = "VIDEO";
          videoUrl = firstChild.video_url || null;
        }
      }
    }

    const caption =
      node.edge_media_to_caption?.edges?.[0]?.node?.text ||
      "";

    const shortcode =
      node.shortcode || null;

    const postUrl = shortcode
      ? `https://www.instagram.com/p/${shortcode}/`
      : INSTAGRAM_PROFILE.url;

    if (!mediaUrl && !videoUrl) {
      continue;
    }

    posts.push({
      id:
        node.id ||
        shortcode ||
        `instagram-${posts.length}`,

      shortcode,

      url: postUrl,

      caption: cleanText(caption),

      mediaType,

      mediaUrl,

      videoUrl,

      date: timestamp
    });
  }

  return posts;
}

// ============================================================
// CLASSIFY INSTAGRAM
// ============================================================

async function classifyInstagram(posts) {
  if (!posts.length) {
    console.log(
      "⚠️ Instagram не дал подходящих публикаций."
    );

    return [];
  }

  console.log(
    `🤖 Анализируем ${posts.length} Instagram-публикаций...`
  );

  const candidates = posts
    .map((post, index) => {
      return `
[INSTAGRAM ${index}]

Дата:
${post.date?.toISOString() || "unknown"}

URL:
${post.url}

Текст / caption:
${post.caption.slice(0, 2500)}
`;
    })
    .join("\n----------------\n");

  const prompt = `
Ты — редактор официального Telegram-канала компании Radius Logistics.

Перед тобой публикации официального Instagram компании.

Нужно определить, есть ли среди них ДЕЙСТВИТЕЛЬНО ИНТЕРЕСНЫЙ контент, который стоит отдельно превратить в Telegram-пост.

Instagram является ПЕРВЫМ источником контента.

Интересным может быть:

- открытие нового офиса;
- открытие склада;
- новый объект;
- новый маршрут;
- важное достижение компании;
- крупная сделка;
- участие в значимом мероприятии;
- новая услуга;
- важный корпоративный результат;
- заметное событие в деятельности Radius Logistics;
- интересное фото или видео с реальным содержательным контекстом.

НЕ выбирай:

- обычные фотографии сотрудников без новости;
- поздравления без существенной информации;
- банальные корпоративные фотографии;
- повторяющийся контент;
- рекламные публикации без конкретной новости;
- фотографии без понятного информационного смысла.

Оцени каждую публикацию по шкале от 0 до 10.

7–10 = потенциально достойно отдельного Telegram-поста.

0–6 = пропустить.

ВАЖНО:

Если текст Instagram-публикации сам по себе содержит интересный факт или событие, этого достаточно.

Не требуй от публикации быть полноценной новостью.

Верни ТОЛЬКО JSON-массив:

[
  {
    "index": 0,
    "interesting": 8,
    "selected": true,
    "reason": "Короткая причина"
  }
]

Не добавляй Markdown.

ПУБЛИКАЦИИ:

${candidates}
`;

  const response =
    await ai.models.generateContent({
      model: GEMINI_MODEL,
      contents: prompt
    });

  let raw =
    response.text?.trim();

  if (!raw) {
    throw new Error(
      "Gemini не вернул классификацию Instagram"
    );
  }

  raw = raw
    .replace(/^```json/i, "")
    .replace(/^```/i, "")
    .replace(/```$/i, "")
    .trim();

  let classifications;

  try {
    classifications =
      JSON.parse(raw);
  } catch {
    console.log(
      "❌ Instagram classification JSON:"
    );

    console.log(raw);

    throw new Error(
      "Не удалось распарсить классификацию Instagram"
    );
  }

  return classifications;
}

// ============================================================
// SELECT BEST INSTAGRAM POST
// ============================================================

function selectBestInstagramPost(
  posts,
  classifications
) {
  const candidates = [];

  for (const item of classifications) {
    if (
      !item ||
      item.selected !== true
    ) {
      continue;
    }

    const post =
      posts[item.index];

    if (!post) continue;

    const interesting =
      Number(item.interesting) || 0;

    if (interesting < 7) {
      continue;
    }

    candidates.push({
      post,
      interesting,
      reason:
        item.reason || ""
    });
  }

  if (!candidates.length) {
    console.log(
      "📭 В Instagram нет достаточно интересного контента."
    );

    return null;
  }

  candidates.sort(
    (a, b) =>
      b.interesting - a.interesting
  );

  const selected =
    candidates[0];

  console.log(
    "\n=============================="
  );

  console.log(
    "🎯 ВЫБРАН INSTAGRAM-КОНТЕНТ"
  );

  console.log(
    "=============================="
  );

  console.log(
    `Оценка: ${selected.interesting}/10`
  );

  console.log(
    `Причина: ${selected.reason}`
  );

  console.log(
    `URL: ${selected.post.url}`
  );

  return {
    mode: "instagram_content",

    post: selected.post,

    interesting:
      selected.interesting,

    reason:
      selected.reason,

    image: null
  };
}

// ============================================================
// GEMINI CLASSIFICATION — TELEGRAM
// ============================================================

async function classifyNews(posts) {
  console.log(
    "\n🤖 Определяем релевантность Telegram-новостей..."
  );

  const candidates =
    posts
      .slice(0, 35)
      .map((post, index) => {
        return `
[NEWS ${index}]

Источник:
${post.source}

Дата:
${post.date?.toISOString() || "unknown"}

Текст:
${post.text.slice(0, 1800)}
`;
      })
      .join(
        "\n----------------\n"
      );

  const prompt = `
Ты — строгий редактор новостного Telegram-канала о логистике, транспорте и международной торговле.

Тебе нужно классифицировать публикации из Telegram-источников.

==================================================
ГЕОГРАФИЧЕСКИЙ ПРИОРИТЕТ
==================================================

1. UZBEKISTAN
2. CENTRAL_ASIA
3. MIDDLE_EAST
4. FAR_EAST
5. EURASIA

Также есть:
IRRELEVANT

UZBEKISTAN имеет максимальный приоритет.

Если новость напрямую связана с Узбекистаном — ставь UZBEKISTAN, даже если участвуют Китай, Россия, ОАЭ, Казахстан или другие страны.

Примеры:

"Китайская компания открывает склад в Ташкенте"
→ UZBEKISTAN

"Российская авиакомпания запускает рейс в Навои"
→ UZBEKISTAN

"Узбекистан и Китай увеличивают грузовые перевозки"
→ UZBEKISTAN

Если Узбекистан НЕ является существенной частью новости, но новость относится к Казахстану, Кыргызстану, Таджикистану, Туркменистану или транспортной инфраструктуре Центральной Азии:

→ CENTRAL_ASIA

Ближний Восток:
→ MIDDLE_EAST

Восточная Азия:
Китай, Япония, Южная Корея и т. п.
→ FAR_EAST

Более широкая евразийская транспортная история:
→ EURASIA

Всё остальное:
→ IRRELEVANT

==================================================
ЛОГИСТИКА — КРИТИЧЕСКИ СТРОГО
==================================================

logistics=true ТОЛЬКО если сама публикация относится к:

- грузоперевозкам;
- транспортировке;
- железнодорожным перевозкам;
- автомобильным перевозкам;
- авиационным грузоперевозкам;
- морским перевозкам;
- портам;
- терминалам;
- складам;
- supply chain;
- таможне;
- транспортным коридорам;
- логистической инфраструктуре;
- грузовым маршрутам;
- контейнерным перевозкам;
- экспедированию;
- распределительным центрам;
- международной торговой логистике.

НЕ ставь logistics=true только потому, что новость касается бизнеса, промышленности, экономики или инвестиций.

Например:

"Компания построит новый завод"
→ logistics=false,

если в новости нет конкретной логистической составляющей.

"Компания построит новый логистический терминал"
→ logistics=true.

"Открыт новый склад"
→ logistics=true.

"Запущен новый грузовой железнодорожный маршрут"
→ logistics=true.

Сначала определи, действительно ли это логистическая новость.

==================================================
NEWS
==================================================

news=true только если это реальное событие, факт, изменение, запуск, открытие, строительство, сделка, решение или другое новостное событие.

Реклама, мнение, поздравление, обычная публикация и общая аналитика:
news=false.

==================================================
INTERESTING
==================================================

Оцени интересность для аудитории Radius Logistics от 0 до 10.

10 = очень сильная новость.

7–9 = хорошая новость.

5–6 = средняя.

0–4 = слабая.

==================================================
ВАЖНО
==================================================

Не выбирай новость только потому, что она свежая.

Не выбирай новость только потому, что в ней упомянут Узбекистан.

Смысловая связь важнее отдельных ключевых слов.

Верни ТОЛЬКО JSON-массив:

[
  {
    "index": 0,
    "region": "UZBEKISTAN",
    "logistics": true,
    "news": true,
    "interesting": 8,
    "reason": "Короткая причина"
  }
]

Не добавляй Markdown.

НОВОСТИ:

${candidates}
`;

  const response =
    await ai.models.generateContent({
      model: GEMINI_MODEL,
      contents: prompt
    });

  let raw =
    response.text?.trim();

  if (!raw) {
    throw new Error(
      "Gemini не вернул классификацию"
    );
  }

  raw = raw
    .replace(/^```json/i, "")
    .replace(/^```/i, "")
    .replace(/```$/i, "")
    .trim();

  let classifications;

  try {
    classifications =
      JSON.parse(raw);
  } catch {
    console.log(
      "❌ Gemini вернул некорректный JSON:"
    );

    console.log(raw);

    throw new Error(
      "Не удалось распарсить классификацию Gemini"
    );
  }

  return classifications;
}

// ============================================================
// SELECT BEST TELEGRAM NEWS
// ============================================================

function selectBestNews(
  posts,
  classifications
) {
  const priority = {
    UZBEKISTAN: 1,
    CENTRAL_ASIA: 2,
    MIDDLE_EAST: 3,
    FAR_EAST: 4,
    EURASIA: 5
  };

  const candidates = [];

  for (const item of classifications) {
    if (
      !item ||
      !priority[item.region] ||
      item.news !== true ||
      item.logistics !== true
    ) {
      continue;
    }

    const post =
      posts[item.index];

    if (!post) continue;

    candidates.push({
      mode: "telegram_news",

      post,

      region:
        item.region,

      interesting:
        Number(item.interesting) || 0,

      reason:
        item.reason || "",

      image: null
    });
  }

  if (!candidates.length) {
    return null;
  }

  candidates.sort(
    (a, b) => {
      const regionDifference =
        priority[a.region] -
        priority[b.region];

      if (regionDifference !== 0) {
        return regionDifference;
      }

      return (
        b.interesting -
        a.interesting
      );
    }
  );

  const selected =
    candidates[0];

  console.log(
    "\n=============================="
  );

  console.log(
    "🎯 ВЫБРАНА TELEGRAM НОВОСТЬ"
  );

  console.log(
    "=============================="
  );

  console.log(
    `Регион: ${selected.region}`
  );

  console.log(
    `Источник: ${selected.post.source}`
  );

  console.log(
    `Оценка интересности: ${selected.interesting}/10`
  );

  console.log(
    `Причина: ${selected.reason}`
  );

  console.log(
    `Дата: ${selected.post.date}`
  );

  console.log(
    `URL: ${selected.post.url}`
  );

  return selected;
}

// ============================================================
// WRITE TELEGRAM NEWS POST
// ============================================================

async function generateTelegramPost(selected) {
  console.log(
    "\n✍️ Gemini пишет Telegram news пост..."
  );

  const prompt = `
Ты — главный редактор профессионального Telegram-канала о логистике, транспорте и международной торговле с фокусом на Узбекистан и Евразию.

Твоя задача — превратить исходную новость в качественный, естественный Telegram-пост НА УЗБЕКСКОМ ЯЗЫКЕ.

Используй современный узбекский язык в латинице.

НЕ переводи исходный текст дословно.

Перескажи его естественно, как профессиональный редактор новостного Telegram-канала.

==================================================
ГЛАВНЫЙ ПРИНЦИП
==================================================

Факты важнее красоты текста.

СТРОГО ЗАПРЕЩЕНО:

- выдумывать факты;
- придумывать цифры;
- придумывать цитаты;
- добавлять события, которых нет в источнике;
- делать неподтверждённые прогнозы;
- приписывать участникам новости намерения, которых нет в источнике;
- добавлять политические оценки;
- добавлять собственные выводы как установленные факты;
- повторять одну и ту же мысль разными словами.

Если какая-либо информация отсутствует в исходной новости — НЕ ДОБАВЛЯЙ ЕЁ.

==================================================
ЯЗЫК
==================================================

Пиши естественно и современно.

Текст должен звучать так, будто его написал настоящий редактор узбекского новостного Telegram-канала.

НЕ используй:

- канцелярит;
- чрезмерно официальные конструкции;
- искусственные рекламные фразы;
- пустые предложения;
- шаблонные AI-фразы.

НЕ используй автоматически:

"Nega bu muhim?"

"Bu logistika bozori uchun muhim..."

"Bu o‘zgarish logistika sohasi uchun katta ahamiyatga ega..."

"sezilarli ta'sir ko‘rsatadi"

"yangi imkoniyatlar yaratadi"

"katta qadam bo‘ldi"

если это не подтверждается непосредственно исходной новостью.

==================================================
СТРУКТУРА
==================================================

Первая строка — короткий, конкретный и интересный заголовок.

Заголовок должен сразу сообщать, ЧТО произошло.

После заголовка дай короткое вступление.

Затем раскрой основные факты.

Если есть несколько конкретных фактов, можно использовать:

[LIST]

👉 Birinchi muhim fakt

👉 Ikkinchi muhim fakt

👉 Uchinchi muhim fakt

[/LIST]

Если есть отдельный важный смысловой раздел:

[HEADING]Muhim tafsilotlar[/HEADING]

Если есть действительно важная цитата:

[QUOTE]Muhim jumla[/QUOTE]

Можно использовать:

[ITALIC]Qo‘shimcha ma’lumot[/ITALIC]

Но эти элементы НЕ обязательны.

Используй их только там, где они действительно улучшают пост.

==================================================
ВИЗУАЛЬНЫЙ СТИЛЬ
==================================================

Используй 3–7 уместных Unicode emoji.

Emoji должны соответствовать содержанию.

🚛 транспорт
🚆 железная дорога
✈️ авиация
🚢 морские перевозки
🇺🇿 Узбекистан
🇰🇿 Казахстан
📦 грузы
🏗️ инфраструктура
📍 география
💰 торговля
🌍 международные маршруты

Не ставь emoji просто ради количества.

Используй короткие абзацы.

==================================================
БЕЗ ИСКУССТВЕННОГО ЗАПОЛНЕНИЯ
==================================================

Если в новости достаточно информации на 500 символов — напиши 500.

Не растягивай текст.

Каждое предложение должно нести информацию.

Не повторяй заголовок во вступлении.

Не повторяй факты.

==================================================
ФОРМАТИРОВАНИЕ
==================================================

НЕ используй Markdown.

НЕ используй:

**
*
_
###

НЕ используй HTML.

Для форматирования используй ТОЛЬКО:

[HEADING]...[/HEADING]

[QUOTE]...[/QUOTE]

[LIST]...[/LIST]

[ITALIC]...[/ITALIC]

Первая строка должна быть обычным текстом заголовка.

==================================================
ИСТОЧНИК
==================================================

Не упоминай источник внутри поста, если это не нужно для точности.

==================================================
ФИНАЛ
==================================================

НЕ добавляй:

"Nega bu muhim?"

вывод;

призыв подписаться;

рекламный текст;

собственное мнение;

подпись;

хэштеги.

==================================================
STRICT UZBEK LATIN LANGUAGE QA
==================================================

ВЕСЬ ПОСТ ОБЯЗАТЕЛЬНО должен быть написан на естественном узбекском языке в латинице.

НИКОГДА не используй:

- русские слова;
- русские фразы;
- кириллицу;
- смешанный русский и узбекский;
- узбекские слова в кириллице.

Перед финальным ответом молча проверь каждое предложение.

Примеры:

"ветропарк" → "shamol elektr stansiyasi"

"груз" → "yuk"

"перевозка" → "tashish"

"склад" → "ombor"

"маршрут" → "yo‘nalish"

"железная дорога" → "temir yo‘l"

"строительство" → "qurilish"

Используй естественный узбекский термин, а не механический перевод.

==================================================
ОГРАНИЧЕНИЯ
==================================================

Максимум: ${MAX_POST_LENGTH} символов.

Не нужно искусственно приближаться к лимиту.

Верни ТОЛЬКО готовый пост.

ИСХОДНАЯ НОВОСТЬ:

Источник:
${selected.post.source}

Дата:
${selected.post.date?.toISOString() || "unknown"}

Текст:
${selected.post.text.slice(0, 10000)}
`;

  const response =
    await ai.models.generateContent({
      model: GEMINI_MODEL,
      contents: prompt
    });

  let result =
    response.text?.trim();

  if (!result) {
    throw new Error(
      "Gemini вернул пустой пост"
    );
  }

  result =
    cleanGeminiOutput(result);

  return result;
}

// ============================================================
// WRITE INSTAGRAM POST
// ============================================================

async function generateInstagramPost(selected) {
  console.log(
    "\n✍️ Gemini пишет Instagram Telegram-пост..."
  );

  const prompt = `
Ты — редактор официального Telegram-канала Radius Logistics.

Нужно превратить Instagram-публикацию компании в короткий, интересный Telegram-пост на естественном узбекском языке.

Это НЕ обычная новостная статья.

Стиль:

- коротко;
- живо;
- интересно;
- современно;
- профессионально;
- допустима лёгкая естественная улыбка/юмор, если это действительно уместно;
- без рекламного пафоса.

Если в Instagram-публикации уже есть интересный заголовок или название события — можешь использовать его основу.

НЕ выдумывай факты.

НЕ добавляй цифры, которых нет.

НЕ добавляй события, которых нет.

НЕ делай длинную статью.

Пиши только то, что следует из Instagram-публикации.

Используй 2–5 уместных Unicode emoji.

Первая строка — интересный заголовок.

Можно использовать:

[ITALIC]...[/ITALIC]

[HEADING]...[/HEADING]

Но только если это реально улучшает текст.

НЕ используй Markdown.

НЕ используй:

**
*
_
###

НЕ используй HTML.

НЕ добавляй:

- хэштеги;
- подпись;
- ссылку;
- рекламный призыв.

Это будет добавлено системой.

==================================================
STRICT UZBEK LATIN
==================================================

Весь текст должен быть естественным узбекским языком в латинице.

НИКАКОЙ кириллицы.

НИКАКИХ русских слов.

НИКАКОГО смешанного русского и узбекского.

Проверь каждое слово перед ответом.

==================================================
ДЛИНА
==================================================

Обычно 300–700 символов.

Если информации мало — пиши ещё короче.

Не растягивай пост.

Верни ТОЛЬКО готовый текст.

INSTAGRAM:

Дата:
${selected.post.date?.toISOString() || "unknown"}

URL:
${selected.post.url}

Caption:
${selected.post.caption.slice(0, 7000)}
`;

  const response =
    await ai.models.generateContent({
      model: GEMINI_MODEL,
      contents: prompt
    });

  let result =
    response.text?.trim();

  if (!result) {
    throw new Error(
      "Gemini вернул пустой Instagram-пост"
    );
  }

  result =
    cleanGeminiOutput(result);

  return result;
}

// ============================================================
// LANGUAGE QA
// ============================================================

function containsCyrillic(text) {
  return /[\u0400-\u04FF]/u.test(text);
}

function containsMarkdown(text) {
  return (
    /\*\*/.test(text) ||
    /(^|\s)\*(\S)/.test(text) ||
    /(^|\s)_\S/.test(text) ||
    /(^|\s)#{1,6}\s/.test(text) ||
    /\[[^\]]+\]\([^)]+\)/.test(text)
  );
}

function containsRawFormattingMarkers(text) {
  return (
    /\[ITALIC\]/i.test(text) ||
    /\[HEADING\]/i.test(text) ||
    /\[QUOTE\]/i.test(text) ||
    /\[LIST\]/i.test(text)
  );
}

function validatePost(text) {
  const errors = [];

  if (!text || !text.trim()) {
    errors.push("пустой текст");
  }

  if (containsCyrillic(text)) {
    errors.push("обнаружена кириллица");
  }

  if (containsMarkdown(text)) {
    errors.push("обнаружен Markdown");
  }

  if (text.length > MAX_POST_LENGTH) {
    errors.push(
      `длина ${text.length} > ${MAX_POST_LENGTH}`
    );
  }

  return {
    valid: errors.length === 0,
    errors
  };
}

// ============================================================
// REPAIR POST
// ============================================================

async function repairPost(
  selected,
  post,
  mode,
  errors
) {
  console.log(
    `🔧 Исправляем пост: ${errors.join(", ")}`
  );

  const sourceText =
    mode === "instagram_content"
      ? selected.post.caption
      : selected.post.text;

  const prompt = `
Ты выполняешь финальную редакторскую корректуру узбекского Telegram-поста.

ИСПРАВЬ ТОЛЬКО ОШИБКИ.

Проблемы:

${errors.map((e) => `- ${e}`).join("\n")}

КРИТИЧЕСКИЕ ПРАВИЛА:

1. Весь текст должен быть естественным узбекским языком в латинице.
2. Никакой кириллицы.
3. Никаких русских слов.
4. Никакого Markdown.
5. Никакого HTML.
6. Не добавляй новые факты.
7. Не меняй фактический смысл.
8. Не добавляй новые цифры.
9. Не увеличивай текст без необходимости.
10. Сохрани специальные маркеры [ITALIC], [HEADING], [QUOTE], [LIST], если они нужны.
11. Максимум ${MAX_POST_LENGTH} символов.
12. Верни ТОЛЬКО исправленный пост.

ИСХОДНЫЙ ПОСТ:

${post}

ИСТОЧНИК:

${sourceText.slice(0, 9000)}
`;

  const response =
    await ai.models.generateContent({
      model: GEMINI_MODEL,
      contents: prompt
    });

  let result =
    response.text?.trim();

  if (!result) {
    throw new Error(
      "Gemini не вернул исправленный пост"
    );
  }

  result =
    cleanGeminiOutput(result);

  return result;
}

// ============================================================
// WRITE + QA
// ============================================================

async function writePost(selected) {
  const mode =
    selected.mode ||
    "telegram_news";

  let post;

  if (mode === "instagram_content") {
    post =
      await generateInstagramPost(
        selected
      );
  } else {
    post =
      await generateTelegramPost(
        selected
      );
  }

  for (
    let attempt = 0;
    attempt <= MAX_LANGUAGE_REPAIRS;
    attempt++
  ) {
    const validation =
      validatePost(post);

    if (validation.valid) {
      console.log(
        "✅ Uzbek Language QA пройден."
      );

      return post;
    }

    console.log(
      `⚠️ Language QA: ${validation.errors.join(
        ", "
      )}`
    );

    if (
      attempt >= MAX_LANGUAGE_REPAIRS
    ) {
      throw new Error(
        `Пост не прошёл Language QA после ${MAX_LANGUAGE_REPAIRS} исправлений: ${validation.errors.join(
          ", "
        )}`
      );
    }

    post =
      await repairPost(
        selected,
        post,
        mode,
        validation.errors
      );
  }

  throw new Error(
    "Не удалось пройти Language QA"
  );
}

// ============================================================
// HTML ESCAPE
// ============================================================

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// ============================================================
// TELEGRAM HTML FORMATTER
// ============================================================

function formatTelegramPost(text) {
  const lines =
    text
      .split("\n")
      .map((line) => line.trim());

  if (
    !lines.some(
      (line) => line.length > 0
    )
  ) {
    return "";
  }

  const titleIndex =
    lines.findIndex(
      (line) => line.length > 0
    );

  let title =
    lines[titleIndex];

  lines.splice(
    titleIndex,
    1
  );

  // Защита от случайного Markdown в заголовке
  title = title
    .replace(/^\*\*(.*?)\*\*$/s, "$1")
    .replace(/^__(.*?)__$/s, "$1")
    .trim();

  title =
    escapeHtml(title);

  let body =
    lines.join("\n");

  // ==========================================================
  // SPECIAL MARKERS
  // ==========================================================

  const tokens = [];

  function createToken(html) {
    const token =
      `___TG_TOKEN_${tokens.length}___`;

    tokens.push({
      token,
      html
    });

    return token;
  }

  body =
    body.replace(
      /\[HEADING\]([\s\S]*?)\[\/HEADING\]/gi,
      (_, content) =>
        createToken(
          `<b>${escapeHtml(
            content
          )}</b>`
        )
    );

  body =
    body.replace(
      /\[QUOTE\]([\s\S]*?)\[\/QUOTE\]/gi,
      (_, content) =>
        createToken(
          `<blockquote>${escapeHtml(
            content
          )}</blockquote>`
        )
    );

  body =
    body.replace(
      /\[ITALIC\]([\s\S]*?)\[\/ITALIC\]/gi,
      (_, content) =>
        createToken(
          `<i>${escapeHtml(
            content
          )}</i>`
        )
    );

  body =
    body.replace(
      /\[LIST\]([\s\S]*?)\[\/LIST\]/gi,
      (_, content) =>
        createToken(
          escapeHtml(
            content.trim()
          )
        )
    );

  // ==========================================================
  // ESCAPE EVERYTHING ELSE
  // ==========================================================

  body =
    escapeHtml(body);

  // ==========================================================
  // RESTORE HTML TOKENS
  // ==========================================================

  for (const item of tokens) {
    body =
      body.replace(
        item.token,
        item.html
      );
  }

  body =
    body
      .replace(/\n{3,}/g, "\n\n")
      .trim();

  if (!body) {
    return `<b>${title}</b>`;
  }

  return `<b>${title}</b>\n\n${body}`;
}

// ============================================================
// TELEGRAM LENGTH
// ============================================================

function getTelegramLength(text) {
  return text
    .replace(/<[^>]*>/g, "")
    .length;
}

// ============================================================
// FOOTER
// ============================================================

function addFooter(text) {
  return `${text}

#RadiusLogistics #Logistics #Transport #Uzbekistan

<a href="https://t.me/radiuslogistic">Radius Logistics</a>`;
}

// ============================================================
// DOWNLOAD MEDIA
// ============================================================

async function downloadMedia(
  url
) {
  console.log(
    "📥 Скачиваем медиа..."
  );

  const response =
    await axios.get(url, {
      responseType: "arraybuffer",
      timeout: 60000,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140 Safari/537.36"
      }
    });

  const buffer =
    Buffer.from(
      response.data
    );

  const contentType =
    response.headers[
      "content-type"
    ] ||
    "application/octet-stream";

  console.log(
    `📦 Медиа скачано: ${(
      buffer.length /
      1024 /
      1024
    ).toFixed(2)} MB`
  );

  return {
    buffer,
    contentType
  };
}

// ============================================================
// DOWNLOAD IMAGE
// ============================================================

async function downloadImage(
  url
) {
  const media =
    await downloadMedia(url);

  return {
    buffer: media.buffer,
    contentType:
      media.contentType ||
      "image/jpeg"
  };
}

// ============================================================
// SEND PHOTO
// ============================================================

async function sendPhotoToTelegram(
  chatId,
  image,
  caption,
  keyboard = null
) {
  const blob =
    new Blob(
      [image.buffer],
      {
        type:
          image.contentType ||
          "image/jpeg"
      }
    );

  const form =
    new FormData();

  form.append(
    "chat_id",
    String(chatId)
  );

  form.append(
    "photo",
    blob,
    "radius-logistics.jpg"
  );

  form.append(
    "caption",
    caption
  );

  form.append(
    "parse_mode",
    "HTML"
  );

  if (keyboard) {
    form.append(
      "reply_markup",
      JSON.stringify(
        keyboard
      )
    );
  }

  const response =
    await fetch(
      `https://api.telegram.org/bot${BOT_TOKEN}/sendPhoto`,
      {
        method: "POST",
        body: form
      }
    );

  const result =
    await response.json();

  if (!result.ok) {
    throw new Error(
      result.description ||
        "Telegram sendPhoto failed"
    );
  }

  return result.result;
}

// ============================================================
// SEND VIDEO
// ============================================================

async function sendVideoToTelegram(
  chatId,
  video,
  caption,
  keyboard = null
) {
  const blob =
    new Blob(
      [video.buffer],
      {
        type:
          video.contentType ||
          "video/mp4"
      }
    );

  const form =
    new FormData();

  form.append(
    "chat_id",
    String(chatId)
  );

  form.append(
    "video",
    blob,
    "radius-logistics.mp4"
  );

  form.append(
    "caption",
    caption
  );

  form.append(
    "parse_mode",
    "HTML"
  );

  if (keyboard) {
    form.append(
      "reply_markup",
      JSON.stringify(
        keyboard
      )
    );
  }

  const response =
    await fetch(
      `https://api.telegram.org/bot${BOT_TOKEN}/sendVideo`,
      {
        method: "POST",
        body: form
      }
    );

  const result =
    await response.json();

  if (!result.ok) {
    throw new Error(
      result.description ||
        "Telegram sendVideo failed"
    );
  }

  return result.result;
}

// ============================================================
// PEXELS QUERY
// ============================================================

async function createPexelsQuery(
  selected
) {
  console.log(
    "\n🖼️ Gemini подбирает запрос для Pexels..."
  );

  const prompt = `
Ты подбираешь поисковый запрос для Pexels для профессионального Telegram-канала о логистике.

Исходная новость:

${selected.post.text.slice(
  0,
  7000
)}

Нужно придумать ОДИН короткий поисковый запрос НА АНГЛИЙСКОМ ЯЗЫКЕ.

Цель — найти реалистичную профессиональную фотографию, визуально соответствующую новости.

Предпочитай:

cargo transportation
logistics
warehouse
freight train
container terminal
truck
shipping containers
cargo aircraft
port
customs
logistics workers
distribution center
road freight

Если новость связана с конкретным объектом, транспортом или инфраструктурой — учитывай это.

НЕ придумывай визуальные детали.

НЕ используй:

business success
economic growth
future
innovation
logo
text
illustration
3d
render
ai
fantasy

Нужна настоящая фотография.

3–7 слов.

Верни ТОЛЬКО запрос.
`;

  const response =
    await ai.models.generateContent({
      model: GEMINI_MODEL,
      contents: prompt
    });

  const query =
    response.text?.trim();

  if (!query) {
    throw new Error(
      "Gemini не создал запрос для Pexels"
    );
  }

  const cleanQuery =
    query
      .replace(
        /^["'`]+|["'`]+$/g,
        ""
      )
      .replace(
        /\n/g,
        " "
      )
      .trim();

  console.log(
    `🔎 Pexels query: "${cleanQuery}"`
  );

  return cleanQuery;
}

// ============================================================
// PEXELS SEARCH
// ============================================================

async function searchPexels(
  query
) {
  console.log(
    "🔍 Ищем фотографию на Pexels..."
  );

  const response =
    await axios.get(
      "https://api.pexels.com/v1/search",
      {
        timeout: 20000,

        headers: {
          Authorization:
            PEXELS_API_KEY
        },

        params: {
          query,
          orientation: "landscape",
          size: "large",
          locale: "en-US",
          page: 1,
          per_page: 10
        }
      }
    );

  const photos =
    response.data?.photos ||
    [];

  if (!photos.length) {
    throw new Error(
      `Pexels не нашёл фотографий по запросу: ${query}`
    );
  }

  console.log(
    `📸 Pexels найдено фотографий: ${photos.length}`
  );

  const photo =
    photos[0];

  const imageUrl =
    photo.src?.large2x ||
    photo.src?.large ||
    photo.src?.original;

  if (!imageUrl) {
    throw new Error(
      "Pexels вернул фотографию без URL"
    );
  }

  return {
    url: imageUrl,

    pexelsUrl:
      photo.url || null,

    photographer:
      photo.photographer ||
      "Pexels"
  };
}

// ============================================================
// GET PEXELS IMAGE
// ============================================================

async function getNewsImage(
  selected
) {
  const query =
    await createPexelsQuery(
      selected
    );

  const photo =
    await searchPexels(
      query
    );

  return {
    ...photo,
    query
  };
}

// ============================================================
// REVIEW KEYBOARD
// ============================================================

function getReviewKeyboard() {
  return {
    inline_keyboard: [
      [
        {
          text: "✅ ОПУБЛИКОВАТЬ",
          callback_data:
            "review_publish"
        }
      ],
      [
        {
          text: "🔄 ПЕРЕПИСАТЬ",
          callback_data:
            "review_rewrite"
        },
        {
          text: "❌ ПРОПУСТИТЬ",
          callback_data:
            "review_skip"
        }
      ]
    ]
  };
}

// ============================================================
// SEND FOR REVIEW
// ============================================================

async function sendForReview(
  selected,
  post
) {
  if (!REVIEW_CHAT_ID) {
    throw new Error(
      "❌ REVIEW_CHAT_ID не установлен"
    );
  }

  const formatted =
    addFooter(
      formatTelegramPost(
        post
      )
    );

  pendingReview = {
    selected,
    post
  };

  const keyboard =
    getReviewKeyboard();

  // ==========================================================
  // INSTAGRAM VIDEO
  // ==========================================================

  if (
    selected.mode ===
      "instagram_content" &&
    selected.post.mediaType ===
      "VIDEO" &&
    selected.post.videoUrl
  ) {
    try {
      console.log(
        "🎬 Отправляем оригинальное Instagram-видео на проверку..."
      );

      const video =
        await downloadMedia(
          selected.post.videoUrl
        );

      await sendVideoToTelegram(
        REVIEW_CHAT_ID,
        video,
        formatted,
        keyboard
      );

      console.log(
        "📨 Instagram-видео + пост отправлены на проверку!"
      );

      return;
    } catch (error) {
      console.log(
        `⚠️ Не удалось отправить Instagram-видео: ${error.message}`
      );
    }
  }

  // ==========================================================
  // INSTAGRAM PHOTO
  // ==========================================================

  if (
    selected.mode ===
      "instagram_content" &&
    selected.post.mediaUrl
  ) {
    try {
      console.log(
        "📸 Отправляем оригинальное Instagram-фото на проверку..."
      );

      const image =
        await downloadImage(
          selected.post.mediaUrl
        );

      await sendPhotoToTelegram(
        REVIEW_CHAT_ID,
        image,
        formatted,
        keyboard
      );

      console.log(
        "📨 Instagram-фото + пост отправлены на проверку!"
      );

      return;
    } catch (error) {
      console.log(
        `⚠️ Не удалось отправить Instagram-фото: ${error.message}`
      );
    }
  }

  // ==========================================================
  // TELEGRAM / PEXELS
  // ==========================================================

  if (
    selected.mode ===
      "telegram_news" &&
    selected.image
  ) {
    try {
      console.log(
        "📸 Отправляем Pexels-фото на проверку..."
      );

      const image =
        await downloadImage(
          selected.image.url
        );

      await sendPhotoToTelegram(
        REVIEW_CHAT_ID,
        image,
        formatted,
        keyboard
      );

      console.log(
        "📨 Пост + Pexels-фото отправлены на проверку!"
      );

      return;
    } catch (error) {
      console.log(
        `⚠️ Не удалось отправить Pexels-фото: ${error.message}`
      );
    }
  }

  // ==========================================================
  // TEXT FALLBACK
  // ==========================================================

  await telegram(
    "sendMessage",
    {
      chat_id:
        REVIEW_CHAT_ID,

      text: formatted,

      parse_mode: "HTML",

      reply_markup:
        keyboard,

      disable_web_page_preview:
        false
    }
  );

  console.log(
    "📨 Пост отправлен на проверку!"
  );
}

// ============================================================
// REVIEW BOT
// ============================================================

async function handleReviewUpdate(
  update
) {
  // ==========================================================
  // /start
  // ==========================================================

  if (
    update.message?.text ===
    "/start"
  ) {
    await telegram(
      "sendMessage",
      {
        chat_id:
          update.message.chat.id,

        text:
          "🤖 <b>Radius Logistics News Bot</b>\n\n" +
          "Готов к проверке новостей.\n\n" +
          "Новые посты будут появляться здесь.",

        parse_mode: "HTML"
      }
    );

    console.log(
      `👤 Review chat: ${update.message.chat.id}`
    );

    return;
  }

  // ==========================================================
  // CALLBACKS
  // ==========================================================

  if (!update.callback_query) {
    return;
  }

  const query =
    update.callback_query;

  await telegram(
    "answerCallbackQuery",
    {
      callback_query_id:
        query.id
    }
  );

  if (!pendingReview) {
    await telegram(
      "sendMessage",
      {
        chat_id:
          query.message.chat.id,

        text:
          "⚠️ Сейчас нет поста, ожидающего проверки."
      }
    );

    return;
  }

  // ==========================================================
  // PUBLISH
  // ==========================================================

  if (
    query.data ===
    "review_publish"
  ) {
    const review =
      pendingReview;

    pendingReview = null;

    await telegram(
      "editMessageReplyMarkup",
      {
        chat_id:
          query.message.chat.id,

        message_id:
          query.message.message_id,

        reply_markup: {
          inline_keyboard: []
        }
      }
    );

    console.log(
      "✅ Пост одобрен. Публикуем..."
    );

    await publish(
      review.selected,
      review.post
    );

    await telegram(
      "sendMessage",
      {
        chat_id:
          query.message.chat.id,

        text:
          "✅ <b>Пост опубликован!</b>",

        parse_mode: "HTML"
      }
    );

    return;
  }

  // ==========================================================
  // REWRITE
  // ==========================================================

  if (
    query.data ===
    "review_rewrite"
  ) {
    const review =
      pendingReview;

    await telegram(
      "editMessageReplyMarkup",
      {
        chat_id:
          query.message.chat.id,

        message_id:
          query.message.message_id,

        reply_markup: {
          inline_keyboard: []
        }
      }
    );

    await telegram(
      "sendMessage",
      {
        chat_id:
          query.message.chat.id,

        text:
          "🔄 Переписываю пост..."
      }
    );

    try {
      const newPost =
        await writePost(
          review.selected
        );

      pendingReview = {
        selected:
          review.selected,

        post:
          newPost
      };

      await sendForReview(
        review.selected,
        newPost
      );
    } catch (error) {
      console.error(
        "❌ Ошибка переписывания:",
        error
      );

      await telegram(
        "sendMessage",
        {
          chat_id:
            query.message.chat.id,

          text:
            "❌ Не удалось переписать пост.\n\n" +
            error.message
        }
      );
    }

    return;
  }

  // ==========================================================
  // SKIP
  // ==========================================================

  if (
    query.data ===
    "review_skip"
  ) {
    pendingReview = null;

    await telegram(
      "editMessageReplyMarkup",
      {
        chat_id:
          query.message.chat.id,

        message_id:
          query.message.message_id,

        reply_markup: {
          inline_keyboard: []
        }
      }
    );

    await telegram(
      "sendMessage",
      {
        chat_id:
          query.message.chat.id,

        text:
          "❌ <b>Пост пропущен.</b>",

        parse_mode: "HTML"
      }
    );

    console.log(
      "❌ Пост пропущен."
    );

    return;
  }
}

// ============================================================
// TELEGRAM LONG POLLING
// ============================================================

async function startReviewBot() {
  console.log(
    "\n🤖 REVIEW BOT ЗАПУЩЕН"
  );

  while (true) {
    try {
      const updates =
        await telegram(
          "getUpdates",
          {
            offset:
              lastUpdateId + 1,

            timeout: 30,

            allowed_updates: [
              "message",
              "callback_query"
            ]
          }
        );

      for (const update of updates) {
        lastUpdateId =
          update.update_id;

        try {
          await handleReviewUpdate(
            update
          );
        } catch (error) {
          console.error(
            "❌ Ошибка обработки Telegram update:",
            error.message
          );
        }
      }
    } catch (error) {
      console.error(
        "⚠️ Ошибка Telegram polling:",
        error.message
      );

      await new Promise(
        (resolve) =>
          setTimeout(
            resolve,
            3000
          )
      );
    }
  }
}

// ============================================================
// PUBLISH
// ============================================================

async function publish(
  selected,
  post
) {
  console.log(
    "\n📤 Публикуем пост..."
  );

  const formatted =
    addFooter(
      formatTelegramPost(
        post
      )
    );

  console.log(
    "\n========== FINAL POST =========="
  );

  console.log(
    formatted
  );

  console.log(
    "================================"
  );

  console.log(
    `📏 Длина отображаемого текста: ${getTelegramLength(
      formatted
    )}`
  );

  // ==========================================================
  // INSTAGRAM VIDEO
  // ==========================================================

  if (
    selected.mode ===
      "instagram_content" &&
    selected.post.mediaType ===
      "VIDEO" &&
    selected.post.videoUrl
  ) {
    try {
      console.log(
        "🎬 Скачиваем оригинальное Instagram-видео..."
      );

      const video =
        await downloadMedia(
          selected.post.videoUrl
        );

      await sendVideoToTelegram(
        CHANNEL_ID,
        video,
        formatted
      );

      console.log(
        "✅ Instagram-видео + пост опубликованы!"
      );

      return;
    } catch (error) {
      console.log(
        `⚠️ Не удалось отправить Instagram-видео: ${error.message}`
      );
    }
  }

  // ==========================================================
  // INSTAGRAM PHOTO
  // ==========================================================

  if (
    selected.mode ===
      "instagram_content" &&
    selected.post.mediaUrl
  ) {
    try {
      console.log(
        "📸 Скачиваем оригинальное Instagram-фото..."
      );

      const image =
        await downloadImage(
          selected.post.mediaUrl
        );

      await sendPhotoToTelegram(
        CHANNEL_ID,
        image,
        formatted
      );

      console.log(
        "✅ Instagram-фото + пост опубликованы!"
      );

      return;
    } catch (error) {
      console.log(
        `⚠️ Не удалось отправить Instagram-фото: ${error.message}`
      );
    }
  }

  // ==========================================================
  // TELEGRAM NEWS + PEXELS
  // ==========================================================

  if (
    selected.mode ===
      "telegram_news" &&
    selected.image
  ) {
    try {
      console.log(
        "📸 Скачиваем Pexels-фото..."
      );

      const image =
        await downloadImage(
          selected.image.url
        );

      await sendPhotoToTelegram(
        CHANNEL_ID,
        image,
        formatted
      );

      console.log(
        "✅ Фото + пост опубликованы!"
      );

      console.log(
        `🔗 Pexels: ${
          selected.image.pexelsUrl ||
          "unknown"
        }`
      );

      console.log(
        `📷 Photographer: ${
          selected.image.photographer ||
          "Pexels"
        }`
      );

      return;
    } catch (error) {
      console.log(
        `⚠️ Не удалось отправить Pexels-фото: ${error.message}`
      );

      console.log(
        "🔄 Пробуем отправить текст без фотографии..."
      );
    }
  }

  // ==========================================================
  // TEXT FALLBACK
  // ==========================================================

  await telegram(
    "sendMessage",
    {
      chat_id:
        CHANNEL_ID,

      text: formatted,

      parse_mode: "HTML",

      disable_web_page_preview:
        false
    }
  );

  console.log(
    "✅ Текстовый пост опубликован!"
  );
}

// ============================================================
// MAIN
// ============================================================

async function main() {
  console.log("");

  console.log(
    "🚀 RADIUS LOGISTICS CONTENT BOT"
  );

  console.log(
    "================================"
  );

  console.log(
    "📸 Instagram first"
  );

  console.log(
    "🇺🇿 Uzbekistan priority"
  );

  console.log(
    "🌏 Central Asia"
  );

  console.log(
    "🕌 Middle East"
  );

  console.log(
    "🌏 Far East"
  );

  console.log(
    "🌍 Eurasia"
  );

  console.log(
    "📸 Pexels only for Telegram news"
  );

  console.log(
    "🧠 Uzbek Language QA"
  );

  console.log(
    "================================"
  );

  try {
    // ========================================================
    // 1. INSTAGRAM FIRST
    // ========================================================

    let selected = null;

    try {
      const instagramPosts =
        await getInstagramPosts();

      console.log(
        `📸 Instagram публикаций получено: ${instagramPosts.length}`
      );

      if (
        instagramPosts.length
      ) {
        const classifications =
          await classifyInstagram(
            instagramPosts
          );

        selected =
          selectBestInstagramPost(
            instagramPosts,
            classifications
          );
      }
    } catch (error) {
      console.log(
        `⚠️ Ошибка Instagram: ${error.message}`
      );

      console.log(
        "➡️ Переходим к Telegram."
      );
    }

    // ========================================================
    // 2. TELEGRAM FALLBACK
    // ========================================================

    if (!selected) {
      console.log(
        "\n📡 Instagram не дал подходящего контента."
      );

      console.log(
        "➡️ Переходим к Telegram-источникам."
      );

      let posts =
        await collectNews();

      if (!posts.length) {
        throw new Error(
          "Не удалось получить новости ни из одного Telegram-источника"
        );
      }

      posts =
        removeDuplicates(
          posts
        );

      // ======================================================
      // 3. FRESHNESS
      // ======================================================

      const freshPosts =
        posts.filter(
          isFresh
        );

      console.log(
        `🕐 Свежих новостей за ${FRESH_HOURS}ч: ${freshPosts.length}`
      );

      if (
        freshPosts.length > 0
      ) {
        posts =
          freshPosts;
      }

      // ======================================================
      // 4. CLASSIFY
      // ======================================================

      const classifications =
        await classifyNews(
          posts
        );

      // ======================================================
      // 5. SELECT
      // ======================================================

      selected =
        selectBestNews(
          posts,
          classifications
        );

      if (!selected) {
        throw new Error(
          "Не найдено подходящей логистической новости"
        );
      }
    }

    // ========================================================
    // 6. WRITE
    // ========================================================

    console.log(
      "\n=============================="
    );

    console.log(
      "✍️ НАПИСАНИЕ ПОСТА"
    );

    console.log(
      "=============================="
    );

    console.log(
      `Режим: ${selected.mode}`
    );

    const post =
      await writePost(
        selected
      );

    console.log(
      "\n========== GENERATED POST =========="
    );

    console.log(
      post
    );

    console.log(
      "===================================="
    );

    // ========================================================
    // 7. PEXELS ONLY FOR TELEGRAM
    // ========================================================

    if (
      selected.mode ===
      "telegram_news"
    ) {
      console.log(
        "\n=============================="
      );

      console.log(
        "📸 ИЩЕМ ФОТО ДЛЯ TELEGRAM NEWS"
      );

      console.log(
        "=============================="
      );

      try {
        selected.image =
          await getNewsImage(
            selected
          );

        console.log(
          `📸 Pexels photographer: ${selected.image.photographer}`
        );

        console.log(
          `🔗 Pexels page: ${selected.image.pexelsUrl}`
        );
      } catch (error) {
        console.log(
          `⚠️ Не удалось найти фото Pexels: ${error.message}`
        );

        selected.image =
          null;
      }
    } else {
      console.log(
        "\n📸 Instagram выбран — Pexels НЕ используется."
      );
    }

    // ========================================================
    // 8. REVIEW
    // ========================================================

    await sendForReview(
      selected,
      post
    );

    console.log(
      "\n🏁 ПОСТ ОТПРАВЛЕН НА ПРОВЕРКУ."
    );
  } catch (error) {
    console.error(
      "\n❌ BOT ERROR:"
    );

    console.error(
      error
    );
  }
}

// ============================================================
// START
// ============================================================

startReviewBot();

main();