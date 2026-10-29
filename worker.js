import { PDFDocument, rgb } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";

// Встроенные шрифты (также можно загрузить любой свой .ttf файл через нижнее меню админа)
const FONTS = {
  roboto: {
    name: "Roboto Bold",
    url: "https://cdn.jsdelivr.net/gh/googlefonts/roboto@main/src/hinted/Roboto-Bold.ttf"
  },
  roboto_reg: {
    name: "Roboto Regular",
    url: "https://cdn.jsdelivr.net/gh/googlefonts/roboto@main/src/hinted/Roboto-Regular.ttf"
  },
  montserrat: {
    name: "Montserrat",
    url: "https://cdn.jsdelivr.net/gh/JulietaUla/Montserrat@master/fonts/ttf/Montserrat-Bold.ttf"
  },
  cormorant: {
    name: "Cormorant",
    url: "https://cdn.jsdelivr.net/gh/CatharsisFonts/Cormorant@master/fonts/ttf/CormorantGaramond-Bold.ttf"
  },
  tiktoksans: {
    name: "TikTok Sans Regular",
    url: "https://cdn.jsdelivr.net/gh/tiktok/TikTokSans@main/fonts/ttf/TikTokSans-Regular.ttf"
  },
  custom: {
    name: "Свой шрифт (.ttf из памяти)",
    url: null
  }
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/setup") {
      const webhookUrl = `${url.origin}/webhook`;
      const res = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/setWebhook?url=${encodeURIComponent(webhookUrl)}`);
      const data = await res.json();
      return new Response(JSON.stringify({ status: "Webhook установлен", telegram_response: data }, null, 2), {
        headers: { "Content-Type": "application/json; charset=utf-8" }
      });
    }

    if (url.pathname === "/webhook" && request.method === "POST") {
      const update = await request.json();
      ctx.waitUntil(handleUpdate(update, env));
      return new Response("OK", { status: 200 });
    }

    return new Response("Бот работает! Перейдите на /setup чтобы подключить Telegram Webhook.", {
      headers: { "Content-Type": "text/plain; charset=utf-8" }
    });
  }
};

// ================= TELEGRAM API =================
async function tg(env, method, body) {
  const res = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  return res.json();
}

async function sendDocument(env, chatId, bytes, filename, mimeType, caption, replyMarkup = null) {
  const formData = new FormData();
  formData.append("chat_id", String(chatId));
  formData.append("caption", caption);
  formData.append("document", new Blob([bytes], { type: mimeType }), filename);
  if (replyMarkup) {
    formData.append("reply_markup", JSON.stringify(replyMarkup));
  }

  await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendDocument`, {
    method: "POST",
    body: formData
  });
}

function isAdmin(userId, env) {
  const raw = env.ADMIN_IDS || "";
  const ids = raw.split(",").map(s => s.trim());
  return ids.includes(String(userId));
}

// ================= БАЗА ДАННЫХ CLOUDFLARE KV =================
async function getDB(env) {
  const data = await env.BOT_KV.get("DB_MAIN", "json");
  return data || { exams: {} };
}

async function saveDB(env, db) {
  await env.BOT_KV.put("DB_MAIN", JSON.stringify(db));
}

async function getUserData(env, userId) {
  const data = await env.BOT_KV.get(`USER_${userId}`, "json");
  return data || { state: null, temp: {}, attempts: {} };
}

async function saveUserData(env, userId, userData) {
  await env.BOT_KV.put(`USER_${userId}`, JSON.stringify(userData));
}

function findActiveAttemptExamId(user) {
  for (const [exId, att] of Object.entries(user.attempts || {})) {
    if (att && att.status === "active") return exId;
  }
  return null;
}

function ensureLayout(exam) {
  if (!exam.layout) {
    exam.layout = {
      fontKey: "roboto",
      name:  { dx: 0, y: 480, size: 42, color: "green" },
      grade: { dx: 0, y: 340, size: 32, onlyWord: false, color: "dark" },
      date:  { dx: 0, y: 200, size: 22, hide: false, color: "gray" }
    };
  }
  if (!exam.layout.fontKey || !FONTS[exam.layout.fontKey]) {
    exam.layout.fontKey = "roboto";
  }
  if (!exam.layout.name.color) exam.layout.name.color = "green";
  if (!exam.layout.grade.color) exam.layout.grade.color = "dark";
  if (!exam.layout.date.color) exam.layout.date.color = "gray";
  return exam.layout;
}

function parseColor(cName) {
  switch (cName) {
    case "black": return rgb(0.05, 0.05, 0.05);
    case "gold":  return rgb(0.77, 0.63, 0.35);
    case "white": return rgb(1.0, 1.0, 1.0);
    case "dark":  return rgb(0.2, 0.2, 0.2);
    case "gray":  return rgb(0.4, 0.4, 0.4);
    case "green":
    default:      return rgb(0.1, 0.25, 0.15);
  }
}

// ================= КОНСТРУКТОРЫ НИЖНИХ КЛАВИАТУР =================
function buildReplyKb(rows) {
  return {
    keyboard: rows,
    resize_keyboard: true,
    is_persistent: true
  };
}

function getStudentMainKb(userId, env, hasActiveExam = false) {
  const rows = [
    [{ text: "📝 Сдать экзамен" }, { text: "📜 Мои экзамены и сертификаты" }]
  ];
  if (hasActiveExam) {
    rows.push([{ text: "❌ Отменить экзамен" }]);
  }
  if (isAdmin(userId, env)) {
    rows.push([{ text: "⚙️ Админ-панель" }]);
  }
  return buildReplyKb(rows);
}

function getCancelKb(label = "◀️ Отмена") {
  return buildReplyKb([[{ text: label }]]);
}

function getQuestionReplyKb(questions, index, answers) {
  const total = questions.length;
  const currentAns = answers[index];

  const rows = [
    ["А", "Б", "В"].map(k => ({
      text: currentAns === k ? `✅ Вариант ${k}` : `Вариант ${k}`
    }))
  ];

  const nav = [];
  if (index > 0) nav.push({ text: "◀️ Предыдущий вопрос" });
  if (index < total - 1) nav.push({ text: "Следующий вопрос ▶️" });
  if (nav.length > 0) rows.push(nav);

  if (Object.keys(answers).length === total || index === total - 1) {
    rows.push([{ text: "✅ Завершить экзамен" }]);
  }

  rows.push([{ text: "❌ Отменить экзамен" }]);
  return buildReplyKb(rows);
}

function getStudentExamDetailKb(ex, att) {
  const passed = att.status === "completed" && (att.percent || 0) >= ex.passPercent;
  const rows = [];

  if (att.canRetake) {
    rows.push([{ text: "🔄 Пересдать этот экзамен сейчас" }]);
  }
  if (passed) {
    rows.push([{ text: "📜 Получить сертификат повторно (PDF)" }]);
  }
  if (att.status === "completed" && att.answers && Object.keys(att.answers).length > 0) {
    rows.push([{ text: "📄 Скачать детальный разбор ответов (TXT)" }]);
  }
  if (!att.canRetake) {
    rows.push([{ text: "🔄 Запросить возможность пересдачи" }]);
  }
  rows.push([{ text: "◀️ К списку моих экзаменов" }, { text: "🏠 В главное меню" }]);

  return buildReplyKb(rows);
}

function getAdminMainKb() {
  return buildReplyKb([
    [{ text: "📚 Список экзаменов" }, { text: "➕ Создать экзамен" }],
    [{ text: "🔤 Загрузить шрифт (.ttf)" }, { text: "⬅️ Режим ученика" }]
  ]);
}

