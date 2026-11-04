import { randomUUID } from "node:crypto";
import { Bot, InlineKeyboard, type Context } from "grammy";
import type { AppDatabase, CallbackPayload } from "../db/database.js";
import type { Capability, Device, JsonObject } from "../domain/models.js";
import { AccessDeniedError, AccessService } from "../core/access.service.js";
import { ActionService } from "../core/action.service.js";
import { CatalogService } from "../core/catalog.service.js";
import { MusicService } from "../core/music.service.js";
import { canUseBotCallback } from "../core/music-access-policy.js";
import { maxVolumeForRole, validateVolumeForRole } from "../core/volume-policy.js";

type BotDependencies = {
  token: string;
  callbackTtlSeconds: number;
  database: AppDatabase;
  access: AccessService;
  catalog: CatalogService;
  actions: ActionService;
  music: MusicService;
};

type BotRuntimeDependencies = BotDependencies & {
  awaitingTrack: Set<string>;
  awaitingSpeech: Set<string>;
  awaitingAlarmTime: Set<string>;
  alarmDrafts: Map<string, string>;
  awaitingAlarmMusic: Set<string>;
  awaitingGrant: Set<string>;
};

type View = [text: string, options: { reply_markup: InlineKeyboard }];

export function createTelegramBot(deps: BotDependencies): Bot {
  const bot = new Bot(deps.token);
  const awaitingTrack = new Set<string>();
  const awaitingSpeech = new Set<string>();
  const awaitingAlarmTime = new Set<string>();
  const alarmDrafts = new Map<string, string>();
  const awaitingAlarmMusic = new Set<string>();
  const awaitingGrant = new Set<string>();
  const runtimeDeps: BotRuntimeDependencies = {
    ...deps,
    awaitingTrack,
    awaitingSpeech,
    awaitingAlarmTime,
    alarmDrafts,
    awaitingAlarmMusic,
    awaitingGrant,
  };

  bot.use(async (ctx, next) => {
    const actorId = ctx.from?.id ? String(ctx.from.id) : undefined;
    if (ctx.chat?.type !== "private" || !actorId || !ctx.from) {
      if (ctx.callbackQuery) await ctx.answerCallbackQuery({ text: "Доступ запрещён", show_alert: true });
      else await ctx.reply("Доступ запрещён.");
      return;
    }
    const displayName = [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(" ");
    deps.database.registerBotUser(actorId, ctx.from.username, displayName);
    if (!deps.access.canExecute(actorId)) {
      if (ctx.callbackQuery) await ctx.answerCallbackQuery({ text: "Доступ запрещён", show_alert: true });
      else if (ctx.message?.text?.startsWith("/start")) {
        const result = deps.database.createAccessRequest(actorId);
        await ctx.reply(result.created
          ? "Заявка на доступ отправлена владельцу бота. После одобрения нажмите /start ещё раз."
          : "Ваша заявка уже ожидает решения владельца бота.");
      } else await ctx.reply("Доступ запрещён.");
      return;
    }
    await next();
  });

  bot.command("start", async (ctx) => {
    await ensureCatalog(deps.catalog);
    await ctx.reply(...homeView(String(ctx.from!.id), deps));
  });

  bot.command("sync", async (ctx) => {
    try {
      requireOwner(String(ctx.from!.id), deps);
      const catalog = await deps.catalog.syncCatalog();
      await ctx.reply(`Каталог обновлён: ${catalog.devices.length} устройств, ${catalog.scenarios.length} сценариев.`);
    } catch (error) {
      await ctx.reply(userError(error));
    }
  });

  bot.command("volume", async (ctx) => {
    try {
      const raw = ctx.match.trim();
      const level = Number(raw);
      const actorId = String(ctx.from!.id);
      validateVolumeForRole(level, deps.access.isOwner(actorId));
      await deps.music.setVolume(level);
      await ctx.reply(`Громкость колонки установлена на ${level} из 10.`);
    } catch (error) {
      await ctx.reply(userError(error));
    }
  });

  bot.command("play", async (ctx) => {
    try {
      const query = ctx.match.trim();
      const actorId = String(ctx.from!.id);
      const result = await deps.music.enqueue(query, actorId);
      await ctx.reply(queueResultText(result.item.query, result.position, result.started), {
        reply_markup: musicKeyboard(actorId, deps),
      });
    } catch (error) {
      await ctx.reply(userError(error));
    }
  });

  bot.command("say", async (ctx) => {
    try {
      const phrase = ctx.match.trim();
      await deps.music.speak(phrase);
      await ctx.reply(`Фраза отправлена на колонку: ${phrase}`, {
        reply_markup: musicKeyboard(String(ctx.from!.id), deps),
      });
    } catch (error) {
      await ctx.reply(userError(error));
    }
  });

  bot.command("pause", async (ctx) => {
    try {
      requireOwner(String(ctx.from!.id), deps);
      await deps.music.pause();
      await ctx.reply("Музыка поставлена на паузу.");
    } catch (error) {
      await ctx.reply(userError(error));
    }
  });

  bot.command("resume", async (ctx) => {
    try {
      requireOwner(String(ctx.from!.id), deps);
      await deps.music.resume();
      await ctx.reply("Воспроизведение продолжено.");
    } catch (error) {
      await ctx.reply(userError(error));
    }
  });

  bot.on("message:text", async (ctx) => {
    const actorId = String(ctx.from.id);
    if (ctx.message.text.startsWith("/")) return;
    if (awaitingGrant.has(actorId)) {
      if (!deps.access.isOwner(actorId)) throw new AccessDeniedError();
      const user = deps.database.findBotUserByUsername(ctx.message.text);
      if (!user) {
        await ctx.reply("Пользователь не найден. Он должен сначала написать этому боту /start, а затем нужно ввести его @username.");
        return;
      }
      deps.database.setBotUserAuthorized(user.telegramId, true);
      deps.database.approvePendingAccessRequestsForUser(user.telegramId, actorId);
      awaitingGrant.delete(actorId);
      await ctx.reply(`Доступ выдан: ${formatUser(user)}.`, {
        reply_markup: adminKeyboard(actorId, deps),
      });
      return;
    }
    if (awaitingSpeech.has(actorId)) {
      const phrase = ctx.message.text.trim();
      if (!phrase) return;
      try {
        await deps.music.speak(phrase);
        awaitingSpeech.delete(actorId);
        await ctx.reply(`Фраза отправлена на колонку: ${phrase}`, {
          reply_markup: musicKeyboard(actorId, deps),
        });
      } catch (error) {
        await ctx.reply(`${userError(error)}\n\nВведите другую фразу или вернитесь в меню.`, {
          reply_markup: musicKeyboard(actorId, deps),
        });
      }
      return;
    }
    if (awaitingAlarmTime.has(actorId)) {
      const time = ctx.message.text.trim();
      if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)) {
        await ctx.reply("Введите время в формате ЧЧ:ММ, например 07:30.");
        return;
      }
      awaitingAlarmTime.delete(actorId);
      alarmDrafts.set(actorId, time);
      await ctx.reply(`Время: ${time}. Как часто повторять?`, {
        reply_markup: alarmFrequencyKeyboard(actorId, deps),
      });
      return;
    }
    if (awaitingAlarmMusic.has(actorId)) {
      const music = ctx.message.text.trim();
      if (!music) return;
      try {
        await deps.music.command(`Поставь ${music} на будильник`);
        awaitingAlarmMusic.delete(actorId);
        await ctx.reply(`Команда смены мелодии отправлена: ${music}`, {
          reply_markup: alarmsKeyboard(actorId, deps),
        });
      } catch (error) {
        await ctx.reply(`${userError(error)}\n\nПопробуйте отправить название ещё раз.`, {
          reply_markup: alarmsKeyboard(actorId, deps),
        });
      }
      return;
    }
    if (!awaitingTrack.has(actorId)) return;
    const query = ctx.message.text.trim();
    if (!query) return;
    try {
      const result = await deps.music.enqueue(query, actorId);
      awaitingTrack.delete(actorId);
      await ctx.reply(queueResultText(result.item.query, result.position, result.started), {
        reply_markup: musicKeyboard(actorId, deps),
      });
    } catch (error) {
      await ctx.reply(`${userError(error)}\n\nМожно попробовать другое название или вернуться в меню.`, {
        reply_markup: musicKeyboard(actorId, deps),
      });
    }
  });

  bot.callbackQuery(/^cb:([a-f0-9]{24})$/, async (ctx) => {
    const actorId = String(ctx.from.id);
    const id = ctx.match[1];
    if (!id) return;
    const payload = deps.database.consumeCallback(id, actorId);
    if (!payload) {
      await ctx.answerCallbackQuery({ text: "Кнопка устарела. Откройте меню заново.", show_alert: true });
      return;
    }
    await ctx.answerCallbackQuery();
    try {
      await handleCallback(ctx, actorId, payload, runtimeDeps);
    } catch (error) {
      await ctx.editMessageText(`Ошибка: ${userError(error)}`, {
        reply_markup: new InlineKeyboard().text("В главное меню", callback(actorId, { kind: "home" }, deps)),
      });
    }
  });

  bot.catch(({ error }) => {
    console.error("Telegram bot error", error);
  });
  return bot;
}

