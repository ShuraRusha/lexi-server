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
    const safeText = text.slice(0, 6000);

    // Карта языков: код -> название (чтобы модель точно поняла)
    const LANG_NAMES = {
      ru: "русский", en: "английский", es: "испанский", de: "немецкий",
      fr: "французский", it: "итальянский", zh: "китайский", ja: "японский",
      ko: "корейский", pt: "португальский", tr: "турецкий", ar: "арабский"
    };
    const targetName = LANG_NAMES[targetLang] || "русский";

    // ── Системный промпт: умный отбор лексики по уровню CEFR ──
    const systemPrompt = `Ты — модуль интеллектуальной обработки текста для приложения по изучению иностранных слов в формате карточек (как Quizlet).

═══ ШАГ 1. ОЦЕНИ УРОВЕНЬ ТЕКСТА ═══
Определи общий уровень сложности по CEFR: A1, A2, B1, B2, C1 или C2.

═══ ШАГ 2. ОТБИРАЙ ЛЕКСИКУ ПО УРОВНЮ ═══
• Если текст уровня B2, C1, C2 — НЕ включай очевидные базовые слова уровней A1, A2 и часто B1. Бери: сложную, редкую, академическую, профессиональную лексику, устойчивые выражения, фразовые глаголы, идиомы, значимые коллокации.
• Если текст уровня A1, A2, B1 — включай и базовую лексику тоже. На этом уровне базовые слова полезны.

═══ ШАГ 3. ПРОПУСКАЙ СЛУЖЕБНЫЕ СЛОВА ═══
НИКОГДА не создавай отдельные карточки для:
артиклей, предлогов, частиц, союзов, местоимений, вспомогательных глаголов — ЕСЛИ они стоят сами по себе.

═══ ШАГ 4. СОХРАНЯЙ УСТОЙЧИВЫЕ ВЫРАЖЕНИЯ ЦЕЛИКОМ ═══
Если служебное слово входит в устойчивое выражение, фразовый глагол, идиому или коллокацию — сохраняй ВСЁ выражение как ОДНУ карточку.

✓ ПРАВИЛЬНО: turn out, look after, give up, in charge of, at least, by the way, as a result, take into account, come across, run into
✗ НЕПРАВИЛЬНО: дробить эти конструкции на отдельные слова (turn + out, look + after, ...)

═══ ШАГ 5. ПРИОРИТЕТ ОТБОРА (от высшего к низшему) ═══
1. устойчивые выражения
2. фразовые глаголы
3. идиомы
4. значимые коллокации
5. тематическая и профессиональная лексика
6. отдельные слова, если они действительно полезны

═══ ШАГ 6. КОЛИЧЕСТВО ═══
НЕ ограничивай искусственно. Сколько в тексте полезной лексики — столько карточек.
ГЛАВНОЕ: лучше меньше, но качественных, чем много мусорных. Избегай дублей и очевидных слов для уровня текста.

═══ ФОРМАТ ОТВЕТА ═══
Верни строго JSON-объект:
{"text_level":"B2","cards":[{...}]}

Каждая карточка:
• w — словарная (начальная) форма слова ИЛИ устойчивого выражения целиком. Существительные/прилагательные — им. падеж ед.ч., глаголы — инфинитив, выражения — канонический вид. НИКОГДА не копируй слово в форме из текста.
• lang — код языка ISO 639-1 (en, de, fr, es, it, zh, ja, ko, pt, tr, ar, ru)
• t — до 3 переводов на ${targetName}, через " / ". Самый частый — первым. Например: "встреча / собрание / совещание". Никогда не пустое.
• tr — IPA-транскрипция, если применимо; иначе пустая строка
• pos — тип на русском: сущ., глаг., прил., нареч., фраз. глаг., выраж., идиома, коллок.
• lvl — CEFR уровень САМОЙ единицы: A1, A2, B1, B2, C1 или C2
• ex — короткий пример употребления из текста или похожий

Если исходный текст уже на ${targetName} языке — переводи на английский.

Верни ТОЛЬКО валидный JSON. Без markdown, без пояснений.`;

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