function getAdminExamManageKb() {
  return buildReplyKb([
    [{ text: "➕ Добавить вопрос" }, { text: "🔑 Изменить пароль" }],
    [{ text: "🖼 Загрузить шаблон" }, { text: "🎛 Пульт сертификата" }],
    [{ text: "🔄 Выдать пересдачу по ID" }, { text: "🎯 Изменить проходной %" }],
    [{ text: "🗑 Очистить вопросы" }, { text: "❌ Удалить экзамен" }],
    [{ text: "◀️ К списку экзаменов" }, { text: "⚙️ В админ-меню" }]
  ]);
}

function getJoystickReplyKb(layout, activeTarget) {
  const cur = layout[activeTarget];
  const rows = [
    [
      { text: `${activeTarget === "name" ? "🟢 " : ""}👤 Имя` },
      { text: `${activeTarget === "grade" ? "🟢 " : ""}⭐️ Оценка` },
      { text: `${activeTarget === "date" ? "🟢 " : ""}📅 Дата` }
    ],
    [
      { text: "⬆️ Выше (+20)" },
      { text: "🔼 Выше (+5)" },
      { text: "🔽 Ниже (-5)" },
      { text: "⬇️ Ниже (-20)" }
    ],
    [
      { text: "⬅️ Влево" },
      { text: "🎯 По центру" },
      { text: "➡️ Вправо" }
    ],
    [
      { text: "➖ Шрифт мельче" },
      { text: "➕ Шрифт крупнее" }
    ],
    [
      { text: `${cur.color === "green" ? "✅ " : ""}🎨 Зеленый` },
      { text: `${cur.color === "gold" ? "✅ " : ""}🎨 Золотой` },
      { text: `${cur.color === "black" ? "✅ " : ""}🎨 Черный` },
      { text: `${cur.color === "white" ? "✅ " : ""}🎨 Белый` }
    ],
    [
      { text: `${layout.fontKey === "roboto" ? "✅ " : ""}🔤 Roboto` },
      { text: `${layout.fontKey === "montserrat" ? "✅ " : ""}🔤 Montserrat` },
      { text: `${layout.fontKey === "cormorant" ? "✅ " : ""}🔤 Cormorant` }
    ],
    [
      { text: `${layout.fontKey === "tiktoksans" ? "✅ " : ""}🔤 TikTok Sans` },
      { text: `${layout.fontKey === "custom" ? "✅ " : ""}🔤 Свой .ttf` }
    ]
  ];

  if (activeTarget === "grade") {
    rows.push([{ text: cur.onlyWord ? "📝 Писать «Оценка: Отлично»" : "📝 Писать только «Отлично»" }]);
  }
  if (activeTarget === "date") {
    rows.push([{ text: cur.hide ? "👁 Показать дату на сертификате" : "🙈 Скрыть дату с сертификата" }]);
  }

  rows.push([
    { text: "👁 Пробный PDF-сертификат" },
    { text: "◀️ Назад к экзамену" }
  ]);

  return buildReplyKb(rows);
}

// ================= МАРШРУТИЗАТОР =================
async function handleUpdate(update, env) {
  if (update.message) {
    await handleMessage(update.message, env);
  } else if (update.callback_query) {
    await tg(env, "answerCallbackQuery", {
      callback_query_id: update.callback_query.id,
      text: "Используйте кнопки внизу экрана 👇"
    });
  }
}

// ================= ЭКРАНЫ УЧЕНИКА =================
function formatQuestionText(questions, index, answers) {
  const q = questions[index];
  let text = `📝 *Вопрос ${index + 1} из ${questions.length}*\n\n${q.text}\n\nВарианты ответов:\n`;
  text += `*А)* ${q.options["А"]}\n\n*Б)* ${q.options["Б"]}\n\n*В)* ${q.options["В"]}\n\n`;
  const ans = answers[index];
  if (ans) {
    text += `✅ *Ваш выбор: ${ans}) ${q.options[ans]}*`;
  } else {
    text += `_Выберите вариант ответа на кнопках внизу экрана:_`;
  }
  return text;
}

async function sendCurrentQuestion(chatId, exam, att, qIndex, env) {
  await tg(env, "sendMessage", {
    chat_id: chatId,
    text: formatQuestionText(exam.questions, qIndex, att.answers),
    reply_markup: getQuestionReplyKb(exam.questions, qIndex, att.answers),
    parse_mode: "Markdown"
  });
}

async function startStudentExam(chatId, userId, examId, exam, user, env) {
  const prevName = user.attempts?.[examId]?.fullName || null;
  user.attempts[examId] = {
    status: "active",
    answers: {},
    canRetake: false,
    ...(prevName ? { fullName: prevName } : {})
  };
  user.state = "EXAM_IN_PROGRESS";
  user.temp = { examId, qIndex: 0 };
  await saveUserData(env, userId, user);

  await tg(env, "sendMessage", {
    chat_id: chatId,
    text: `🎓 *Экзамен начался!*\n📚 *${exam.title}*\n\nВсего вопросов: ${exam.questions.length}.\nИспользуйте кнопки внизу экрана для выбора ответов и переключения вопросов.`,
    parse_mode: "Markdown"
  });

  await sendCurrentQuestion(chatId, exam, user.attempts[examId], 0, env);
}

function getCompletedOrRetakeEntries(user) {
  return Object.entries(user.attempts || {}).filter(
    ([, att]) => att && (att.status === "completed" || att.status === "cancelled" || att.canRetake)
  );
}

async function sendStudentExamsList(chatId, userId, db, user, env) {
  const entries = getCompletedOrRetakeEntries(user);

  if (entries.length === 0) {
    user.state = null;
    await saveUserData(env, userId, user);
    await tg(env, "sendMessage", {
      chat_id: chatId,
      text: "📜 У вас пока нет сданных экзаменов.\n\nНажмите кнопку *«📝 Сдать экзамен»* внизу экрана, чтобы начать.",
      reply_markup: getStudentMainKb(userId, env, Boolean(findActiveAttemptExamId(user))),
      parse_mode: "Markdown"
    });
    return;
  }

  const examList = [];
  const rows = [];

  entries.forEach(([exId, att], idx) => {
    const ex = db.exams[exId];
    const title = ex ? ex.title : "Удаленный экзамен";
    let badge = "";
    if (att.canRetake) {
      badge = "🔄 Пересдача открыта";
    } else if (att.status === "cancelled") {
      badge = "❌ Отменен";
    } else {
      badge = `${att.gradeClean || "Завершен"} (${(att.percent || 0).toFixed(0)}%)`;
    }
    examList.push(exId);
    rows.push([{ text: `📘 ${idx + 1}. ${title} — ${badge}` }]);
  });

  rows.push([{ text: "🏠 В главное меню" }]);

  user.state = "MY_EXAMS_LIST";
  user.temp = { ...user.temp, myExamList: examList };
  await saveUserData(env, userId, user);

  await tg(env, "sendMessage", {
    chat_id: chatId,
    text: "🎓 *Ваши экзамены и сертификаты:*\n\nНажмите на нужный предмет на клавиатуре внизу экрана, чтобы посмотреть дату сдачи, оценку, скачать сертификат или пересдать экзамен:",
    reply_markup: buildReplyKb(rows),
    parse_mode: "Markdown"
  });
}