async function handleCallback(
  ctx: Context,
  actorId: string,
  payload: CallbackPayload,
  deps: BotRuntimeDependencies,
): Promise<void> {
  if (!canUseBotCallback(payload.kind, deps.access.isOwner(actorId))) {
    throw new AccessDeniedError();
  }
  if (payload.kind === "home") {
    await ctx.editMessageText(...homeView(actorId, deps));
    return;
  }
  if (payload.kind === "devices") {
    await ctx.editMessageText(...await devicesView(actorId, deps));
    return;
  }
  if (payload.kind === "device_status") {
    await ctx.editMessageText(...deviceStatusView(actorId, deps));
    return;
  }
  if (payload.kind === "scenarios") {
    await ctx.editMessageText(...scenariosView(actorId, deps));
    return;
  }
  if (payload.kind === "custom_scenarios") {
    await ctx.editMessageText(...customScenariosView(actorId, deps));
    return;
  }
  if (payload.kind === "basic_scenarios") {
    await ctx.editMessageText(...basicScenariosView(actorId, deps));
    return;
  }
  if (payload.kind === "basic_action") {
    const commands = {
      weather: "Расскажи прогноз погоды",
      news: "Включи последние новости РБК",
      my_wave: "Включи Мою волну",
      favorites: "Включи мою любимую музыку",
      morning_show: "Включи утреннее шоу",
    } as const;
    await deps.music.command(commands[payload.action]);
    await ctx.editMessageText(...basicScenariosView(actorId, deps, "Команда отправлена Алисе."));
    return;
  }
  if (payload.kind === "alarms") {
    await ctx.editMessageText(...alarmsView(actorId, deps));
    return;
  }
  if (payload.kind === "alarm_new") {
    deps.awaitingAlarmMusic.delete(actorId);
    deps.awaitingAlarmTime.add(actorId);
    await ctx.reply("Введите время будильника в формате ЧЧ:ММ, например 07:30.", {
      reply_markup: { force_reply: true, input_field_placeholder: "07:30" },
    });
    return;
  }
  if (payload.kind === "alarm_frequency") {
    const time = deps.alarmDrafts.get(actorId);
    if (!time) throw new Error("Черновик будильника устарел. Начните создание заново.");
    const suffix = {
      once: "",
      daily: " каждый день",
      weekdays: " по будням",
      weekends: " по выходным",
    }[payload.frequency];
    try {
      await deps.music.command(`Поставь будильник на ${time}${suffix}`);
    } catch (error) {
      await ctx.editMessageText(`${userError(error)}\n\nВремя ${time} сохранено. Повторите выбор частоты:`, {
        reply_markup: alarmFrequencyKeyboard(actorId, deps),
      });
      return;
    }
    deps.alarmDrafts.delete(actorId);
    await ctx.editMessageText(...alarmsView(actorId, deps, `Будильник на ${time} отправлен Алисе.`));
    return;
  }
  if (payload.kind === "alarm_status") {
    await deps.music.command("Какие будильники установлены?");
    await ctx.editMessageText(...alarmsView(actorId, deps, "Алиса озвучит установленные будильники."));
    return;
  }
  if (payload.kind === "alarm_disable_all") {
    await deps.music.command("Выключи все будильники");
    await ctx.editMessageText(...alarmsView(actorId, deps, "Команда отключения отправлена Алисе."));
    return;
  }
  if (payload.kind === "alarm_enable_all") {
    await deps.music.command("Включи все будильники");
    await ctx.editMessageText(...alarmsView(actorId, deps, "Команда включения отправлена Алисе."));
    return;
  }
  if (payload.kind === "alarm_music") {
    deps.awaitingAlarmTime.delete(actorId);
    deps.awaitingAlarmMusic.add(actorId);
    await ctx.reply("Введите песню, исполнителя, плейлист, жанр или радиостанцию для всех будильников этой колонки.", {
      reply_markup: { force_reply: true, input_field_placeholder: "Например: рок" },
    });
    return;
  }
  if (payload.kind === "alarm_standard_sound") {
    await deps.music.command("Поставь стандартную мелодию на будильник");
    await ctx.editMessageText(...alarmsView(actorId, deps, "Команда возврата стандартной мелодии отправлена."));
    return;
  }
  if (payload.kind === "stations") {
    await ctx.editMessageText(...await stationsView(actorId, deps));
    return;
  }
  if (payload.kind === "station_select") {
    const player = await deps.music.selectPlayer(payload.entityId);
    const [text, options] = await musicView(actorId, deps);
    await ctx.editMessageText(`Выбрана колонка: ${player.name}.\n\n${text}`, options);
    return;
  }
  if (payload.kind === "music") {
    await ctx.editMessageText(...await musicView(actorId, deps));
    return;
  }
  if (payload.kind === "music_prompt") {
    deps.awaitingSpeech.delete(actorId);
    deps.awaitingTrack.add(actorId);
    await ctx.reply("Напишите название песни и исполнителя одним сообщением.", {
      reply_markup: {
        force_reply: true,
        input_field_placeholder: "Например: Twisted Sister — We're Not Gonna Take It",
      },
    });
    return;
  }
  if (payload.kind === "music_speak") {
    deps.awaitingTrack.delete(actorId);
    deps.awaitingSpeech.add(actorId);
    await ctx.reply("Введите фразу, которую должна произнести Алиса. Максимум 100 символов.", {
      reply_markup: {
        force_reply: true,
        input_field_placeholder: "Текст для озвучивания",
      },
    });
    return;
  }
  if (payload.kind === "music_queue") {
    await ctx.editMessageText(...await musicQueueView(actorId, deps));
    return;
  }
  if (payload.kind === "music_next") {
    requireOwner(actorId, deps);
    const next = await deps.music.nextQueueTrack();
    const message = next
      ? `Переключено. Сейчас по очереди бота: ${next.query}.`
      : "Команда «Следующий» отправлена. Очередь бота закончилась.";
    const [text, options] = await musicView(actorId, deps);
    await ctx.editMessageText(`${message}\n\n${text}`, options);
    return;
  }
  if (payload.kind === "music_clear_queue") {
    requireOwner(actorId, deps);
    const cleared = await deps.music.clearQueue();
    const [text, options] = await musicQueueView(actorId, deps);
    await ctx.editMessageText(`Очередь очищена. Удалено записей: ${cleared}.\n\n${text}`, options);
    return;
  }
  if (payload.kind === "music_volume") {
    validateVolumeForRole(payload.level, deps.access.isOwner(actorId));
    await deps.music.setVolume(payload.level);
    const [text, options] = await musicView(actorId, deps);
    await ctx.editMessageText(`Громкость установлена на ${payload.level} из 10.\n\n${text}`, options);
    return;
  }
  if (payload.kind === "music_transport") {
    requireOwner(actorId, deps);
    if (payload.action === "play") await deps.music.resume();
    else await deps.music.pause();
    const labels = { play: "Воспроизведение продолжено.", pause: "Пауза." };
    const [text, options] = await musicView(actorId, deps);
    await ctx.editMessageText(`${labels[payload.action]}\n\n${text}`, options);
    return;
  }
  if (payload.kind === "admin") {
    requireOwner(actorId, deps);
    await ctx.editMessageText(...adminView(actorId, deps));
    return;
  }
  if (payload.kind === "admin_prompt") {
    requireOwner(actorId, deps);
    deps.awaitingGrant.add(actorId);
    await ctx.reply("Введите Telegram username пользователя, например @username. Пользователь должен предварительно написать боту /start.", {
      reply_markup: { force_reply: true, input_field_placeholder: "@username" },
    });
    return;
  }
  if (payload.kind === "admin_requests") {
    requireOwner(actorId, deps);
    await ctx.editMessageText(...adminRequestsView(actorId, deps));
    return;
  }
  if (payload.kind === "admin_approve_request" || payload.kind === "admin_reject_request") {
    requireOwner(actorId, deps);
    const approved = payload.kind === "admin_approve_request";
    const request = deps.database.resolveAccessRequest(
      payload.requestId,
      approved ? "APPROVED" : "REJECTED",
      actorId,
    );
    if (request) {
      await ctx.api.sendMessage(
        request.user.telegramId,
        approved
          ? "Ваша заявка одобрена. Нажмите /start, чтобы открыть меню."
          : "Ваша заявка на доступ отклонена.",
      ).catch(() => undefined);
    }
    const notice = request
      ? `${approved ? "Доступ выдан" : "Заявка отклонена"}: ${formatUser(request.user)}.`
      : "Заявка уже была обработана.";
    const [text, options] = adminRequestsView(actorId, deps);
    await ctx.editMessageText(`${notice}\n\n${text}`, options);
    return;
  }
  if (payload.kind === "admin_revoke") {
    requireOwner(actorId, deps);
    deps.database.setBotUserAuthorized(payload.telegramId, false);
    await ctx.editMessageText(...adminView(actorId, deps));
    return;
  }
  if (payload.kind === "category") {
    const devices = deps.catalog.listDevices(payload.category);
    const keyboard = new InlineKeyboard();
    for (const device of devices) {
      keyboard.text(device.name, callback(actorId, { kind: "device", deviceId: device.id }, deps)).row();
    }
    keyboard.text("В главное меню", callback(actorId, { kind: "home" }, deps));
    await ctx.editMessageText(`${payload.category}\n\nВыберите устройство:`, { reply_markup: keyboard });
    return;
  }
  if (payload.kind === "device") {
    const device = await deps.catalog.refreshDevice(payload.deviceId).catch(() => deps.catalog.getDevice(payload.deviceId));
    if (!device) throw new Error("Устройство не найдено");
    await ctx.editMessageText(...deviceView(actorId, device, deps));
    return;
  }
  if (payload.kind === "action") {
    const result = await deps.actions.executeAction({
      ...payload.command,
      actorId,
      requestId: randomUUID(),
    });
    const device = await deps.catalog
      .refreshDevice(payload.command.targetId)
      .catch(() => deps.catalog.getDevice(payload.command.targetId));
    const suffix = result.status === "DONE" ? "Команда выполнена." : `Ошибка: ${result.errorCode ?? "неизвестная"}`;
    if (!device) {
      await ctx.editMessageText(suffix, {
        reply_markup: new InlineKeyboard().text("В главное меню", callback(actorId, { kind: "home" }, deps)),
      });
      return;
    }
    const [text, options] = deviceView(actorId, device, deps);
    await ctx.editMessageText(`${suffix}\n\n${text}`, options);
    return;
  }
  if (payload.kind === "scenario") {
    const result = await deps.actions.executeScenario(actorId, payload.scenarioId, randomUUID());
    const prefix = result.status === "DONE" ? "Сценарий запущен." : "Не удалось запустить сценарий.";
    const [text, options] = homeView(actorId, deps);
    await ctx.editMessageText(`${prefix}\n\n${text}`, options);
  }
}

