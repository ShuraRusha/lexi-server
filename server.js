// ════════════════════════════════════════════════════════════
//  Lexi AI Server
//  Принимает текст от приложения → просит OpenAI разобрать его
//  в карточки (язык, перевод, транскрипция, часть речи, уровень,
//  пример) → возвращает строгий JSON обратно в Mini App.
//
//  Переменные окружения (Railway → Variables):
//    OPENAI_API_KEY — ключ OpenAI
//    BOT_TOKEN      — токен Telegram-бота (от @BotFather)
// ════════════════════════════════════════════════════════════

import express from "express";
import cors from "cors";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { randomUUID, createHmac } from "crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(cors());                       // разрешаем запросы из браузера/Telegram
app.use(express.json({ limit: "1mb" })); // принимаем JSON, ограничиваем размер
app.use(express.static(join(__dirname, "public"))); // фронтенд Telegram Mini App

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const BOT_TOKEN      = process.env.BOT_TOKEN;
const APP_URL        = "https://lexi-server-production.up.railway.app";
const MODEL          = "gpt-4o-mini";

// Будет заполнен в app.listen через getMe — для построения t.me/<bot>?start=… ссылок
let BOT_USERNAME = null;

// ── Telegram Bot API helper ──
async function tgCall(method, body) {
  if (!BOT_TOKEN) return null;
  try {
    const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await r.json().catch(() => null);
    if (!r.ok) console.error("TG error:", method, data);
    return data;
  } catch (e) {
    console.error("TG fetch error:", method, e);
    return null;
  }
}

// ════════════════════════════════════════════════════════════
//  SHARE — поделиться набором карточек (PRD: prd_share_cards)
//  Хранилище в памяти: uuid → { deck, created_at, source_user_id }
//  TTL: 90 дней. На каждый деплой обнуляется (Railway).
//  Для production-нагрузки нужно заменить на БД (Postgres/Redis).
// ════════════════════════════════════════════════════════════
const SHARED_DECKS = new Map();
const SHARE_TTL_MS = 90 * 24 * 60 * 60 * 1000; // 90 дней
const MAX_DECK_BYTES = 120_000;                 // защита от больших наборов

// Чистим устаревшие наборы раз в час
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of SHARED_DECKS) {
    if (now - v.created_at > SHARE_TTL_MS) SHARED_DECKS.delete(k);
  }
  for (const [k, v] of PENDING_DECKS) {
    if (now - v.created_at > PENDING_TTL_MS) PENDING_DECKS.delete(k);
  }
}, 60 * 60 * 1000);

// ════════════════════════════════════════════════════════════
//  PENDING_DECKS — очередь «когда пользователь откроет приложение,
//  автоматически добавить ему набор». Заполняется когда юзер
//  нажимает Start в боте по share-ссылке.
//  Ключ: telegram user_id (string), значение: { uuid, created_at }
// ════════════════════════════════════════════════════════════
const PENDING_DECKS = new Map();
const PENDING_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 дней

// ── Верификация Telegram Mini App initData (HMAC-SHA256) ──
// https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
function verifyInitData(initData) {
  if (!initData || !BOT_TOKEN) return null;
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get("hash");
    if (!hash) return null;
    params.delete("hash");

    const dataCheckString = [...params.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join("\n");

    const secret = createHmac("sha256", "WebAppData").update(BOT_TOKEN).digest();
    const computed = createHmac("sha256", secret).update(dataCheckString).digest("hex");
    if (computed !== hash) return null;

    const userRaw = params.get("user");
    if (!userRaw) return null;
    return JSON.parse(userRaw); // { id, first_name, ... }
  } catch (e) {
    return null;
  }
}