async function sendStudentExamDetail(chatId, userId, examId, db, user, env) {
  const ex = db.exams[examId];
  const att = user.attempts?.[examId];

  if (!ex || !att) {
    await tg(env, "sendMessage", {
      chat_id: chatId,
      text: "⚠️ Информация об экзамене не найдена."
    });
    await sendStudentExamsList(chatId, userId, db, user, env);
    return;
  }

  const dateText = att.dateStr || "Ранее";
  const gradeText = att.status === "completed"
    ? `${att.gradeClean} (${(att.percent || 0).toFixed(1)}%)`
    : (att.canRetake ? "Ожидает пересдачи 🔄" : "Экзамен был отменен ❌");
  const scoreDetail = att.status === "completed" ? `${att.correctCount || 0} из ${ex.questions.length}` : "—";
  const retakeStatus = att.canRetake ? "✅ Доступна пересдача (нажмите кнопку внизу)" : "❌ Попытка использована";

  const text =
    `📘 *Предмет:* ${ex.title}\n` +
    `📅 *Дата сдачи:* ${dateText}\n` +
    `🎯 *Оценка:* ${gradeText}\n` +
    `📊 *Правильных ответов:* ${scoreDetail}\n` +
    `👤 *Имя в сертификате:* ${att.fullName || "не указано"}\n` +
    `🔄 *Статус пересдачи:* ${retakeStatus}\n\n` +
    `_Выберите действие на кнопках внизу экрана:_`;

  user.state = "MY_EXAM_DETAIL";
  user.temp = { ...user.temp, viewExamId: examId };
  await saveUserData(env, userId, user);

  await tg(env, "sendMessage", {
    chat_id: chatId,
    text,
    reply_markup: getStudentExamDetailKb(ex, att),
    parse_mode: "Markdown"
  });
}

// ================= ЭКРАНЫ АДМИНИСТРАТОРА =================
async function sendAdminMain(chatId, userId, db, user, env) {
  user.state = "ADMIN_MAIN";
  user.temp = {};
  await saveUserData(env, userId, user);

  const totalExams = Object.keys(db.exams).length;
  const text = `⚙️ *Панель администратора*\n\nВсего создано экзаменов: *${totalExams}*\nВыберите действие на кнопках внизу экрана 👇`;
  await tg(env, "sendMessage", {
    chat_id: chatId,
    text,
    reply_markup: getAdminMainKb(),
    parse_mode: "Markdown"
  });
}

async function sendAdminExamList(chatId, userId, db, user, env) {
  const exams = Object.values(db.exams);
  if (exams.length === 0) {
    await tg(env, "sendMessage", {
      chat_id: chatId,
      text: "Список экзаменов пуст. Нажмите «➕ Создать экзамен» внизу экрана!",
      reply_markup: getAdminMainKb()
    });
    return;
  }

  const adminExamList = [];
  const rows = [];
  exams.forEach((ex, idx) => {
    adminExamList.push(ex.id);
    rows.push([{ text: `🛠 ${idx + 1}. ${ex.title} | 🔑 ${ex.password || "—"} (${ex.questions.length} вопр.)` }]);
  });
  rows.push([{ text: "➕ Создать экзамен" }, { text: "⚙️ В админ-меню" }]);

  user.state = "ADM_EXAM_LIST";
  user.temp = { ...user.temp, adminExamList };
  await saveUserData(env, userId, user);

  await tg(env, "sendMessage", {
    chat_id: chatId,
    text: "📚 *Выберите экзамен на кнопках внизу экрана для настройки:*",
    reply_markup: buildReplyKb(rows),
    parse_mode: "Markdown"
  });
}

async function sendExamManage(chatId, userId, db, examId, user, env) {
  const ex = db.exams[examId];
  if (!ex) {
    await sendAdminExamList(chatId, userId, db, user, env);
    return;
  }
  ensureLayout(ex);

  user.state = "ADM_EXAM_MANAGE";
  user.temp = { examId };
  await saveUserData(env, userId, user);

  const text =
    `📋 *Управление экзаменом:* ${ex.title}\n` +
    `🔑 *Пароль:* \`${ex.password || "не задан"}\`\n` +
    `🔢 *Вопросов:* ${ex.questions.length}\n` +
    `🎯 *Проходной балл:* ${ex.passPercent}%\n` +
    `🖼 *Шаблон сертификата:* ${ex.hasTemplate ? "✅ Загружен" : "❌ Стандартный"}\n` +
    `🔤 *Шрифт:* ${FONTS[ex.layout.fontKey]?.name || "Roboto"}\n\n` +
    `_Выберите нужное действие на нижней клавиатуре:_`;

  await tg(env, "sendMessage", {
    chat_id: chatId,
    text,
    reply_markup: getAdminExamManageKb(),
    parse_mode: "Markdown"
  });
}

async function sendCertJoystick(chatId, userId, db, examId, target, user, env) {
  const ex = db.exams[examId];
  if (!ex) return;
  const layout = ensureLayout(ex);
  const activeTarget = ["name", "grade", "date"].includes(target) ? target : "name";
  const cur = layout[activeTarget];

  user.state = "ADM_JOYSTICK";
  user.temp = { examId, joyTarget: activeTarget };
  await saveUserData(env, userId, user);

  const titles = {
    name: "👤 Имя и Фамилия",
    grade: "⭐️ Оценка",
    date: "📅 Дата выдачи"
  };

  let extra = "";
  if (activeTarget === "grade") {
    extra = `\n• Формат: *${cur.onlyWord ? "Только оценка («Отлично»)" : "Со словом («Оценка: Отлично»)"}*`;
  } else if (activeTarget === "date") {
    extra = `\n• Показ даты: *${cur.hide ? "Скрыта" : "Показывается"}*`;
  }

  const text =
    `🎛 *Пульт сертификата «${ex.title}»*\n\n` +
    `Сейчас настраиваем: *${titles[activeTarget]}*\n` +
    `• Шрифт: *${FONTS[layout.fontKey]?.name || "Roboto"}*\n` +
    `• Высота (Y): \`${cur.y}\` | Сдвиг (X): \`${cur.dx}\`\n` +
    `• Размер шрифта: \`${cur.size}\` | Цвет: *${cur.color}*${extra}\n\n` +
    `_Нажимайте кнопки внизу экрана для настройки и проверки сертификата:_`;

  await tg(env, "sendMessage", {
    chat_id: chatId,
    text,
    reply_markup: getJoystickReplyKb(layout, activeTarget),
    parse_mode: "Markdown"
  });
}

// Помощник для определения выбранного экзамена ученика (даже если state сбился)
function resolveStudentTargetExamId(user) {
  if (user.temp?.viewExamId && user.attempts?.[user.temp.viewExamId]) {
    return user.temp.viewExamId;
  }
  // Ищем экзамен, где открыта пересдача
  for (const [exId, att] of Object.entries(user.attempts || {})) {
    if (att && att.canRetake) return exId;
  }
  // Иначе берем последний сданный
  const entries = getCompletedOrRetakeEntries(user);
  return entries.length ? entries[entries.length - 1][0] : null;
}