function homeView(actorId: string, deps: BotDependencies): View {
  const catalog = deps.catalog.getCatalog();
  const isOwner = deps.access.isOwner(actorId);
  const keyboard = new InlineKeyboard();
  if (isOwner) {
    keyboard
      .text("Устройства", callback(actorId, { kind: "devices" }, deps)).row()
      .text("Сценарии", callback(actorId, { kind: "scenarios" }, deps)).row();
  }
  keyboard.text("Музыка и громкость", callback(actorId, { kind: "music" }, deps)).row();
  if (isOwner) {
    const pending = deps.database.countPendingAccessRequests();
    const label = pending ? `Управление пользователями (${pending})` : "Управление пользователями";
    keyboard.text(label, callback(actorId, { kind: "admin" }, deps)).row();
  }
  const text = isOwner
    ? `Умный дом\n\n${catalog.devices.length} устройств. Каталог: ${new Date(catalog.syncedAt).toLocaleString("ru-RU")}.`
    : "Привет! Здесь можно добавлять песни в общую очередь, устанавливать громкость от 1 до 6 и отправлять текст для произнесения на колонке.\n\nОткройте «Музыка и громкость», чтобы начать.";
  return [text, { reply_markup: keyboard }];
}

async function devicesView(actorId: string, deps: BotDependencies): Promise<View> {
  const players = await deps.music.listPlayers().catch(() => []);
  const keyboard = new InlineKeyboard()
    .text(`Колонки (${players.length})`, callback(actorId, { kind: "stations" }, deps)).row()
    .text("Состояние устройств", callback(actorId, { kind: "device_status" }, deps)).row();
  keyboard.text("В главное меню", callback(actorId, { kind: "home" }, deps));
  return ["Устройства\n\nВыберите раздел:", { reply_markup: keyboard }];
}

