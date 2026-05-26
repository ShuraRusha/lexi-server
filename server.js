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

const __dirname = dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(cors());                       // разрешаем запросы из браузера/Telegram
app.use(express.json({ limit: "1mb" })); // принимаем JSON, ограничиваем размер
app.use(express.static(join(__dirname, "public"))); // фронтенд Telegram Mini App

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const BOT_TOKEN      = process.env.BOT_TOKEN;
const APP_URL        = "https://lexi-server-production.up.railway.app";
const MODEL          = "gpt-4o-mini";

// ── Telegram Bot API helper ──
async function tgCall(method, body) {
  if (!BOT_TOKEN) return;
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }).catch(e => console.error("TG error:", e));
}

// ── Webhook от Telegram ──
app.post("/webhook", async (req, res) => {
  res.sendStatus(200); // отвечаем сразу — Telegram не ждёт
  const msg = req.body?.message;
  if (!msg) return;

  if (msg.text === "/start" || msg.text?.startsWith("/start ")) {
    const name = msg.from?.first_name || "друг";
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
    const safeText = text.slice(0, 4000);

    // Карта языков: код -> название (чтобы модель точно поняла)
    const LANG_NAMES = {
      ru: "русский", en: "английский", es: "испанский", de: "немецкий",
      fr: "французский", it: "итальянский", zh: "китайский", ja: "японский",
      ko: "корейский", pt: "португальский", tr: "турецкий", ar: "арабский"
    };
    const targetName = LANG_NAMES[targetLang] || "русский";

    // Инструкция модели. Просим строго JSON, без лишнего текста.
    const systemPrompt =
      "Ты — помощник для изучения языков. Тебе дают произвольный текст. " +
      "Определи язык текста, выдели до 15 наиболее полезных для изучения слов и устойчивых выражений " +
      "(исключи служебные слова: артикли, предлоги, местоимения, союзы). " +
      "ВАЖНО: поле w — всегда словарная (начальная) форма слова или устойчивого выражения: " +
      "существительные и прилагательные — именительный падеж единственного числа, " +
      "глаголы — инфинитив, устойчивые выражения — канонический вид. " +
      "Никогда не копируй слово в той форме, в которой оно стоит в тексте — только словарная форма. " +
      "Для каждой единицы верни: словарную форму (поле w), код языка ISO 639-1 (поле lang), " +
      "ОБЯЗАТЕЛЬНО для поля t — перечисли до 3 наиболее употребительных переводов на " + targetName + " язык, " +
      "разделяя их знаком `/`. Например: `встреча / собрание / совещание` или `думать / размышлять`. " +
      "Никогда не оставляй поле t пустым. Ставь на первое место самый частотный перевод. " +
      "транскрипцию IPA если применимо иначе пустую строку (поле tr), " +
      "часть речи коротко по-русски: сущ., глаг., прил., нареч. и т.п. (поле pos), " +
      "уровень сложности CEFR A1..C2 (поле lvl), и короткий пример употребления (поле ex). " +
      "Если исходный текст уже на " + targetName + " языке — переводи на английский. " +
      "Верни ТОЛЬКО валидный JSON-объект вида {\"cards\":[...]}, без markdown и пояснений. " +
      'Формат элемента: {"w":"...","lang":"en","t":"перевод1 / перевод2","tr":"/.../","pos":"сущ.","lvl":"B1","ex":"..."}';

    // Запрос к OpenAI
    const aiResp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + OPENAI_API_KEY,
      },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0.3,
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
    try {
      const parsed = JSON.parse(raw);
      cards = Array.isArray(parsed) ? parsed : (parsed.cards || []);
    } catch (e) {
      console.error("JSON parse fail:", raw);
      return res.status(502).json({ error: "AI вернул неожиданный формат" });
    }

    // Нормализуем и подчищаем, чтобы фронтенд получил предсказуемые поля
    const clean = cards
      .filter(c => c && c.w)
      .slice(0, 15)
      .map(c => ({
        w:   String(c.w || "").trim(),
        lang: String(c.lang || "en").trim().toLowerCase(),
        t:   String(c.t || "").trim(),
        tr:  String(c.tr || "").trim(),
        pos: String(c.pos || "").trim(),
        lvl: String(c.lvl || "B1").trim(),
        ex:  String(c.ex || "").trim(),
      }));

    return res.json({ cards: clean });
  } catch (err) {
    console.error("Server error:", err);
    return res.status(500).json({ error: "Внутренняя ошибка сервера" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log("Lexi AI server started on port " + PORT);

  if (!BOT_TOKEN) return;

  // 0. Регистрируем webhook — говорим Telegram, куда слать обновления
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