// ================= ОБРАБОТКА СООБЩЕНИЙ И КНОПОК =================
async function handleMessage(msg, env) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const text = (msg.text || "").trim();

  const db = await getDB(env);
  const user = await getUserData(env, userId);

  // --- 1. ГЛОБАЛЬНЫЕ КОМАНДЫ НАВИГАЦИИ ---
  if (text === "/start" || text === "🏠 В главное меню" || text === "⬅️ Режим ученика") {
    const activeExamId = findActiveAttemptExamId(user);
    if (activeExamId && text === "/start") {
      const ex = db.exams[activeExamId];
      const qIdx = user.temp?.qIndex || 0;
      await tg(env, "sendMessage", {
        chat_id: chatId,
        text: "⚠️ *У вас есть незавершенный экзамен!*\nПродолжайте отвечать на вопросы кнопками внизу или нажмите «❌ Отменить экзамен».",
        parse_mode: "Markdown"
      });
      if (ex) await sendCurrentQuestion(chatId, ex, user.attempts[activeExamId], qIdx, env);
      return;
    }

    user.state = null;
    user.temp = {};
    await saveUserData(env, userId, user);
    await tg(env, "sendMessage", {
      chat_id: chatId,
      text: `Ассаляму алейкум! Добро пожаловать в экзаменационный бот.\n\nВыберите нужное действие на кнопках внизу экрана 👇\nВаш Telegram ID: \`${userId}\``,
      reply_markup: getStudentMainKb(userId, env, Boolean(activeExamId)),
      parse_mode: "Markdown"
    });
    return;
  }

  if ((text === "/admin" || text === "⚙️ Админ-панель" || text === "⚙️ В админ-меню") && isAdmin(userId, env)) {
    await sendAdminMain(chatId, userId, db, user, env);
    return;
  }

  if (text === "/cancel" || text === "❌ Отменить экзамен") {
    const activeExamId = findActiveAttemptExamId(user);
    if (!activeExamId) {
      user.state = null;
      user.temp = {};
      await saveUserData(env, userId, user);
      await tg(env, "sendMessage", {
        chat_id: chatId,
        text: "У вас нет активного экзамена.",
        reply_markup: getStudentMainKb(userId, env, false)
      });
      return;
    }

    user.attempts[activeExamId].status = "cancelled";
    user.attempts[activeExamId].dateStr = new Date().toLocaleDateString("ru-RU");
    user.attempts[activeExamId].canRetake = false;
    user.state = null;
    user.temp = {};
    await saveUserData(env, userId, user);

    await tg(env, "sendMessage", {
      chat_id: chatId,
      text: "❌ Экзамен отменен. Попытка засчитана как использованная.",
      reply_markup: getStudentMainKb(userId, env, false)
    });
    return;
  }

  // --- 2. ПРОХОЖДЕНИЕ ЭКЗАМЕНА С НИЖНЕЙ КЛАВИАТУРЫ ---
  if (user.state === "EXAM_IN_PROGRESS") {
    const examId = user.temp.examId;
    const exam = db.exams[examId];
    const att = user.attempts?.[examId];

    if (!exam || !att || att.status !== "active") {
      user.state = null;
      await saveUserData(env, userId, user);
      await tg(env, "sendMessage", {
        chat_id: chatId,
        text: "⚠️ Активный экзамен не найден.",
        reply_markup: getStudentMainKb(userId, env, false)
      });
      return;
    }

    const total = exam.questions.length;
    let qIndex = Number.isInteger(user.temp.qIndex) ? user.temp.qIndex : 0;

    const choiceMatch = text.match(/^(?:✅\s*)?(?:Вариант\s+)?([АБВ])$/i);
    if (choiceMatch) {
      const choice = choiceMatch[1].toUpperCase();
      att.answers[qIndex] = choice;

      if (qIndex < total - 1) {
        qIndex += 1;
        user.temp.qIndex = qIndex;
      }
      await saveUserData(env, userId, user);
      await sendCurrentQuestion(chatId, exam, att, qIndex, env);
      return;
    }

    if (text === "◀️ Предыдущий вопрос") {
      qIndex = Math.max(0, qIndex - 1);
      user.temp.qIndex = qIndex;
      await saveUserData(env, userId, user);
      await sendCurrentQuestion(chatId, exam, att, qIndex, env);
      return;
    }

    if (text === "Следующий вопрос ▶️") {
      qIndex = Math.min(total - 1, qIndex + 1);
      user.temp.qIndex = qIndex;
      await saveUserData(env, userId, user);
      await sendCurrentQuestion(chatId, exam, att, qIndex, env);
      return;
    }

    if (text === "✅ Завершить экзамен") {
      if (Object.keys(att.answers).length < total) {
        const unansweredIdx = exam.questions.findIndex((_, i) => !att.answers[i]);
        user.temp.qIndex = unansweredIdx >= 0 ? unansweredIdx : qIndex;
        await saveUserData(env, userId, user);
        await tg(env, "sendMessage", {
          chat_id: chatId,
          text: `⚠️ Вы ответили не на все вопросы (${Object.keys(att.answers).length} из ${total}). Пожалуйста, ответьте на вопрос №${user.temp.qIndex + 1}:`
        });
        await sendCurrentQuestion(chatId, exam, att, user.temp.qIndex, env);
        return;
      }

      let correctCount = 0;
      exam.questions.forEach((q, i) => {
        if (att.answers[i] === q.correct) correctCount++;
      });
      const errorsCount = total - correctCount;
      const percent = (correctCount / total) * 100;

      let gradeDisplay = "Не сдано ❌";
      let gradeClean = "Не сдано";
      if (percent >= 85) {
        gradeDisplay = "Отлично 🌟";
        gradeClean = "Отлично";
      } else if (percent >= 70) {
        gradeDisplay = "Хорошо 👍";
        gradeClean = "Хорошо";
      } else if (percent >= exam.passPercent) {
        gradeDisplay = "Удовлетворительно ⭐️";
        gradeClean = "Удовлетворительно";
      }

      att.status = "completed";
      att.correctCount = correctCount;
      att.errorsCount = errorsCount;
      att.percent = percent;
      att.gradeClean = gradeClean;
      att.dateStr = new Date().toLocaleDateString("ru-RU");
      att.canRetake = false;

      let resText =
        `🎓 *ЭКЗАМЕН ЗАВЕРШЕН!*\n` +
        `📘 Предмет: *${exam.title}*\n` +
        `📅 Дата: ${att.dateStr}\n` +
        `📊 Результат: *${percent.toFixed(1)}%*\n\n` +
        `✅ Правильно: ${correctCount} из ${total}\n` +
        `❌ Ошибок: ${errorsCount}\n` +
        `🎯 Оценка: *${gradeDisplay}*\n\n`;

      if (percent >= exam.passPercent) {
        resText +=
          `🎉 *ПОЗДРАВЛЯЕМ!*\n` +
          `Вы успешно сдали экзамен!\n` +
          `📝 Пожалуйста, напишите в чат вашу **Фамилию и Имя** для сертификата:`;
        user.state = "WAIT_NAME";
        user.temp = { examId };
        await saveUserData(env, userId, user);
        await tg(env, "sendMessage", {
          chat_id: chatId,
          text: resText,
          reply_markup: { remove_keyboard: true },
          parse_mode: "Markdown"
        });
      } else {
        resText +=
          `К сожалению, вы не набрали проходной балл (${exam.passPercent}%).\n` +
          `Ваш Telegram ID для запроса пересдачи: \`${userId}\``;
        user.state = null;
        user.temp = {};
        await saveUserData(env, userId, user);
        await tg(env, "sendMessage", {
          chat_id: chatId,
          text: resText,
          reply_markup: getStudentMainKb(userId, env, false),
          parse_mode: "Markdown"
        });
      }
      return;
    }

    await tg(env, "sendMessage", {
      chat_id: chatId,
      text: "Пожалуйста, используйте кнопки внизу экрана для выбора ответа (`Вариант А`, `Вариант Б`, `Вариант В`).",
      reply_markup: getQuestionReplyKb(exam.questions, qIndex, att.answers),
      parse_mode: "Markdown"
    });
    return;
  }

  // --- 3. ВВОД ИМЕНИ ДЛЯ СЕРТИФИКАТА ---
  if (user.state === "WAIT_NAME" && text) {
    const examId = user.temp.examId;
    const exam = db.exams[examId];
    const att = user.attempts?.[examId];

    if (!exam || !att) {
      user.state = null;
      await saveUserData(env, userId, user);
      await tg(env, "sendMessage", {
        chat_id: chatId,
        text: "🏠 Главное меню:",
        reply_markup: getStudentMainKb(userId, env, false)
      });
      return;
    }

    att.fullName = text;
    user.state = null;
    user.temp = {};
    await saveUserData(env, userId, user);

    const mainKb = getStudentMainKb(userId, env, false);
    await tg(env, "sendMessage", {
      chat_id: chatId,
      text: "✅ *Имя сохранено!* Ваш сертификат генерируется...",
      reply_markup: mainKb,
      parse_mode: "Markdown"
    });

    const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 15);
    const txtBytes = generateTxtReport(exam.questions, att.answers);
    await sendDocument(
      env,
      chatId,
      txtBytes,
      `detailed_report_${userId}_${stamp}.txt`,
      "text/plain; charset=utf-8",
      "📄 Детальный разбор ваших ответов",
      mainKb
    );

    const pdfBytes = await generatePdfCertificate(env, exam, text, att.gradeClean, att.dateStr);
    await sendDocument(
      env,
      chatId,
      pdfBytes,
      `certificate_${userId}_${stamp}.pdf`,
      "application/pdf",
      "📜 Ваш сертификат готов!\nВы всегда сможете скачать его повторно по кнопке «📜 Мои экзамены и сертификаты» внизу экрана.",
      mainKb
    );
    return;
  }

  // --- 4. ОСНОВНЫЕ КНОПКИ И ДЕЙСТВИЯ УЧЕНИКА ---
  if (text === "📝 Сдать экзамен" || text === "/exam") {
    const activeExamId = findActiveAttemptExamId(user);
    if (activeExamId) {
      const ex = db.exams[activeExamId];
      const qIdx = user.temp?.qIndex || 0;
      await tg(env, "sendMessage", {
        chat_id: chatId,
        text: "⚠️ *У вас уже есть начатый экзамен!*",
        parse_mode: "Markdown"
      });
      if (ex) await sendCurrentQuestion(chatId, ex, user.attempts[activeExamId], qIdx, env);
      return;
    }

    user.state = "WAIT_EXAM_PASSWORD";
    await saveUserData(env, userId, user);
    await tg(env, "sendMessage", {
      chat_id: chatId,
      text: "🔑 Введите пароль к экзамену (или нажмите «◀️ Отмена» внизу экрана):",
      reply_markup: getCancelKb("◀️ Отмена")
    });
    return;
  }

  if (text === "📜 Мои экзамены и сертификаты" || text === "◀️ К списку моих экзаменов" || text === "/certificates" || text === "/my") {
    await sendStudentExamsList(chatId, userId, db, user, env);
    return;
  }

  // Выбор экзамена учеником по кнопке "📘 1. ..." (работает даже если state сбился)
  const studentExamMatch = text.match(/^📘\s*(\d+)\./);
  if (studentExamMatch) {
    const idx = parseInt(studentExamMatch[1], 10) - 1;
    const entries = getCompletedOrRetakeEntries(user);
    const examId = user.temp?.myExamList?.[idx] || entries[idx]?.[0];
    if (examId) {
      await sendStudentExamDetail(chatId, userId, examId, db, user, env);
      return;
    }
  }

  // Глобальная обработка кнопок карточки экзамена ученика (работает независимо от state)
  if (
    text === "📜 Получить сертификат повторно (PDF)" ||
    text === "📄 Скачать детальный разбор ответов (TXT)" ||
    text === "🔄 Пересдать этот экзамен сейчас" ||
    text === "🔄 Запросить возможность пересдачи"
  ) {
    const examId = resolveStudentTargetExamId(user);
    const ex = examId ? db.exams[examId] : null;
    const att = examId ? user.attempts?.[examId] : null;

    if (!ex || !att) {
      await sendStudentExamsList(chatId, userId, db, user, env);
      return;
    }

    if (text === "📜 Получить сертификат повторно (PDF)") {
      if (att.status !== "completed" || (att.percent || 0) < ex.passPercent) {
        await tg(env, "sendMessage", { chat_id: chatId, text: "⚠️ Сертификат по этому экзамену недоступен." });
        return;
      }
      if (!att.fullName) {
        user.state = "WAIT_NAME";
        user.temp = { examId };
        await saveUserData(env, userId, user);
        await tg(env, "sendMessage", {
          chat_id: chatId,
          text: "📝 Введите ваши Фамилию и Имя для генерации сертификата:",
          reply_markup: { remove_keyboard: true }
        });
        return;
      }

      await tg(env, "sendMessage", { chat_id: chatId, text: "⏳ Генерирую ваш сертификат..." });
      const pdfBytes = await generatePdfCertificate(env, ex, att.fullName, att.gradeClean, att.dateStr);
      const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 15);
      await sendDocument(
        env,
        chatId,
        pdfBytes,
        `certificate_${userId}_${stamp}.pdf`,
        "application/pdf",
        `📜 Дубликат сертификата по предмету «${ex.title}»\nДата сдачи: ${att.dateStr || "—"}\nОценка: ${att.gradeClean}`,
        getStudentExamDetailKb(ex, att)
      );
      return;
    }

    if (text === "📄 Скачать детальный разбор ответов (TXT)") {
      if (!att.answers || Object.keys(att.answers).length === 0) {
        await tg(env, "sendMessage", { chat_id: chatId, text: "⚠️ Разбор ответов не найден." });
        return;
      }
      const txtBytes = generateTxtReport(ex.questions, att.answers);
      await sendDocument(
        env,
        chatId,
        txtBytes,
        `report_${examId}.txt`,
        "text/plain; charset=utf-8",
        `📄 Разбор ответов («${ex.title}»)`,
        getStudentExamDetailKb(ex, att)
      );
      return;
    }

    if (text === "🔄 Пересдать этот экзамен сейчас") {
      if (!att.canRetake) {
        await tg(env, "sendMessage", {
          chat_id: chatId,
          text: "⚠️ Пересдача еще не открыта администратором.",
          reply_markup: getStudentExamDetailKb(ex, att)
        });
        return;
      }
      if (!ex.questions || ex.questions.length === 0) {
        await tg(env, "sendMessage", { chat_id: chatId, text: "⚠️ Вопросы для этого экзамена еще не добавлены." });
        return;
      }
      await startStudentExam(chatId, userId, examId, ex, user, env);
      return;
    }

    if (text === "🔄 Запросить возможность пересдачи") {
      await tg(env, "sendMessage", {
        chat_id: chatId,
        text: `🔄 *Запрос на пересдачу экзамена «${ex.title}»*\n\nПерешлите это сообщение преподавателю или администратору.\n👤 Ваш Telegram ID: \`${userId}\``,
        reply_markup: getStudentExamDetailKb(ex, att),
        parse_mode: "Markdown"
      });
      return;
    }
  }

  // Ввод пароля к экзамену учеником
  if (user.state === "WAIT_EXAM_PASSWORD" && text) {
    if (text === "◀️ Отмена") {
      user.state = null;
      await saveUserData(env, userId, user);
      await tg(env, "sendMessage", {
        chat_id: chatId,
        text: "🏠 Главное меню:",
        reply_markup: getStudentMainKb(userId, env, false)
      });
      return;
    }

    const inputPwd = text.trim().toLowerCase();
    let foundExamId = null;

    for (const [eId, ex] of Object.entries(db.exams)) {
      if (ex.password && ex.password.trim().toLowerCase() === inputPwd) {
        foundExamId = eId;
        break;
      }
    }

    if (!foundExamId) {
      await tg(env, "sendMessage", {
        chat_id: chatId,
        text: "❌ Неверный пароль! Проверьте правильность ввода и отправьте пароль еще раз (или нажмите «◀️ Отмена» внизу):",
        reply_markup: getCancelKb("◀️ Отмена")
      });
      return;
    }

    const exam = db.exams[foundExamId];
    if (!exam.questions || exam.questions.length === 0) {
      user.state = null;
      await saveUserData(env, userId, user);
      await tg(env, "sendMessage", {
        chat_id: chatId,
        text: "⚠️ Вопросы для этого экзамена еще не добавлены администратором.",
        reply_markup: getStudentMainKb(userId, env, false)
      });
      return;
    }

    const att = user.attempts?.[foundExamId];
    if (att && att.status !== "active" && !att.canRetake) {
      user.state = null;
      await saveUserData(env, userId, user);
      await tg(env, "sendMessage", {
        chat_id: chatId,
        text: `⚠️ Вы уже сдавали экзамен «*${exam.title}*»!\nОткройте раздел «📜 Мои экзамены и сертификаты» внизу экрана, чтобы посмотреть оценку, скачать сертификат или запросить пересдачу.`,
        reply_markup: getStudentMainKb(userId, env, false),
        parse_mode: "Markdown"
      });
      return;
    }

    await startStudentExam(chatId, userId, foundExamId, exam, user, env);
    return;
  }

  // ================= 5. НИЖНЕЕ МЕНЮ И ШАГИ АДМИНИСТРАТОРА =================
  if (!isAdmin(userId, env)) return;

  if (text === "📚 Список экзаменов" || text === "◀️ К списку экзаменов") {
    await sendAdminExamList(chatId, userId, db, user, env);
    return;
  }

  if (text === "➕ Создать экзамен") {
    user.state = "ADM_NEW_EXAM_TITLE";
    user.temp = {};
    await saveUserData(env, userId, user);
    await tg(env, "sendMessage", {
      chat_id: chatId,
      text: "Введите название нового экзамена (например: *Акыда — 1 семестр*):",
      reply_markup: getCancelKb("◀️ Отмена"),
      parse_mode: "Markdown"
    });
    return;
  }

  if (text === "🔤 Загрузить шрифт (.ttf)") {
    user.state = "ADM_UPLOAD_FONT";
    await saveUserData(env, userId, user);
    await tg(env, "sendMessage", {
      chat_id: chatId,
      text: "🔤 *Загрузка своего шрифта*\n\nОтправьте боту файл шрифта в формате `.ttf` или `.otf` (например, `TikTokSans-Regular.ttf`).\nБот сохранит его в память и автоматически включит для сертификатов!",
      reply_markup: getCancelKb("◀️ Отмена"),
      parse_mode: "Markdown"
    });
    return;
  }

  // Выбор экзамена из списка в админке ("🛠 1. ...")
  const adminExamMatch = text.match(/^🛠\s*(\d+)\./);
  if (adminExamMatch) {
    const idx = parseInt(adminExamMatch[1], 10) - 1;
    const exams = Object.values(db.exams);
    const examId = user.temp?.adminExamList?.[idx] || exams[idx]?.id;
    if (examId && db.exams[examId]) {
      await sendExamManage(chatId, userId, db, examId, user, env);
      return;
    }
  }

  // Кнопки управления конкретным экзаменом внизу экрана
  if (user.state === "ADM_EXAM_MANAGE" && text) {
    const examId = user.temp?.examId;
    const ex = db.exams[examId];
    if (!ex) {
      await sendAdminExamList(chatId, userId, db, user, env);
      return;
    }

    if (text === "➕ Добавить вопрос") {
      user.state = "ADM_Q_TEXT";
      user.temp = { examId };
      await saveUserData(env, userId, user);
      await tg(env, "sendMessage", {
        chat_id: chatId,
        text: "📝 Введите текст вопроса:",
        reply_markup: getCancelKb("◀️ Отмена")
      });
      return;
    }

    if (text === "🔑 Изменить пароль") {
      user.state = "ADM_EDIT_PWD";
      user.temp = { examId };
      await saveUserData(env, userId, user);
      await tg(env, "sendMessage", {
        chat_id: chatId,
        text: "🔑 Введите новый пароль для этого экзамена:",
        reply_markup: getCancelKb("◀️ Отмена")
      });
      return;
    }

    if (text === "🖼 Загрузить шаблон") {
      user.state = "ADM_UPLOAD_TPL";
      user.temp = { examId };
      await saveUserData(env, userId, user);
      await tg(env, "sendMessage", {
        chat_id: chatId,
        text: `🖼 *Загрузка шаблона сертификата («${ex.title}»)*\n\nОтправьте картинку (PNG или JPG):`,
        reply_markup: getCancelKb("◀️ Отмена"),
        parse_mode: "Markdown"
      });
      return;
    }

    if (text === "🎛 Пульт сертификата") {
      await sendCertJoystick(chatId, userId, db, examId, "name", user, env);
      return;
    }

    if (text === "🔄 Выдать пересдачу по ID") {
      user.state = "ADM_RESET_UID";
      user.temp = { examId };
      await saveUserData(env, userId, user);
      await tg(env, "sendMessage", {
        chat_id: chatId,
        text: `🔄 *Выдача пересдачи («${ex.title}»)*\n\nОтправьте Telegram ID ученика (только цифры):`,
        reply_markup: getCancelKb("◀️ Отмена"),
        parse_mode: "Markdown"
      });
      return;
    }

    if (text === "🎯 Изменить проходной %") {
      user.state = "ADM_EDIT_PASS";
      user.temp = { examId };
      await saveUserData(env, userId, user);
      await tg(env, "sendMessage", {
        chat_id: chatId,
        text: "🎯 Введите новый проходной процент (например: `60`):",
        reply_markup: getCancelKb("◀️ Отмена"),
        parse_mode: "Markdown"
      });
      return;
    }

    if (text === "🗑 Очистить вопросы") {
      ex.questions = [];
      await saveDB(env, db);
      await tg(env, "sendMessage", { chat_id: chatId, text: "🗑 Все вопросы экзамена удалены." });
      await sendExamManage(chatId, userId, db, examId, user, env);
      return;
    }

    if (text === "❌ Удалить экзамен") {
      delete db.exams[examId];
      await env.BOT_KV.delete(`TPL_${examId}`);
      await saveDB(env, db);
      await tg(env, "sendMessage", { chat_id: chatId, text: "❌ Экзамен удален." });
      await sendAdminExamList(chatId, userId, db, user, env);
      return;
    }
  }

  // Пульт настройки сертификата на нижней клавиатуре
  if (user.state === "ADM_JOYSTICK" && text) {
    const examId = user.temp?.examId;
    const ex = db.exams[examId];
    if (!ex) {
      await sendAdminExamList(chatId, userId, db, user, env);
      return;
    }

    if (text === "◀️ Назад к экзамену") {
      await sendExamManage(chatId, userId, db, examId, user, env);
      return;
    }

    const layout = ensureLayout(ex);
    let activeTarget = ["name", "grade", "date"].includes(user.temp?.joyTarget) ? user.temp.joyTarget : "name";

    if (text.includes("👤 Имя")) activeTarget = "name";
    else if (text.includes("⭐️ Оценка")) activeTarget = "grade";
    else if (text.includes("📅 Дата")) activeTarget = "date";

    const item = layout[activeTarget];

    if (text === "⬆️ Выше (+20)") item.y += 20;
    else if (text === "🔼 Выше (+5)") item.y += 5;
    else if (text === "🔽 Ниже (-5)") item.y = Math.max(0, item.y - 5);
    else if (text === "⬇️ Ниже (-20)") item.y = Math.max(0, item.y - 20);
    else if (text === "⬅️ Влево") item.dx -= 20;
    else if (text === "🎯 По центру") item.dx = 0;
    else if (text === "➡️ Вправо") item.dx += 20;
    else if (text === "➖ Шрифт мельче") item.size = Math.max(10, item.size - 2);
    else if (text === "➕ Шрифт крупнее") item.size += 2;
    else if (text.includes("🎨 Зеленый")) item.color = "green";
    else if (text.includes("🎨 Золотой")) item.color = "gold";
    else if (text.includes("🎨 Черный")) item.color = "black";
    else if (text.includes("🎨 Белый")) item.color = "white";
    else if (text.includes("🔤 Roboto")) layout.fontKey = "roboto";
    else if (text.includes("🔤 Montserrat")) layout.fontKey = "montserrat";
    else if (text.includes("🔤 Cormorant")) layout.fontKey = "cormorant";
    else if (text.includes("🔤 TikTok Sans")) layout.fontKey = "tiktoksans";
    else if (text.includes("🔤 Свой .ttf")) layout.fontKey = "custom";
    else if (text.startsWith("📝 Писать") && activeTarget === "grade") item.onlyWord = !item.onlyWord;
    else if ((text.startsWith("👁 Показать дату") || text.startsWith("🙈 Скрыть дату")) && activeTarget === "date") item.hide = !item.hide;

    await saveDB(env, db);

    if (text === "👁 Пробный PDF-сертификат") {
      const kb = getJoystickReplyKb(layout, activeTarget);
      await tg(env, "sendMessage", { chat_id: chatId, text: "⏳ Генерирую пробный сертификат...", reply_markup: kb });
      const pdfBytes = await generatePdfCertificate(env, ex, "Джавид Абу Сафия", "Отлично");
      await sendDocument(
        env,
        chatId,
        pdfBytes,
        `preview_${examId}_${Date.now()}.pdf`,
        "application/pdf",
        `👁 Пробный сертификат «${ex.title}»\nШрифт: ${FONTS[layout.fontKey]?.name || layout.fontKey}`,
        kb
      );
      return;
    }

    await sendCertJoystick(chatId, userId, db, examId, activeTarget, user, env);
    return;
  }

  // Обработка кнопки «◀️ Отмена» для всех пошаговых диалогов админа
  if (text === "◀️ Отмена") {
    const examId = user.temp?.examId;
    if (examId && db.exams[examId]) {
      await sendExamManage(chatId, userId, db, examId, user, env);
    } else {
      await sendAdminMain(chatId, userId, db, user, env);
    }
    return;
  }

  // Загрузка кастомного шрифта (.ttf / .otf)
  if (user.state === "ADM_UPLOAD_FONT" && msg.document) {
    const fileName = (msg.document.file_name || "").toLowerCase();
    if (!fileName.endsWith(".ttf") && !fileName.endsWith(".otf")) {
      await tg(env, "sendMessage", { chat_id: chatId, text: "⚠️ Отправьте файл шрифта с расширением `.ttf` или `.otf`." });
      return;
    }
    const fileInfo = await tg(env, "getFile", { file_id: msg.document.file_id });
    if (fileInfo.ok) {
      const fileRes = await fetch(`https://api.telegram.org/file/bot${env.BOT_TOKEN}/${fileInfo.result.file_path}`);
      const buf = await fileRes.arrayBuffer();
      await env.BOT_KV.put("CUSTOM_FONT", buf);

      for (const ex of Object.values(db.exams)) {
        ensureLayout(ex).fontKey = "custom";
      }
      await saveDB(env, db);

      await tg(env, "sendMessage", {
        chat_id: chatId,
        text: `✅ Шрифт *${msg.document.file_name}* успешно сохранен в память и включен для всех сертификатов!`,
        parse_mode: "Markdown"
      });
      await sendAdminMain(chatId, userId, db, user, env);
    }
    return;
  }

  if (user.state === "ADM_NEW_EXAM_TITLE" && text) {
    user.temp.title = text;
    user.state = "ADM_NEW_EXAM_PWD";
    await saveUserData(env, userId, user);
    await tg(env, "sendMessage", {
      chat_id: chatId,
      text: "🔑 Придумайте и отправьте **пароль** для входа на этот экзамен:",
      reply_markup: getCancelKb("◀️ Отмена"),
      parse_mode: "Markdown"
    });
    return;
  }

  if (user.state === "ADM_NEW_EXAM_PWD" && text) {
    user.temp.password = text.trim();
    user.state = "ADM_NEW_EXAM_PASS";
    await saveUserData(env, userId, user);
    await tg(env, "sendMessage", {
      chat_id: chatId,
      text: "🎯 Введите проходной процент для получения сертификата (например: `60`):",
      reply_markup: getCancelKb("◀️ Отмена"),
      parse_mode: "Markdown"
    });
    return;
  }

  if (user.state === "ADM_NEW_EXAM_PASS" && text) {
    const pass = parseFloat(text.replace(",", ".")) || 60;
    const examId = "ex_" + Date.now();
    db.exams[examId] = {
      id: examId,
      title: user.temp.title,
      password: user.temp.password,
      passPercent: pass,
      hasTemplate: false,
      layout: {
        fontKey: "tiktoksans",
        name:  { dx: 0, y: 480, size: 42, color: "green" },
        grade: { dx: 0, y: 340, size: 32, onlyWord: false, color: "dark" },
        date:  { dx: 0, y: 200, size: 22, hide: false, color: "gray" }
      },
      questions: []
    };
    await saveDB(env, db);
    await sendExamManage(chatId, userId, db, examId, user, env);
    return;
  }

  if (user.state === "ADM_EDIT_PWD" && text) {
    const examId = user.temp.examId;
    db.exams[examId].password = text.trim();
    await saveDB(env, db);
    await tg(env, "sendMessage", { chat_id: chatId, text: "✅ Пароль успешно обновлен!" });
    await sendExamManage(chatId, userId, db, examId, user, env);
    return;
  }

  if (user.state === "ADM_EDIT_PASS" && text) {
    const examId = user.temp.examId;
    db.exams[examId].passPercent = parseFloat(text.replace(",", ".")) || 60;
    await saveDB(env, db);
    await tg(env, "sendMessage", { chat_id: chatId, text: "✅ Проходной процент обновлен!" });
    await sendExamManage(chatId, userId, db, examId, user, env);
    return;
  }

  if (user.state === "ADM_UPLOAD_TPL" && (msg.photo || msg.document)) {
    const examId = user.temp.examId;
    const fileId = msg.photo ? msg.photo[msg.photo.length - 1].file_id : msg.document.file_id;
    const fileInfo = await tg(env, "getFile", { file_id: fileId });

    if (fileInfo.ok) {
      const fileRes = await fetch(`https://api.telegram.org/file/bot${env.BOT_TOKEN}/${fileInfo.result.file_path}`);
      const buf = await fileRes.arrayBuffer();
      const isPng = fileInfo.result.file_path.toLowerCase().endsWith(".png");

      await env.BOT_KV.put(`TPL_${examId}`, buf);
      db.exams[examId].hasTemplate = true;
      db.exams[examId].tplFormat = isPng ? "png" : "jpg";
      await saveDB(env, db);

      await tg(env, "sendMessage", { chat_id: chatId, text: "✅ Шаблон сертификата сохранен!" });
      await sendExamManage(chatId, userId, db, examId, user, env);
    }
    return;
  }

  if (user.state === "ADM_Q_TEXT" && text) {
    user.temp.qText = text;
    user.state = "ADM_Q_A";
    await saveUserData(env, userId, user);
    await tg(env, "sendMessage", {
      chat_id: chatId,
      text: "Введите вариант ответа *А*:",
      reply_markup: getCancelKb("◀️ Отмена"),
      parse_mode: "Markdown"
    });
    return;
  }

  if (user.state === "ADM_Q_A" && text) {
    user.temp.optA = text;
    user.state = "ADM_Q_B";
    await saveUserData(env, userId, user);
    await tg(env, "sendMessage", {
      chat_id: chatId,
      text: "Введите вариант ответа *Б*:",
      reply_markup: getCancelKb("◀️ Отмена"),
      parse_mode: "Markdown"
    });
    return;
  }

  if (user.state === "ADM_Q_B" && text) {
    user.temp.optB = text;
    user.state = "ADM_Q_C";
    await saveUserData(env, userId, user);
    await tg(env, "sendMessage", {
      chat_id: chatId,
      text: "Введите вариант ответа *В*:",
      reply_markup: getCancelKb("◀️ Отмена"),
      parse_mode: "Markdown"
    });
    return;
  }

  if (user.state === "ADM_Q_C" && text) {
    user.temp.optC = text;
    user.state = "ADM_Q_CORR";
    await saveUserData(env, userId, user);
    await tg(env, "sendMessage", {
      chat_id: chatId,
      text: "Выберите правильный вариант ответа на кнопках внизу экрана:",
      reply_markup: buildReplyKb([
        [{ text: "А" }, { text: "Б" }, { text: "В" }],
        [{ text: "◀️ Отмена" }]
      ])
    });
    return;
  }

  if (user.state === "ADM_Q_CORR" && ["А", "Б", "В"].includes(text.toUpperCase())) {
    const corr = text.toUpperCase();
    const examId = user.temp.examId;
    db.exams[examId].questions.push({
      text: user.temp.qText,
      options: { "А": user.temp.optA, "Б": user.temp.optB, "В": user.temp.optC },
      correct: corr
    });
    await saveDB(env, db);
    await tg(env, "sendMessage", { chat_id: chatId, text: "✅ Вопрос успешно добавлен!" });
    await sendExamManage(chatId, userId, db, examId, user, env);
    return;
  }

  // ВЫДАЧА ПЕРЕСДАЧИ ПО TELEGRAM ID
  if (user.state === "ADM_RESET_UID" && text) {
    const targetId = text.replace(/\D/g, "");
    const examId = user.temp.examId;
    const exam = db.exams[examId];

    if (!targetId) {
      await tg(env, "sendMessage", {
        chat_id: chatId,
        text: "⚠️ Отправьте только цифры (Telegram ID):",
        reply_markup: getCancelKb("◀️ Отмена")
      });
      return;
    }

    // Если админ выдает пересдачу самому себе (для теста), используем текущий объект user
    const isSelf = String(targetId) === String(userId);
    const targetUser = isSelf ? user : await getUserData(env, targetId);
    if (!targetUser.attempts) targetUser.attempts = {};

    // Если попытка была удалена ранее или еще не существовала — создаем запись
    if (!targetUser.attempts[examId]) {
      targetUser.attempts[examId] = {
        status: "cancelled",
        gradeClean: "Не сдано",
        percent: 0,
        correctCount: 0,
        errorsCount: 0,
        dateStr: new Date().toLocaleDateString("ru-RU"),
        answers: {}
      };
    }

    targetUser.attempts[examId].canRetake = true;
    if (targetUser.attempts[examId].status === "active") {
      targetUser.attempts[examId].status = "cancelled";
    }

    if (!isSelf) {
      targetUser.state = "MY_EXAM_DETAIL";
      targetUser.temp = { ...targetUser.temp, viewExamId: examId };
      await saveUserData(env, targetId, targetUser);

      // Отправляем ученику сообщение И СРАЗУ прикрепляем нижнюю клавиатуру с кнопкой пересдачи
      await tg(env, "sendMessage", {
        chat_id: targetId,
        text:
          `🎉 Администратор открыл вам возможность пересдачи экзамена «*${exam.title}*»!\n\n` +
          `Нажмите кнопку *«🔄 Пересдать этот экзамен сейчас»* внизу экрана, чтобы начать:`,
        reply_markup: getStudentExamDetailKb(exam, targetUser.attempts[examId]),
        parse_mode: "Markdown"
      });
    } else {
      await saveUserData(env, userId, user);
    }

    await tg(env, "sendMessage", {
      chat_id: chatId,
      text: `✅ Пользователю \`${targetId}\` открыта пересдача по экзамену «*${exam.title}*»!`,
      parse_mode: "Markdown"
    });
    await sendExamManage(chatId, userId, db, examId, user, env);
    return;
  }
}