function deviceStatusView(actorId: string, deps: BotDependencies): View {
  const devices = deps.catalog.getCatalog().devices;
  const keyboard = new InlineKeyboard();
  for (const device of devices) {
    keyboard.text(
      `${device.name} — ${device.status ?? "нет данных"}`,
      callback(actorId, { kind: "device", deviceId: device.id }, deps),
    ).row();
  }
  keyboard.text("К устройствам", callback(actorId, { kind: "devices" }, deps));
  return [devices.length ? "Состояние устройств\n\nВыберите устройство:" : "Устройства не найдены.", { reply_markup: keyboard }];
}

function scenariosView(actorId: string, deps: BotDependencies): View {
  const keyboard = new InlineKeyboard()
    .text("Авторские", callback(actorId, { kind: "custom_scenarios" }, deps)).row()
    .text("Базовые", callback(actorId, { kind: "basic_scenarios" }, deps)).row()
    .text("В главное меню", callback(actorId, { kind: "home" }, deps));
  return ["Сценарии\n\nВыберите раздел:", { reply_markup: keyboard }];
}

function customScenariosView(actorId: string, deps: BotDependencies): View {
  const keyboard = new InlineKeyboard();
  for (const scenario of deps.catalog.getCatalog().scenarios) {
    keyboard.text(scenario.name, callback(actorId, { kind: "scenario", scenarioId: scenario.id }, deps)).row();
  }
  keyboard.text("К сценариям", callback(actorId, { kind: "scenarios" }, deps));
  return ["Авторские сценарии\n\nВыберите сценарий:", { reply_markup: keyboard }];
}

