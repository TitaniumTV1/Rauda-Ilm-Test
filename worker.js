import { PDFDocument, rgb } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";

// Ссылки на шрифты (включая TikTok Sans Regular)
const FONTS = {
  roboto: { 
    name: "Roboto (Строгий)", 
    url: "https://cdn.jsdelivr.net/gh/googlefonts/roboto@main/src/hinted/Roboto-Bold.ttf" 
  },
  montserrat: { 
    name: "Montserrat (Современный)", 
    url: "https://cdn.jsdelivr.net/gh/JulietaUla/Montserrat/fonts/ttf/Montserrat-Bold.ttf" 
  },
  cormorant: { 
    name: "Cormorant (Классический)", 
    url: "https://cdn.jsdelivr.net/gh/skedify/cormorant/ttf/CormorantGaramond-Bold.ttf" 
  },
  tiktoksans: { 
    name: "TikTok Sans Regular", 
    url: "https://cdn.jsdelivr.net/gh/tiktok/TikTokSans@main/fonts/ttf/TikTokSans-Regular.ttf" 
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

async function sendDocument(env, chatId, bytes, filename, mimeType, caption) {
  const formData = new FormData();
  formData.append("chat_id", String(chatId));
  formData.append("caption", caption);
  formData.append("document", new Blob([bytes], { type: mimeType }), filename);

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
  if (!exam.layout.fontKey) exam.layout.fontKey = "roboto";
  if (!exam.layout.name.color) exam.layout.name.color = "green";
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

// ================= МАРШРУТИЗАТОР =================
async function handleUpdate(update, env) {
  if (update.message) {
    await handleMessage(update.message, env);
  } else if (update.callback_query) {
    await handleCallback(update.callback_query, env);
  }
}

function formatQuestionText(questions, index, answers) {
  const q = questions[index];
  let text = `📝 Вопрос ${index + 1}/${questions.length}\n\n${q.text}\n\nВарианты ответов:\n`;
  text += `А) ${q.options["А"]}\n\nБ) ${q.options["Б"]}\n\nВ) ${q.options["В"]}\n\n`;
  const ans = answers[index];
  if (ans) {
    text += `✅ *Ваш ответ: ${ans}) ${q.options[ans]}*`;
  }
  return text;
}

function getQuestionKb(questions, index, answers) {
  const total = questions.length;
  const rows = [];

  rows.push(["А", "Б", "В"].map(k => ({
    text: `${answers[index] === k ? "✅ " : ""}${k}`,
    callback_data: `ans:${index}:${k}`
  })));

  const nav = [];
  if (index > 0) nav.push({ text: "◀️ Назад", callback_data: `nav:${index - 1}` });
  if (index < total - 1) nav.push({ text: "Вперед ▶️", callback_data: `nav:${index + 1}` });
  if (nav.length > 0) rows.push(nav);

  if (Object.keys(answers).length === total || index === total - 1) {
    rows.push([{ text: "✅ Завершить экзамен", callback_data: "finish_exam" }]);
  }

  return { inline_keyboard: rows };
}

async function handleMessage(msg, env) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const text = (msg.text || "").trim();

  const db = await getDB(env);
  const user = await getUserData(env, userId);

  if (text === "/admin" && isAdmin(userId, env)) {
    user.state = null;
    user.temp = {};
    await saveUserData(env, userId, user);
    await sendAdminMain(chatId, db, env);
    return;
  }

  if (text === "/cancel") {
    const activeExamId = findActiveAttemptExamId(user);
    if (!activeExamId) {
      if (user.state === "WAIT_EXAM_PASSWORD") {
        user.state = null;
        await saveUserData(env, userId, user);
      }
      await tg(env, "sendMessage", { chat_id: chatId, text: "У вас нет активного экзамена." });
      return;
    }

    user.attempts[activeExamId].status = "cancelled";
    user.state = null;
    user.temp = {};
    await saveUserData(env, userId, user);

    await tg(env, "sendMessage", {
      chat_id: chatId,
      text: "❌ Экзамен отменен. Попытка засчитана как использованная."
    });
    return;
  }

  if (text === "/start") {
    const activeExamId = findActiveAttemptExamId(user);
    if (activeExamId) {
      await tg(env, "sendMessage", {
        chat_id: chatId,
        text: "⚠️ *У вас уже есть начатый экзамен!*\n\nПродолжайте прохождение или используйте /cancel для отмены.",
        parse_mode: "Markdown"
      });
      return;
    }

    const completedCount = Object.values(user.attempts || {}).filter(a => a.status === "completed").length;
    if (completedCount === 0) {
      await tg(env, "sendMessage", {
        chat_id: chatId,
        text: "У вас пока нет завершенных попыток.\n\nНачните экзамен: /exam"
      });
    } else {
      await tg(env, "sendMessage", {
        chat_id: chatId,
        text: `Добро пожаловать!\nДля начала нового экзамена нажмите: /exam\n\nВаш Telegram ID: \`${userId}\``,
        parse_mode: "Markdown"
      });
    }
    return;
  }

  if (text === "/exam") {
    const activeExamId = findActiveAttemptExamId(user);
    if (activeExamId) {
      await tg(env, "sendMessage", {
        chat_id: chatId,
        text: "⚠️ *У вас уже есть начатый экзамен!*\n\nПродолжайте прохождение или используйте /cancel для отмены.",
        parse_mode: "Markdown"
      });
      return;
    }

    user.state = "WAIT_EXAM_PASSWORD";
    await saveUserData(env, userId, user);
    await tg(env, "sendMessage", {
      chat_id: chatId,
      text: "🔑 Пожалуйста, введите пароль к экзамену:"
    });
    return;
  }

  if (user.state === "WAIT_EXAM_PASSWORD" && text) {
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
        text: "❌ Неверный пароль! Проверьте правильность ввода и отправьте пароль еще раз:"
      });
      return;
    }

    const exam = db.exams[foundExamId];
    if (!exam.questions || exam.questions.length === 0) {
      user.state = null;
      await saveUserData(env, userId, user);
      await tg(env, "sendMessage", {
        chat_id: chatId,
        text: "⚠️ Вопросы для этого экзамена еще не добавлены администратором."
      });
      return;
    }

    const att = user.attempts[foundExamId];
    if (att && att.status !== "active") {
      user.state = null;
      await saveUserData(env, userId, user);
      await tg(env, "sendMessage", {
        chat_id: chatId,
        text: `⚠️ Вы уже использовали свою единственную попытку в экзамене «*${exam.title}*»!\nПересдача возможна только через администратора (ваш ID: \`${userId}\`).`,
        parse_mode: "Markdown"
      });
      return;
    }

    user.attempts[foundExamId] = { status: "active", answers: {} };
    user.state = "EXAM_IN_PROGRESS";
    user.temp = { examId: foundExamId };
    await saveUserData(env, userId, user);

    await tg(env, "sendMessage", {
      chat_id: chatId,
      text: `🎓 *Экзамен начался!*\n📚 *${exam.title}*\n\nВам предстоит ответить на ${exam.questions.length} вопросов.`,
      parse_mode: "Markdown"
    });

    await tg(env, "sendMessage", {
      chat_id: chatId,
      text: formatQuestionText(exam.questions, 0, {}),
      reply_markup: getQuestionKb(exam.questions, 0, {}),
      parse_mode: "Markdown"
    });
    return;
  }

  if (user.state === "WAIT_NAME" && text) {
    const examId = user.temp.examId;
    const exam = db.exams[examId];
    const att = user.attempts[examId];
    att.fullName = text;
    user.state = null;
    await saveUserData(env, userId, user);

    await tg(env, "sendMessage", {
      chat_id: chatId,
      text: "✅ *Результаты сохранены!*\n\n📜 Ваш сертификат генерируется...",
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
      "📄 Детальный разбор ваших ответов"
    );

    const pdfBytes = await generatePdfCertificate(env, exam, text, att.gradeClean);
    await sendDocument(
      env,
      chatId,
      pdfBytes,
      `certificate_${userId}_${stamp}.pdf`,
      "application/pdf",
      "📜 Ваш сертификат готов!\n\n⚠️ ВАЖНО: Пожалуйста, скачайте и надежно сохраните этот сертификат."
    );
    return;
  }

  if (!isAdmin(userId, env)) return;

  if (user.state === "ADM_NEW_EXAM_TITLE" && text) {
    user.temp.title = text;
    user.state = "ADM_NEW_EXAM_PWD";
    await saveUserData(env, userId, user);
    await tg(env, "sendMessage", {
      chat_id: chatId,
      text: "🔑 Придумайте и отправьте **пароль** для входа на этот экзамен:",
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
        fontKey: "roboto",
        name:  { dx: 0, y: 480, size: 42, color: "green" },
        grade: { dx: 0, y: 340, size: 32, onlyWord: false, color: "dark" },
        date:  { dx: 0, y: 200, size: 22, hide: false, color: "gray" }
      },
      questions: []
    };
    await saveDB(env, db);

    user.state = null;
    await saveUserData(env, userId, user);
    await sendExamManage(chatId, db, examId, env);
    return;
  }

  if (user.state === "ADM_EDIT_PWD" && text) {
    const examId = user.temp.examId;
    db.exams[examId].password = text.trim();
    await saveDB(env, db);
    user.state = null;
    await saveUserData(env, userId, user);
    await sendExamManage(chatId, db, examId, env);
    return;
  }

  if (user.state === "ADM_EDIT_PASS" && text) {
    const examId = user.temp.examId;
    db.exams[examId].passPercent = parseFloat(text.replace(",", ".")) || 60;
    await saveDB(env, db);
    user.state = null;
    await saveUserData(env, userId, user);
    await sendExamManage(chatId, db, examId, env);
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

      user.state = null;
      await saveUserData(env, userId, user);
      await tg(env, "sendMessage", {
        chat_id: chatId,
        text: `✅ Шаблон сертификата сохранен!`
      });
      await sendExamManage(chatId, db, examId, env);
    }
    return;
  }

  if (user.state === "ADM_Q_TEXT" && text) {
    user.temp.qText = text;
    user.state = "ADM_Q_A";
    await saveUserData(env, userId, user);
    await tg(env, "sendMessage", { chat_id: chatId, text: "Введите вариант ответа *А*:", parse_mode: "Markdown" });
    return;
  }
  if (user.state === "ADM_Q_A" && text) {
    user.temp.optA = text;
    user.state = "ADM_Q_B";
    await saveUserData(env, userId, user);
    await tg(env, "sendMessage", { chat_id: chatId, text: "Введите вариант ответа *Б*:", parse_mode: "Markdown" });
    return;
  }
  if (user.state === "ADM_Q_B" && text) {
    user.temp.optB = text;
    user.state = "ADM_Q_C";
    await saveUserData(env, userId, user);
    await tg(env, "sendMessage", { chat_id: chatId, text: "Введите вариант ответа *В*:", parse_mode: "Markdown" });
    return;
  }
  if (user.state === "ADM_Q_C" && text) {
    user.temp.optC = text;
    user.state = "ADM_Q_CORR";
    await saveUserData(env, userId, user);
    await tg(env, "sendMessage", {
      chat_id: chatId,
      text: "Выберите правильный вариант ответа:",
      reply_markup: {
        inline_keyboard: [[
          { text: "А", callback_data: "adm_corr:А" },
          { text: "Б", callback_data: "adm_corr:Б" },
          { text: "В", callback_data: "adm_corr:В" }
        ]]
      }
    });
    return;
  }

  if (user.state === "ADM_RESET_UID" && text) {
    const targetId = text.replace(/\D/g, "");
    const examId = user.temp.examId;
    const exam = db.exams[examId];

    if (!targetId) {
      await tg(env, "sendMessage", { chat_id: chatId, text: "⚠️ Отправьте только цифры (Telegram ID):" });
      return;
    }

    const targetUser = await getUserData(env, targetId);
    if (targetUser.attempts && targetUser.attempts[examId]) {
      delete targetUser.attempts[examId];
      targetUser.state = null;
      await saveUserData(env, targetId, targetUser);
    }

    user.state = null;
    await saveUserData(env, userId, user);

    await tg(env, "sendMessage", {
      chat_id: targetId,
      text: `🎉 Администратор выдал вам новую попытку для сдачи экзамена «${exam.title}»!`
    });
    await tg(env, "sendMessage", {
      chat_id: chatId,
      text: `✅ Попытка пользователя \`${targetId}\` успешно сброшена!`,
      parse_mode: "Markdown"
    });
    await sendExamManage(chatId, db, examId, env);
    return;
  }
}