// ================= ГЕНЕРАЦИЯ ОТЧЕТА И СЕРТИФИКАТА =================
function generateTxtReport(questions, answers) {
  const lines = ["ДЕТАЛЬНЫЙ РАЗБОР ВАШИХ ОТВЕТОВ", "========================================", ""];
  questions.forEach((q, i) => {
    const uAns = answers[i] || "Нет ответа";
    const cAns = q.correct;
    const isOk = uAns === cAns ? "✅ ВЕРНО" : "❌ ОШИБКА";
    lines.push(`Вопрос ${i + 1}: ${q.text}`);
    lines.push(`Ваш ответ: ${uAns}) ${q.options[uAns] || "—"} (${isOk})`);
    if (uAns !== cAns) {
      lines.push(`Правильный ответ: ${cAns}) ${q.options[cAns]}`);
    }
    lines.push("----------------------------------------");
  });
  return new TextEncoder().encode(lines.join("\n"));
}

async function loadFontBytes(env, fontKey) {
  if (fontKey === "custom") {
    const customBuf = await env.BOT_KV.get("CUSTOM_FONT", "arrayBuffer");
    if (customBuf) return customBuf;
  }

  const fontConf = FONTS[fontKey] || FONTS.roboto;
  if (fontConf.url) {
    try {
      const res = await fetch(fontConf.url);
      if (res.ok) return await res.arrayBuffer();
    } catch {}
  }

  if (fontKey === "tiktoksans") {
    const customBuf = await env.BOT_KV.get("CUSTOM_FONT", "arrayBuffer");
    if (customBuf) return customBuf;
    const fallbackReg = await fetch(FONTS.roboto_reg.url);
    return await fallbackReg.arrayBuffer();
  }

  const fallback = await fetch(FONTS.roboto.url);
  return await fallback.arrayBuffer();
}