function basicScenariosView(actorId: string, deps: BotDependencies, notice?: string): View {
  const keyboard = new InlineKeyboard()
    .text("Рассказать погоду", callback(actorId, { kind: "basic_action", action: "weather" }, deps)).row()
    .text("Рассказать новости", callback(actorId, { kind: "basic_action", action: "news" }, deps)).row()
    .text("Включить Мою волну", callback(actorId, { kind: "basic_action", action: "my_wave" }, deps)).row()
    .text("Включить любимую музыку", callback(actorId, { kind: "basic_action", action: "favorites" }, deps)).row()
    .text("Утреннее шоу", callback(actorId, { kind: "basic_action", action: "morning_show" }, deps)).row()
    .text("Будильники", callback(actorId, { kind: "alarms" }, deps)).row()
    .text("К сценариям", callback(actorId, { kind: "scenarios" }, deps));
  const text = `${notice ? `${notice}\n\n` : ""}Базовые сценарии\n\nВыберите действие:`;
  return [text, { reply_markup: keyboard }];
}

function alarmsView(actorId: string, deps: BotDependencies, notice?: string): View {
  const text = `${notice ? `${notice}\n\n` : ""}Будильники\n\nУправление относится к выбранной колонке. Ответы о текущих будильниках Алиса произносит голосом.`;
  return [text, { reply_markup: alarmsKeyboard(actorId, deps) }];
}