async function handleCallback(call, env) {
  const chatId = call.message.chat.id;
  const msgId = call.message.message_id;
  const userId = call.from.id;
  const data = call.data;

  const db = await getDB(env);
  const user = await getUserData(env, userId);

  if (data.startsWith("ans:") && user.state === "EXAM_IN_PROGRESS") {
    const [, idxStr, choice] = data.split(":");
    const idx = parseInt(idxStr, 10);
    const examId = user.temp.examId;
    const exam = db.exams[examId];
    const att = user.attempts[examId];

    att.answers[idx] = choice;
    await saveUserData(env, userId, user);

    const nextIdx = idx < exam.questions.length - 1 ? idx + 1 : idx;
    await tg(env, "editMessageText", {
      chat_id: chatId,
      message_id: msgId,
      text: formatQuestionText(exam.questions, nextIdx, att.answers),
      reply_markup: getQuestionKb(exam.questions, nextIdx, att.answers),
      parse_mode: "Markdown"
    });
    await tg(env, "answerCallbackQuery", { callback_query_id: call.id });
    return;
  }

  if (data.startsWith("nav:") && user.state === "EXAM_IN_PROGRESS") {
    const idx = parseInt(data.split(":")[1], 10);
    const examId = user.temp.examId;
    const exam = db.exams[examId];
    const att = user.attempts[examId];

    await tg(env, "editMessageText", {
      chat_id: chatId,
      message_id: msgId,
      text: formatQuestionText(exam.questions, idx, att.answers),
      reply_markup: getQuestionKb(exam.questions, idx, att.answers),
      parse_mode: "Markdown"
    });
    await tg(env, "answerCallbackQuery", { callback_query_id: call.id });
    return;
  }

  if (data === "finish_exam" && user.state === "EXAM_IN_PROGRESS") {
    const examId = user.temp.examId;
    const exam = db.exams[examId];
    const att = user.attempts[examId];
    const total = exam.questions.length;

    if (Object.keys(att.answers).length < total) {
      await tg(env, "answerCallbackQuery", {
        callback_query_id: call.id,
        text: "⚠️ Ответьте на все вопросы перед завершением!",
        show_alert: true
      });
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

    let resText =
      `🎓 *ЭКЗАМЕН ЗАВЕРШЕН!*\n` +
      `📊 Вы прошли экзамен на ${percent.toFixed(1)}%\n\n` +
      `📈 *РЕЗУЛЬТАТЫ:*\n` +
      `✅ Правильно: ${correctCount}\n` +
      `❌ Ошибок: ${errorsCount}\n` +
      `📝 Всего: ${total}\n\n` +
      `🎯 *ОЦЕНКА:*\n${gradeDisplay}\n\n`;

    if (percent >= exam.passPercent) {
      resText +=
        `🎉 *ПОЗДРАВЛЯЕМ!*\n` +
        `Вы успешно сдали экзамен!\n` +
        `📝 Пожалуйста, введите вашу Фамилию и Имя для сертификата:`;
      user.state = "WAIT_NAME";
    } else {
      resText +=
        `К сожалению, вы не набрали проходной балл (${exam.passPercent}%).\n` +
        `Ваш Telegram ID: \`${userId}\``;
      user.state = null;
    }

    await saveUserData(env, userId, user);
    await tg(env, "editMessageReplyMarkup", { chat_id: chatId, message_id: msgId, reply_markup: { inline_keyboard: [] } });
    await tg(env, "sendMessage", { chat_id: chatId, text: resText, parse_mode: "Markdown" });
    await tg(env, "answerCallbackQuery", { callback_query_id: call.id });
    return;
  }

  if (!isAdmin(userId, env)) return;

  if (data.startsWith("adm:joy:")) {
    const [, , examId, target, action] = data.split(":");
    const ex = db.exams[examId];
    if (!ex) return;
    const layout = ensureLayout(ex);

    if (target === "font") {
      layout.fontKey = action;
    } else {
      const item = layout[target];
      if (action === "up20") item.y += 20;
      else if (action === "up5") item.y += 5;
      else if (action === "down20") item.y = Math.max(0, item.y - 20);
      else if (action === "down5") item.y = Math.max(0, item.y - 5);
      else if (action === "left20") item.dx -= 20;
      else if (action === "right20") item.dx += 20;
      else if (action === "center") item.dx = 0;
      else if (action === "plus") item.size += 2;
      else if (action === "minus") item.size = Math.max(10, item.size - 2);
      else if (action === "color_green") item.color = "green";
      else if (action === "color_black") item.color = "black";
      else if (action === "color_gold") item.color = "gold";
      else if (action === "color_white") item.color = "white";
      else if (action === "toggle_word" && target === "grade") item.onlyWord = !item.onlyWord;
      else if (action === "toggle_hide" && target === "date") item.hide = !item.hide;
    }

    if (action !== "open" && action !== "preview") {
      await saveDB(env, db);
    }

    if (action === "preview") {
      await tg(env, "answerCallbackQuery", { callback_query_id: call.id, text: "⏳ Генерирую пробный сертификат..." });
      const pdfBytes = await generatePdfCertificate(env, ex, "Джавид Абу Сафия", "Отлично");
      await sendDocument(
        env,
        chatId,
        pdfBytes,
        `preview_${examId}.pdf`,
        "application/pdf",
        `👁 Пробный сертификат «${ex.title}»`
      );
      return;
    }

    await sendCertJoystick(chatId, db, examId, target, env, msgId);
    await tg(env, "answerCallbackQuery", { callback_query_id: call.id });
    return;
  }

  if (data === "adm:main") {
    user.state = null;
    await saveUserData(env, userId, user);
    await sendAdminMain(chatId, db, env, msgId);
  } else if (data === "adm:new_exam") {
    user.state = "ADM_NEW_EXAM_TITLE";
    await saveUserData(env, userId, user);
    await tg(env, "editMessageText", {
      chat_id: chatId,
      message_id: msgId,
      text: "Введите название нового экзамена:",
      parse_mode: "Markdown"
    });
  } else if (data === "adm:list") {
    const exams = Object.values(db.exams);
    if (exams.length === 0) {
      await tg(env, "answerCallbackQuery", { callback_query_id: call.id, text: "Список пуст. Создайте экзамен!", show_alert: true });
      return;
    }
    const btns = exams.map(ex => [{
      text: `📘 ${ex.title} | 🔑 ${ex.password || "—"} (${ex.questions.length} вопр.)`,
      callback_data: `adm:open:${ex.id}`
    }]);
    btns.push([{ text: "◀️ Назад", callback_data: "adm:main" }]);
    await tg(env, "editMessageText", {
      chat_id: chatId,
      message_id: msgId,
      text: "📚 *Выберите экзамен для настройки:*",
      reply_markup: { inline_keyboard: btns },
      parse_mode: "Markdown"
    });
  } else if (data.startsWith("adm:open:")) {
    const examId = data.split(":")[2];
    await sendExamManage(chatId, db, examId, env, msgId);
  } else if (data.startsWith("adm:pwd:")) {
    const examId = data.split(":")[2];
    user.state = "ADM_EDIT_PWD";
    user.temp = { examId };
    await saveUserData(env, userId, user);
    await tg(env, "editMessageText", { chat_id: chatId, message_id: msgId, text: "🔑 Введите новый пароль:" });
  } else if (data.startsWith("adm:add_q:")) {
    const examId = data.split(":")[2];
    user.state = "ADM_Q_TEXT";
    user.temp = { examId };
    await saveUserData(env, userId, user);
    await tg(env, "editMessageText", { chat_id: chatId, message_id: msgId, text: "📝 Введите текст вопроса:" });
  } else if (data.startsWith("adm_corr:") && user.state === "ADM_Q_CORR") {
    const corr = data.split(":")[1];
    const examId = user.temp.examId;
    db.exams[examId].questions.push({
      text: user.temp.qText,
      options: { "А": user.temp.optA, "Б": user.temp.optB, "В": user.temp.optC },
      correct: corr
    });
    await saveDB(env, db);
    user.state = null;
    await saveUserData(env, userId, user);
    await tg(env, "answerCallbackQuery", { callback_query_id: call.id, text: "✅ Вопрос добавлен!" });
    await sendExamManage(chatId, db, examId, env, msgId);
  } else if (data.startsWith("adm:tpl:")) {
    const examId = data.split(":")[2];
    const ex = db.exams[examId];
    user.state = "ADM_UPLOAD_TPL";
    user.temp = { examId };
    await saveUserData(env, userId, user);
    await tg(env, "editMessageText", {
      chat_id: chatId,
      message_id: msgId,
      text: `🖼 *Загрузка сертификата для «${ex.title}»*\n\nОтправьте картинку (PNG или JPG).`,
      parse_mode: "Markdown"
    });
  } else if (data.startsWith("adm:pass:")) {
    const examId = data.split(":")[2];
    user.state = "ADM_EDIT_PASS";
    user.temp = { examId };
    await saveUserData(env, userId, user);
    await tg(env, "editMessageText", { chat_id: chatId, message_id: msgId, text: "Введите проходной процент:" });
  } else if (data.startsWith("adm:reset_uid:")) {
    const examId = data.split(":")[2];
    const ex = db.exams[examId];
    user.state = "ADM_RESET_UID";
    user.temp = { examId };
    await saveUserData(env, userId, user);
    await tg(env, "editMessageText", {
      chat_id: chatId,
      message_id: msgId,
      text: `🔄 Отправьте Telegram ID ученика:`,
      parse_mode: "Markdown"
    });
  } else if (data.startsWith("adm:clear_q:")) {
    const examId = data.split(":")[2];
    db.exams[examId].questions = [];
    await saveDB(env, db);
    await tg(env, "answerCallbackQuery", { callback_query_id: call.id, text: "🗑 Все вопросы удалены", show_alert: true });
    await sendExamManage(chatId, db, examId, env, msgId);
  } else if (data.startsWith("adm:del:")) {
    const examId = data.split(":")[2];
    delete db.exams[examId];
    await env.BOT_KV.delete(`TPL_${examId}`);
    await saveDB(env, db);
    await sendAdminMain(chatId, db, env, msgId);
  }

  await tg(env, "answerCallbackQuery", { callback_query_id: call.id });
}

async function sendAdminMain(chatId, db, env, editMsgId = null) {
  const totalExams = Object.keys(db.exams).length;
  const text = `⚙️ *Панель администратора*\n\nВсего создано экзаменов: *${totalExams}*`;
  const kb = {
    inline_keyboard: [
      [{ text: "➕ Создать новый экзамен", callback_data: "adm:new_exam" }],
      [{ text: "📚 Список экзаменов", callback_data: "adm:list" }]
    ]
  };
  if (editMsgId) {
    await tg(env, "editMessageText", { chat_id: chatId, message_id: editMsgId, text, reply_markup: kb, parse_mode: "Markdown" });
  } else {
    await tg(env, "sendMessage", { chat_id: chatId, text, reply_markup: kb, parse_mode: "Markdown" });
  }
}

async function sendExamManage(chatId, db, examId, env, editMsgId = null) {
  const ex = db.exams[examId];
  ensureLayout(ex);
  const text =
    `📋 *Экзамен:* ${ex.title}\n` +
    `🔑 *Пароль:* \`${ex.password || "не задан"}\`\n` +
    `🔢 *Вопросов:* ${ex.questions.length}\n` +
    `🎯 *Проходной балл:* ${ex.passPercent}%\n` +
    `🖼 *Шаблон:* ${ex.hasTemplate ? "✅ Загружен" : "❌ Стандартный"}\n` +
    `🔤 *Шрифт:* ${FONTS[ex.layout.fontKey]?.name || "Roboto"}`;

  const kb = {
    inline_keyboard: [
      [{ text: `🔑 Изменить пароль`, callback_data: `adm:pwd:${examId}` }],
      [{ text: "➕ Добавить вопрос", callback_data: `adm:add_q:${examId}` }],
      [{ text: "🖼 Загрузить шаблон", callback_data: `adm:tpl:${examId}` }],
      [{ text: "🎛 Настроить текст, шрифты и цвета (Пульт)", callback_data: `adm:joy:${examId}:name:open` }],
      [{ text: "🔄 Выдать попытку ученику", callback_data: `adm:reset_uid:${examId}` }],
      [{ text: "🎯 Изменить проходной %", callback_data: `adm:pass:${examId}` }],
      [{ text: "🗑 Очистить вопросы", callback_data: `adm:clear_q:${examId}` }],
      [{ text: "❌ Удалить экзамен", callback_data: `adm:del:${examId}` }],
      [{ text: "◀️ К списку", callback_data: "adm:list" }]
    ]
  };

  if (editMsgId) {
    await tg(env, "editMessageText", { chat_id: chatId, message_id: editMsgId, text, reply_markup: kb, parse_mode: "Markdown" });
  } else {
    await tg(env, "sendMessage", { chat_id: chatId, text, reply_markup: kb, parse_mode: "Markdown" });
  }
}

async function sendCertJoystick(chatId, db, examId, target, env, editMsgId) {
  const ex = db.exams[examId];
  const layout = ensureLayout(ex);
  const cur = layout[target];

  const titles = {
    name: "👤 Имя и Фамилия",
    grade: "⭐️ Оценка",
    date: "📅 Дата выдачи"
  };

  const text =
    `🎛 *Пульт настройки сертификата «${ex.title}»*\n\n` +
    `Двигаем: *${titles[target] || "🔤 Настройки"}*\n` +
    `• Шрифт: *${FONTS[layout.fontKey]?.name || "Roboto"}*\n` +
    (target !== "font" ? `• Высота: \`${cur.y}\` | Сдвиг: \`${cur.dx}\` | Размер: \`${cur.size}\` | Цвет: *${cur.color}*` : "") +
    `\n\n_Используйте кнопки управления ниже:_`;

  const rows = [
    [
      { text: `${target === "name" ? "🟢 " : ""}👤 Имя`, callback_data: `adm:joy:${examId}:name:open` },
      { text: `${target === "grade" ? "🟢 " : ""}⭐️ Оценка`, callback_data: `adm:joy:${examId}:grade:open` },
      { text: `${target === "date" ? "🟢 " : ""}📅 Дата`, callback_data: `adm:joy:${examId}:date:open` }
    ],
    // Кнопки выбора шрифта (включая TikTok Sans)
    [
      { text: `${layout.fontKey === "roboto" ? "✅ " : ""}Roboto`, callback_data: `adm:joy:${examId}:font:roboto` },
      { text: `${layout.fontKey === "montserrat" ? "✅ " : ""}Montserrat`, callback_data: `adm:joy:${examId}:font:montserrat` },
      { text: `${layout.fontKey === "cormorant" ? "✅ " : ""}Cormorant`, callback_data: `adm:joy:${examId}:font:cormorant` },
      { text: `${layout.fontKey === "tiktoksans" ? "✅ " : ""}TikTok Sans`, callback_data: `adm:joy:${examId}:font:tiktoksans` }
    ]
  ];

  if (target !== "font") {
    rows.push(
      [
        { text: "⬆️ Выше (+20)", callback_data: `adm:joy:${examId}:${target}:up20` },
        { text: "🔼 (+5)", callback_data: `adm:joy:${examId}:${target}:up5` }
      ],
      [
        { text: "⬅️ Влево", callback_data: `adm:joy:${examId}:${target}:left20` },
        { text: "🎯 Центр", callback_data: `adm:joy:${examId}:${target}:center` },
        { text: "➡️ Вправо", callback_data: `adm:joy:${examId}:${target}:right20` }
      ],
      [
        { text: "⬇️ Ниже (-20)", callback_data: `adm:joy:${examId}:${target}:down20` },
        { text: "🔽 (-5)", callback_data: `adm:joy:${examId}:${target}:down5` }
      ],
      [
        { text: "➖ Мельче", callback_data: `adm:joy:${examId}:${target}:minus` },
        { text: "➕ Крупнее", callback_data: `adm:joy:${examId}:${target}:plus` }
      ],
      [
        { text: `${cur.color === "green" ? "✅ " : ""}Зеленый`, callback_data: `adm:joy:${examId}:${target}:color_green` },
        { text: `${cur.color === "gold" ? "✅ " : ""}Золотой`, callback_data: `adm:joy:${examId}:${target}:color_gold` },
        { text: `${cur.color === "black" ? "✅ " : ""}Черный`, callback_data: `adm:joy:${examId}:${target}:color_black` },
        { text: `${cur.color === "white" ? "✅ " : ""}Белый`, callback_data: `adm:joy:${examId}:${target}:color_white` }
      ]
    );
  }

  if (target === "grade") {
    rows.push([{
      text: cur.onlyWord ? "📝 Писать «Отлично»" : "📝 Писать «Оценка: Отлично»",
      callback_data: `adm:joy:${examId}:grade:toggle_word`
    }]);
  }
  if (target === "date") {
    rows.push([{
      text: cur.hide ? "👁 Показать дату" : "🙈 Скрыть дату",
      callback_data: `adm:joy:${examId}:date:toggle_hide`
    }]);
  }

  rows.push([{ text: "👁 Прислать пробный PDF-сертификат", callback_data: `adm:joy:${examId}:${target}:preview` }]);
  rows.push([{ text: "◀️ Назад к экзамену", callback_data: `adm:open:${examId}` }]);

  await tg(env, "editMessageText", {
    chat_id: chatId,
    message_id: editMsgId,
    text,
    reply_markup: { inline_keyboard: rows },
    parse_mode: "Markdown"
  });
}

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

async function generatePdfCertificate(env, exam, fullName, gradeClean) {
  const pdfDoc = await PDFDocument.create();
  pdfDoc.registerFontkit(fontkit);

  const layout = ensureLayout(exam);
  const fontConf = FONTS[layout.fontKey] || FONTS.roboto;

  // Добавляем случайный параметр, чтобы Cloudflare и KV не кэшировали старый шрифт
  const freshUrl = `${fontConf.url}?v=${Date.now()}`;

  const fontRes = await fetch(freshUrl);
  const fontBytes = await fontRes.arrayBuffer();
  const customFont = await pdfDoc.embedFont(fontBytes);

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
    const dateStr = new Date().toLocaleDateString("ru-RU");
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