// Экранируем HTML — для безопасных сообщений в Telegram
function escapeHtml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ── Webhook от Telegram ──
app.post("/webhook", async (req, res) => {
  res.sendStatus(200); // отвечаем сразу — Telegram не ждёт
  const msg = req.body?.message;
  if (!msg) return;

  if (msg.text === "/start" || msg.text?.startsWith("/start ")) {
    const name = msg.from?.first_name || "друг";

    // ── Кто-то поделился набором: /start set_<uuid> ──
    const startParam = (msg.text || "").split(/\s+/)[1] || "";
    if (startParam.startsWith("set_")) {
      const uuid = startParam.slice(4);
      const entry = SHARED_DECKS.get(uuid);

      if (entry) {
        // Запоминаем: при следующем открытии Mini App — автоматом добавить
        // Работает для существующих пользователей И для новых (после первого запуска).
        if (msg.from?.id) {
          PENDING_DECKS.set(String(msg.from.id), {
            uuid,
            created_at: Date.now(),
          });
        }

        const d = entry.deck;
        const cardCount = Array.isArray(d.cards) ? d.cards.length : 0;
        const preview = (d.cards || []).slice(0, 3)
          .map(c => `• <b>${escapeHtml(c.w)}</b> — ${escapeHtml((c.t || "").split("/")[0].trim())}`)
          .join("\n");

        await tgCall("sendMessage", {
          chat_id: msg.chat.id,
          parse_mode: "HTML",
          text:
            `📚 <b>Вам поделились набором карточек!</b>\n\n` +
            `${escapeHtml(d.icon || "📚")} <b>${escapeHtml(d.name || "Набор")}</b>\n` +
            `${cardCount} карточек${d.level ? " · " + escapeHtml(d.level) : ""}\n\n` +
            (preview ? `<b>Пример:</b>\n${preview}\n\n` : "") +
            `✅ Готово! Открой Lexi кнопкой ниже — набор автоматически появится в твоей библиотеке 👇`,
          reply_markup: {
            inline_keyboard: [[
              { text: "🚀 Открыть Lexi", web_app: { url: APP_URL } }
            ]]
          }
        });
        return;
      }

      // Набор удалён / не существует → graceful 404
      await tgCall("sendMessage", {
        chat_id: msg.chat.id,
        parse_mode: "HTML",
        text:
          `❌ <b>Набор недоступен</b>\n\n` +
          `Этот набор больше не существует или был удалён автором. ` +
          `Попроси отправителя поделиться заново, или открой Lexi со своими наборами:`,
        reply_markup: {
          inline_keyboard: [[
            { text: "🚀 Открыть Lexi", web_app: { url: APP_URL } }
          ]]
        }
      });
      return;
    }

    // ── Обычный /start без параметров ──
    await tgCall("sendMessage", {
      chat_id: msg.chat.id,
      parse_mode: "HTML",
      text:
        `👋 <b>${name}, привет!</b>\n\n` +

        `Читаешь статью на английском — и половина слов незнакома?\n` +
        `Смотришь сериал с субтитрами — но слова всё равно не запоминаются?\n\n` +

        `<b>Lexi решает это за 10 секунд.</b>\n\n` +

        `Просто вставь любой текст — ИИ сам вытащит ключевые слова, добавит переводы, транскрипцию и примеры. Получаются готовые карточки именно для <i>твоего</i> уровня.\n\n` +

        `<b>Что умеет Lexi:</b>\n` +
        `⚡️ Текст → карточки за секунды — статьи, субтитры, переписка\n` +
        `🃏 Флэшкарточки — листай и оценивай себя\n` +
        `✍️ Тест — пиши перевод сам, это работает лучше всего\n` +
        `📊 Прогресс — видишь, сколько слов уже знаешь\n\n` +

        `Поддерживает <b>12 языков</b>: 🇬🇧 EN · 🇩🇪 DE · 🇪🇸 ES · 🇫🇷 FR · 🇮🇹 IT · 🇨🇳 ZH · 🇯🇵 JA · 🇰🇷 KO и другие\n\n` +

        `Попробуй прямо сейчас — первые карточки готовы через минуту 👇`,
      reply_markup: {
        inline_keyboard: [[
          { text: "🚀 Открыть Lexi", web_app: { url: APP_URL } }
        ]]
      }
    });
  }
});

// Проверка, что сервер жив
app.get("/", (req, res) => {
  res.send("Lexi AI server is running ✓");
});