function alarmsKeyboard(actorId: string, deps: BotDependencies): InlineKeyboard {
  return new InlineKeyboard()
    .text("Поставить новый", callback(actorId, { kind: "alarm_new" }, deps)).row()
    .text("Какие установлены?", callback(actorId, { kind: "alarm_status" }, deps)).row()
    .text("Выключить все", callback(actorId, { kind: "alarm_disable_all" }, deps))
    .text("Включить все", callback(actorId, { kind: "alarm_enable_all" }, deps)).row()
    .text("Изменить мелодию", callback(actorId, { kind: "alarm_music" }, deps)).row()
    .text("Стандартная мелодия", callback(actorId, { kind: "alarm_standard_sound" }, deps)).row()
    .text("К базовым сценариям", callback(actorId, { kind: "basic_scenarios" }, deps));
}

function alarmFrequencyKeyboard(actorId: string, deps: BotDependencies): InlineKeyboard {
  return new InlineKeyboard()
    .text("Один раз", callback(actorId, { kind: "alarm_frequency", frequency: "once" }, deps)).row()
    .text("Каждый день", callback(actorId, { kind: "alarm_frequency", frequency: "daily" }, deps)).row()
    .text("По будням", callback(actorId, { kind: "alarm_frequency", frequency: "weekdays" }, deps))
    .text("По выходным", callback(actorId, { kind: "alarm_frequency", frequency: "weekends" }, deps)).row()
    .text("К будильникам", callback(actorId, { kind: "alarms" }, deps));
}

async function stationsView(actorId: string, deps: BotDependencies): Promise<View> {
  const players = await deps.music.listPlayers();
  const selected = deps.music.getSelectedEntityId();
  const keyboard = new InlineKeyboard();
  for (const player of players) {
    const prefix = player.entityId === selected ? "✓ " : "";
    keyboard.text(`${prefix}${player.name}`, callback(actorId, { kind: "station_select", entityId: player.entityId }, deps)).row();
  }
  keyboard.text("К устройствам", callback(actorId, { kind: "devices" }, deps));
  return [players.length ? "Колонки\n\nВыберите колонку для музыки:" : "Колонки не найдены.", { reply_markup: keyboard }];
}