async function generatePdfCertificate(env, exam, fullName, gradeClean, customDateStr = null) {
  const pdfDoc = await PDFDocument.create();
  pdfDoc.registerFontkit(fontkit);

  const layout = ensureLayout(exam);
  let customFont;
  try {
    const fontBytes = await loadFontBytes(env, layout.fontKey);
    customFont = await pdfDoc.embedFont(fontBytes);
  } catch {
    const fallbackBytes = await (await fetch(FONTS.roboto.url)).arrayBuffer();
    customFont = await pdfDoc.embedFont(fallbackBytes);
  }

  let width = 1200;
  let height = 850;
  let bgImage = null;

  if (exam.hasTemplate) {
    const tplBytes = await env.BOT_KV.get(`TPL_${exam.id}`, "arrayBuffer");
    if (tplBytes) {
      bgImage = exam.tplFormat === "png"
        ? await pdfDoc.embedPng(tplBytes)
        : await pdfDoc.embedJpg(tplBytes);
      width = bgImage.width;
      height = bgImage.height;
    }
  }

  const page = pdfDoc.addPage([width, height]);

  if (bgImage) {
    page.drawImage(bgImage, { x: 0, y: 0, width, height });
  } else {
    page.drawRectangle({ x: 30, y: 30, width: width - 60, height: height - 60, borderColor: rgb(0.7, 0.58, 0.3), borderWidth: 5 });
    const title = "СЕРТИФИКАТ";
    const tWidth = customFont.widthOfTextAtSize(title, 54);
    page.drawText(title, { x: (width - tWidth) / 2, y: height - 200, size: 54, font: customFont, color: rgb(0.15, 0.15, 0.15) });
  }

  // 1. Имя ученика
  const nCfg = layout.name;
  const nameWidth = customFont.widthOfTextAtSize(fullName, nCfg.size);
  page.drawText(fullName, {
    x: (width - nameWidth) / 2 + (nCfg.dx || 0),
    y: nCfg.y,
    size: nCfg.size,
    font: customFont,
    color: parseColor(nCfg.color)
  });

  // 2. Оценка
  const gCfg = layout.grade;
  const gradeText = gCfg.onlyWord ? gradeClean : `Оценка: ${gradeClean}`;
  const gradeWidth = customFont.widthOfTextAtSize(gradeText, gCfg.size);
  page.drawText(gradeText, {
    x: (width - gradeWidth) / 2 + (gCfg.dx || 0),
    y: gCfg.y,
    size: gCfg.size,
    font: customFont,
    color: parseColor(gCfg.color)
  });

  // 3. Дата
  const dCfg = layout.date;
  if (!dCfg.hide) {
    const dateStr = customDateStr || new Date().toLocaleDateString("ru-RU");
    const dateWidth = customFont.widthOfTextAtSize(dateStr, dCfg.size);
    page.drawText(dateStr, {
      x: (width - dateWidth) / 2 + (dCfg.dx || 0),
      y: dCfg.y,
      size: dCfg.size,
      font: customFont,
      color: parseColor(dCfg.color)
    });
  }

  return await pdfDoc.save();
}