// ════════════════════════════════════════════════════════════
//  POST /api/share — пользователь делится своим набором.
//  Принимает: { deck: {...} }
//  Отдаёт:   { uuid, share_url } — ссылку на t.me/<bot>?start=set_<uuid>
// ════════════════════════════════════════════════════════════
app.post("/api/share", (req, res) => {
  try {
    const deck = req.body?.deck;
    if (!deck || !deck.name || !Array.isArray(deck.cards) || !deck.cards.length) {
      return res.status(400).json({ error: "Некорректный набор" });
    }
    // Лимит размера — защита от злоупотреблений
    const size = JSON.stringify(deck).length;
    if (size > MAX_DECK_BYTES) {
      return res.status(413).json({ error: "Набор слишком большой для шаринга" });
    }

    const uuid = randomUUID();
    SHARED_DECKS.set(uuid, {
      deck: {
        name: String(deck.name).slice(0, 80),
        icon: String(deck.icon || "📚").slice(0, 8),
        desc: String(deck.desc || "").slice(0, 200),
        level: String(deck.level || "B1").slice(0, 5),
        grad: Array.isArray(deck.grad) ? deck.grad.slice(0, 2) : ["#3B5EFF", "#7250FF"],
        cards: deck.cards.map(c => ({
          w:    String(c.w    || "").slice(0, 100),
          lang: String(c.lang || "en").slice(0, 5),
          t:    String(c.t    || "").slice(0, 200),
          tr:   String(c.tr   || "").slice(0, 80),
          pos:  String(c.pos  || "").slice(0, 30),
          lvl:  String(c.lvl  || "B1").slice(0, 5),
          ex:   String(c.ex   || "").slice(0, 240),
        })),
      },
      created_at: Date.now(),
    });

    // Telegram-нативная ссылка через бота — open сценарий «бот → web_app кнопка»
    const share_url = BOT_USERNAME
      ? `https://t.me/${BOT_USERNAME}?start=set_${uuid}`
      : `${APP_URL}?set=${uuid}`;

    return res.json({ uuid, share_url });
  } catch (e) {
    console.error("share error:", e);
    return res.status(500).json({ error: "Ошибка при создании ссылки" });
  }
});

// ════════════════════════════════════════════════════════════
//  GET /api/share/:uuid — получатель открыл ссылку, фронт тянет деку.
//  Отдаёт: { deck, uuid } или 404 «Набор недоступен»
// ════════════════════════════════════════════════════════════
app.get("/api/share/:uuid", (req, res) => {
  const uuid = String(req.params.uuid || "").trim();
  const entry = SHARED_DECKS.get(uuid);
  if (!entry) {
    return res.status(404).json({ error: "Набор недоступен или был удалён" });
  }
  return res.json({ uuid, deck: entry.deck });
});

// ════════════════════════════════════════════════════════════
//  POST /api/pending-deck — Mini App при старте спрашивает:
//  «есть ли набор, который ждёт меня от бота?»
//  Проверяем initData (HMAC), смотрим PENDING_DECKS[user_id],
//  отдаём набор и удаляем из очереди (consume-once).
// ════════════════════════════════════════════════════════════
app.post("/api/pending-deck", (req, res) => {
  const initData = req.body?.initData;
  const user = verifyInitData(initData);
  if (!user) {
    return res.status(401).json({ error: "initData invalid", deck: null });
  }
  const key = String(user.id);
  const pending = PENDING_DECKS.get(key);
  if (!pending) return res.json({ deck: null });

  const entry = SHARED_DECKS.get(pending.uuid);
  if (!entry) {
    // Набор удалён — чистим pending
    PENDING_DECKS.delete(key);
    return res.json({ deck: null });
  }

  // Consume — забираем один раз, чтобы не добавлялось при каждом открытии
  PENDING_DECKS.delete(key);
  return res.json({
    deck: entry.deck,
    source_set_id: pending.uuid,
  });
});