async function musicView(actorId: string, deps: BotDependencies): Promise<View> {
  const status = deps.music.getStatus();
  const selectedId = deps.music.getSelectedEntityId();
  const selected = status.configured
    ? (await deps.music.listPlayers().catch(() => [])).find((player) => player.entityId === selectedId)
    : undefined;
  const queue = await deps.music.getQueue().catch((): { current?: { query: string }; pending: Array<{ query: string }> } => ({ pending: [] }));
  const volume = selected?.volumeLevel === undefined ? "нет данных" : `${Math.round(selected.volumeLevel * 10)} из 10`;
  const current = queue.current?.query ?? "нет данных от колонки";
  const instructions = deps.access.isOwner(actorId)
    ? ""
    : "Как добавить музыку:\n1. Нажмите «Добавить песню».\n2. Напишите название и исполнителя.\n3. Песня попадёт в очередь и запустится автоматически, когда дойдёт её очередь. Нажимать Play не нужно.\n\n";
  const text = status.configured
    ? `${instructions}Музыка и громкость\nКолонка: ${selected?.name ?? selectedId ?? "не выбрана"}\n🎵 Сейчас играет: ${current}\nГромкость: ${volume}\nВ очереди: ${queue.pending.length}\n\nВыберите действие:`
    : `Музыка пока не настроена: ${status.reason ?? "нет данных"}`;
  return [text, { reply_markup: musicKeyboard(actorId, deps) }];
}

function musicKeyboard(actorId: string, deps: BotDependencies): InlineKeyboard {
  const isOwner = deps.access.isOwner(actorId);
  const keyboard = new InlineKeyboard();
  if (isOwner) {
    keyboard
      .text("Play", callback(actorId, { kind: "music_transport", action: "play" }, deps))
      .text("Pause", callback(actorId, { kind: "music_transport", action: "pause" }, deps)).row()
      .text("Очередь", callback(actorId, { kind: "music_queue" }, deps))
      .text("Следующий", callback(actorId, { kind: "music_next" }, deps)).row();
  } else {
    keyboard.text("Очередь", callback(actorId, { kind: "music_queue" }, deps)).row();
  }
  keyboard.text("Добавить песню", callback(actorId, { kind: "music_prompt" }, deps)).row();
  keyboard.text("Произнести фразу", callback(actorId, { kind: "music_speak" }, deps)).row();
  const maxVolume = maxVolumeForRole(isOwner);
  const rowSize = maxVolume === 6 ? 3 : 5;
  for (let level = 1; level <= maxVolume; level += 1) {
    keyboard.text(String(level), callback(actorId, { kind: "music_volume", level }, deps));
    if (level % rowSize === 0) keyboard.row();
  }
  return keyboard.text("В главное меню", callback(actorId, { kind: "home" }, deps));
}

async function musicQueueView(actorId: string, deps: BotDependencies): Promise<View> {
  const queue = await deps.music.getQueue();
  const lines = [
    "Музыкальная очередь",
    "",
    `🎵 Сейчас играет: ${queue.current?.query ?? "нет данных от колонки"}`,
    "",
    ...(queue.pending.length
      ? queue.pending.map((item, index) => `${index + 2}. ${item.query}`)
      : ["Следующих треков нет."]),
  ];
  const keyboard = new InlineKeyboard();
  if (deps.access.isOwner(actorId)) {
    keyboard.text("Следующий", callback(actorId, { kind: "music_next" }, deps)).row();
    keyboard.text("Очистить очередь", callback(actorId, { kind: "music_clear_queue" }, deps)).row();
  }
  keyboard.text("К музыке", callback(actorId, { kind: "music" }, deps));
  return [lines.join("\n"), { reply_markup: keyboard }];
}

function queueResultText(query: string, position: number, started: boolean): string {
  return started
    ? `🎵 Сейчас запускаю: ${query}. Это первый трек в очереди. Нажимать Play не нужно.`
    : `Трек добавлен: ${query}. Позиция в очереди: ${position}. Он запустится автоматически.`;
}

function adminView(actorId: string, deps: BotDependencies): View {
  requireOwner(actorId, deps);
  const users = deps.database.listAuthorizedBotUsers().filter((user) => !deps.access.isOwner(user.telegramId));
  const keyboard = adminKeyboard(actorId, deps);
  for (const user of users) {
    keyboard.text(`Отозвать: ${formatUser(user)}`, callback(actorId, {
      kind: "admin_revoke",
      telegramId: user.telegramId,
    }, deps)).row();
  }
  keyboard.text("В главное меню", callback(actorId, { kind: "home" }, deps));
  const list = users.length ? users.map(formatUser).join("\n") : "Пока никому не выдан доступ.";
  return [`Управление пользователями\n\n${list}`, { reply_markup: keyboard }];
}

function adminRequestsView(actorId: string, deps: BotDependencies): View {
  requireOwner(actorId, deps);
  const requests = deps.database.listPendingAccessRequests();
  const keyboard = new InlineKeyboard();
  for (const request of requests) {
    const user = formatUser(request.user);
    keyboard
      .text(`Принять: ${user}`, callback(actorId, {
        kind: "admin_approve_request",
        requestId: request.id,
      }, deps))
      .text("Отклонить", callback(actorId, {
        kind: "admin_reject_request",
        requestId: request.id,
      }, deps))
      .row();
  }
  keyboard.text("К пользователям", callback(actorId, { kind: "admin" }, deps));
  const list = requests.length
    ? requests.map((request) => `${formatUser(request.user)} — ${request.user.telegramId}`).join("\n")
    : "Новых заявок нет.";
  return [`Заявки на доступ\n\n${list}`, { reply_markup: keyboard }];
}

function adminKeyboard(actorId: string, deps: BotDependencies): InlineKeyboard {
  const count = deps.database.countPendingAccessRequests();
  return new InlineKeyboard()
    .text(`Заявки (${count})`, callback(actorId, { kind: "admin_requests" }, deps)).row()
    .text("Добавить пользователя", callback(actorId, { kind: "admin_prompt" }, deps)).row();
}

function requireOwner(actorId: string, deps: BotDependencies): void {
  if (!deps.access.isOwner(actorId)) throw new AccessDeniedError();
}

function formatUser(user: { username?: string; displayName: string }): string {
  return user.username ? `@${user.username}` : user.displayName;
}

function deviceView(actorId: string, device: Device, deps: BotDependencies): View {
  const keyboard = new InlineKeyboard();
  for (const capability of device.capabilities) addCapabilityButtons(keyboard, actorId, device, capability, deps);
  keyboard.text("В главное меню", callback(actorId, { kind: "home" }, deps));

  const room = deps.catalog.getCatalog().rooms.find((candidate) => candidate.id === device.roomId)?.name;
  const status = device.status ? `Статус: ${device.status}` : "Статус: нет данных";
  const properties = device.properties
    .filter((property) => property.state)
    .map((property) => `${property.state?.instance}: ${String(property.state?.value)}`);
  const lines = [device.name, room ? `Комната: ${room}` : undefined, status, ...properties].filter(Boolean);
  return [lines.join("\n"), { reply_markup: keyboard }];
}

function addCapabilityButtons(
  keyboard: InlineKeyboard,
  actorId: string,
  device: Device,
  capability: Capability,
  deps: BotDependencies,
): void {
  const instance = parameterInstance(capability);
  if (!instance) return;
  const action = (value: boolean | number | string | JsonObject): string =>
    callback(
      actorId,
      {
        kind: "action",
        command: {
          targetId: device.id,
          targetType: "device",
          capabilityType: capability.type,
          instance,
          value,
        },
      },
      deps,
    );

  if (capability.type.endsWith("on_off")) {
    keyboard.text("Включить", action(true)).text("Выключить", action(false)).row();
  } else if (capability.type.endsWith("toggle")) {
    keyboard.text(`${instance}: вкл`, action(true)).text(`${instance}: выкл`, action(false)).row();
  } else if (capability.type.endsWith("range")) {
    const range = capability.parameters.range as JsonObject | undefined;
    const min = range?.min;
    const max = range?.max;
    if (typeof min === "number" && typeof max === "number") {
      const middle = Math.round((min + max) / 2);
      keyboard.text(String(min), action(min)).text(String(middle), action(middle)).text(String(max), action(max)).row();
    }
  } else if (capability.type.endsWith("mode") && Array.isArray(capability.parameters.modes)) {
    for (const mode of capability.parameters.modes.slice(0, 12)) {
      if (typeof mode === "object" && mode !== null && "value" in mode && typeof mode.value === "string") {
        keyboard.text(mode.value, action(mode.value));
      }
    }
    keyboard.row();
  }
}

function callback(actorId: string, payload: CallbackPayload, deps: BotDependencies): string {
  return `cb:${deps.database.createCallback(actorId, payload, deps.callbackTtlSeconds)}`;
}

function parameterInstance(capability: Capability): string | undefined {
  return typeof capability.parameters.instance === "string"
    ? capability.parameters.instance
    : capability.state?.instance;
}

async function ensureCatalog(catalog: CatalogService): Promise<void> {
  try {
    catalog.getCatalog();
  } catch {
    if (catalog.isLiveConfigured()) await catalog.syncCatalog();
    else throw new Error("YANDEX_IOT_TOKEN не настроен, а локального каталога ещё нет");
  }
}

function userError(error: unknown): string {
  if (error instanceof AccessDeniedError) return "Доступ запрещён";
  return error instanceof Error ? error.message : "Неизвестная ошибка";
}