// ── Основной маршрут: разбор текста в карточки ──
app.post("/api/parse", async (req, res) => {
  try {
    const text = (req.body && req.body.text ? String(req.body.text) : "").trim();
    const targetLang = (req.body && req.body.targetLang) ? String(req.body.targetLang) : "ru";

    if (text.length < 3) {
      return res.status(400).json({ error: "Текст слишком короткий" });
    }
    if (!OPENAI_API_KEY) {
      return res.status(500).json({ error: "Ключ OpenAI не настроен на сервере" });
    }

    // защита от слишком больших текстов (контроль стоимости)
    const safeText = text.slice(0, 6000);

    // Карта языков: код -> название (чтобы модель точно поняла)
    const LANG_NAMES = {
      ru: "русский", en: "английский", es: "испанский", de: "немецкий",
      fr: "французский", it: "итальянский", zh: "китайский", ja: "японский",
      ko: "корейский", pt: "португальский", tr: "турецкий", ar: "арабский"
    };
    const targetName = LANG_NAMES[targetLang] || "русский";

    // ── Системный промпт: умный, исчерпывающий отбор лексики по уровню CEFR ──
    const systemPrompt = `Ты — модуль обработки текста для приложения изучения иностранных слов в формате карточек (как Quizlet).

ТВОЯ ЗАДАЧА: пройти по ВСЕМУ тексту и извлечь ИСЧЕРПЫВАЮЩИЙ список ВСЕЙ ценной для изучения лексики. Не пропускай предложения, разбирай текст до конца.

═══ ШАГ 1. ОЦЕНИ УРОВЕНЬ ТЕКСТА ═══
Определи общий уровень сложности по CEFR: A1, A2, B1, B2, C1 или C2.

═══ ШАГ 2. ЧТО ПРОПУСКАТЬ ═══
Пропускай ТОЛЬКО самые тривиальные слова, которые знает любой школьник на этом уровне:
• A1/A2 (всегда пропускай в текстах B2+): be, have, do, go, come, get, make, see, say, know, want, give, take, like, good, big, new, old, time, day, year, man, woman, house, car, this, that, here, there...
• Служебные слова сами по себе: артикли (the, a), предлоги (in, on, at), союзы (and, but, or), местоимения (he, she, it), частицы.

ВСЁ ОСТАЛЬНОЕ — БЕРИ. Особенно если это:
✓ академическая лексика (analyse, emerge, argue, constitute, propose, develop, emphasise, reconcile, contradict, stimulate)
✓ профессиональные термины (philosopher-king, behaviouralism, theology, ideology, typology, dogma)
✓ прилагательные и наречия со смыслом (empirical, secular, decisive, theological, dominant, dual, distinct)
✓ существительные с понятием (loyalty, authority, governance, civilisation, framework, approach, tradition)
✓ фразовые глаголы, идиомы, коллокации, устойчивые выражения — ВСЕ без исключения

ВАЖНО: если сомневаешься «брать или не брать» — БЕРИ. Лучше дать пользователю выбор, чем урезать пользу.

═══ ШАГ 3. СОХРАНЯЙ УСТОЙЧИВЫЕ ВЫРАЖЕНИЯ ЦЕЛИКОМ ═══
Если служебное слово входит в устойчивое выражение, фразовый глагол, идиому или коллокацию — сохраняй ВСЁ выражение как ОДНУ карточку.

✓ ПРАВИЛЬНО: turn out, look after, give up, in charge of, at least, by the way, as a result, take into account, come across, run into, rule of law, common good, clash of civilizations
✗ НЕПРАВИЛЬНО: дробить эти конструкции на отдельные слова

═══ ШАГ 4. ПРИОРИТЕТ ОТБОРА ═══
1. устойчивые выражения и идиомы
2. фразовые глаголы
3. значимые коллокации (rapid growth, dominant approach, value-free analysis)
4. тематическая и профессиональная лексика
5. абстрактные существительные, глаголы и прилагательные академического стиля
6. остальные полезные слова

═══ ШАГ 5. КОЛИЧЕСТВО ═══
НЕТ верхнего лимита. Длинные академические тексты обычно дают 30–60+ карточек, художественные — 20–40, диалоги — 10–25. Не останавливайся раньше, чем закончится текст.

ОБЯЗАТЕЛЬНО проходи КАЖДЫЙ абзац до конца. Не пропускай вторую половину текста.

═══ ФОРМАТ ОТВЕТА ═══
Верни строго JSON-объект:
{"text_level":"B2","cards":[{...},{...},...]}

Каждая карточка:
• w — словарная (начальная) форма слова ИЛИ устойчивого выражения целиком. Существительные/прилагательные — им. падеж ед.ч., глаголы — инфинитив, выражения — канонический вид. НИКОГДА не копируй слово в форме из текста.
• lang — код языка ISO 639-1 (en, de, fr, es, it, zh, ja, ko, pt, tr, ar, ru)
• t — до 3 переводов на ${targetName}, через " / ". Самый частый — первым. Например: "встреча / собрание / совещание". Никогда не пустое.
• tr — IPA-транскрипция, если применимо; иначе пустая строка
• pos — тип на русском: сущ., глаг., прил., нареч., фраз. глаг., выраж., идиома, коллок.
• lvl — CEFR уровень САМОЙ единицы: A1, A2, B1, B2, C1 или C2
• ex — короткий пример (можно из текста)

Если исходный текст уже на ${targetName} языке — переводи на английский.

Верни ТОЛЬКО валидный JSON. Без markdown, без пояснений. Дубли запрещены.`;

    // Запрос к OpenAI
    const aiResp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + OPENAI_API_KEY,
      },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0.2,                       // ниже температура → стабильнее покрытие
        max_tokens: 8000,                       // запас под 60+ карточек с переводами
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: safeText },
        ],
      }),
    });

    if (!aiResp.ok) {
      const errText = await aiResp.text();
      console.error("OpenAI error:", aiResp.status, errText);
      return res.status(502).json({ error: "Ошибка обращения к AI" });
    }

    const data = await aiResp.json();
    const raw = data.choices?.[0]?.message?.content || "{}";

    // Парсим ответ модели
    let cards = [];
    let textLevel = "";
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        cards = parsed;
      } else {
        cards = parsed.cards || [];
        textLevel = String(parsed.text_level || "").trim().toUpperCase();
      }
    } catch (e) {
      console.error("JSON parse fail:", raw);
      return res.status(502).json({ error: "AI вернул неожиданный формат" });
    }

    // Допустимые CEFR-уровни — нормализуем
    const VALID_LVL = new Set(["A1", "A2", "B1", "B2", "C1", "C2"]);
    const cleanLvl = (v) => {
      const x = String(v || "").trim().toUpperCase();
      return VALID_LVL.has(x) ? x : "B1";
    };

    // Удаляем дубли по словарной форме (нормализованной)
    const seen = new Set();

    // Лимита нет — сколько ИИ нашёл полезной лексики, столько и отдаём
    const clean = cards
      .filter(c => c && c.w && String(c.w).trim())
      .map(c => ({
        w:   String(c.w  || "").trim(),
        lang: String(c.lang || "en").trim().toLowerCase().slice(0, 5),
        t:   String(c.t  || "").trim(),
        tr:  String(c.tr || "").trim(),
        pos: String(c.pos || "").trim(),
        lvl: cleanLvl(c.lvl),
        ex:  String(c.ex || "").trim(),
      }))
      .filter(c => {
        if (!c.t) return false;                        // нет перевода → выкидываем
        const key = c.w.toLowerCase();
        if (seen.has(key)) return false;               // дубль
        seen.add(key);
        return true;
      });

    return res.json({
      cards: clean,
      text_level: VALID_LVL.has(textLevel) ? textLevel : ""
    });
  } catch (err) {
    console.error("Server error:", err);
    return res.status(500).json({ error: "Внутренняя ошибка сервера" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log("Lexi AI server started on port " + PORT);

  if (!BOT_TOKEN) return;

  // 0a. Узнаём username бота — нужен для генерации share-ссылок t.me/<bot>?start=...
  const me = await tgCall("getMe", {});
  BOT_USERNAME = me?.result?.username || null;
  console.log("Bot username:", BOT_USERNAME || "(unknown)");

  // 0b. Регистрируем webhook — говорим Telegram, куда слать обновления
  await tgCall("setWebhook", {
    url: `${APP_URL}/webhook`,
    allowed_updates: ["message"]
  }).catch(e => console.error("setWebhook error:", e));
  console.log("Webhook registered:", `${APP_URL}/webhook`);

  // 1. Кнопка меню → открывает Mini App
  await tgCall("setChatMenuButton", {
    menu_button: { type: "web_app", text: "Открыть", web_app: { url: APP_URL } }
  }).catch(() => {});
  console.log("Menu button set");

  // 2. Краткое описание — показывается в профиле бота (до 120 символов)
  await tgCall("setMyShortDescription", {
    short_description:
      "ИИ превращает любой текст в флэшкарточки. Учи слова из статей, субтитров и переписок — 12 языков."
  }).catch(() => {});
  console.log("Short description set");

  // 3. Полное описание — показывается в чате ДО нажатия кнопки Start (до 512 символов)
  await tgCall("setMyDescription", {
    description:
      "Lexi — языковой тренажёр, который работает с твоим контентом.\n\n" +
      "Вместо заучивания чужих списков — вставляешь любой текст на нужном языке, " +
      "и за несколько секунд получаешь готовые карточки: слово, перевод, транскрипция, пример.\n\n" +
      "Затем учишь в удобном формате:\n" +
      "🃏 Флэшкарточки — листай и оценивай себя\n" +
      "✍️ Тест — пиши перевод по памяти\n" +
      "📊 Прогресс — видишь рост с каждой сессией\n\n" +
      "Поддерживает 12 языков: EN, DE, ES, FR, IT, ZH, JA, KO, PT, TR, AR и другие.\n\n" +
      "Нажми «Начать» — первые карточки готовы через минуту."
  }).catch(() => {});
  console.log("Description set");

  // 4. Список команд бота (отображается в меню / подсказке)
  await tgCall("setMyCommands", {
    commands: [
      { command: "start", description: "Открыть Lexi — учим слова с ИИ" }
    ]
  }).catch(() => {});
  console.log("Commands set");
});
