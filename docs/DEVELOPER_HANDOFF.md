# Developer handoff: Yandex Home Remote

Этот документ рассчитан на разработчика, который впервые открыл репозиторий и должен быстро понять систему, безопасно запустить её и продолжить разработку.

## 1. Что это за проект

Yandex Home Remote — локальный backend и Telegram-бот для управления личным Яндекс.Домом и Яндекс Станцией.

Система решает две разные технические задачи:

1. Устройства и пользовательские сценарии управляются через официальный Yandex IoT user API.
2. Музыка, громкость, TTS и голосовые команды для Станции отправляются через локальный Home Assistant с интеграцией AlexxIT/YandexStation.

Backend работает на компьютере владельца в Docker. Telegram использует long polling, поэтому публичный сервер, webhook и белый IP не нужны.

## 2. Архитектура в одном абзаце

Telegram Bot — transport/UI слой. Он принимает команды и callback-кнопки, но не содержит клиентов внешних API. Core-сервисы проверяют доступ и бизнес-правила. Интеграционные клиенты обращаются к Yandex IoT, Home Assistant и, опционально, Music Assistant. SQLite хранит кеш каталога, пользователей, заявки, одноразовые callback, журнал действий и локальную музыкальную очередь. Composition root находится в `src/main.ts`.

Полная схема и обоснование решений: [ARCHITECTURE.md](ARCHITECTURE.md).

```text
Telegram
   │
   ▼
bot.ts ──► AccessService
   │      CatalogService ──► Yandex IoT API
   │      ActionService  ──► Yandex IoT API
   └────► MusicService   ──► Home Assistant ──► YandexStation ──► колонка
              │                    ▲
              │                    └── Music Assistant: только optional telemetry
              ▼
            SQLite
```

## 3. Структура кода

| Путь | Ответственность |
|---|---|
| `src/main.ts` | Создание зависимостей, запуск Fastify и Telegram long polling, graceful shutdown, таймер reconciliation |
| `src/bot/bot.ts` | Команды Telegram, inline-меню, пользовательские состояния ввода, представление ошибок |
| `src/core/access.service.ts` | Owner/guest authorization |
| `src/core/music-access-policy.ts` | Allowlist действий обычного пользователя |
| `src/core/volume-policy.ts` | Диапазон громкости owner `0–10`, guest `1–6` |
| `src/core/catalog.service.ts` | Синхронизация и чтение каталога Яндекс.Дома |
| `src/core/action.service.ts` | Валидация capability и сериализация команд одному target |
| `src/core/music.service.ts` | Музыка, очередь, громкость, transport, TTS, команды Алисе |
| `src/integrations/yandex-iot.client.ts` | Официальный Yandex IoT user API |
| `src/integrations/home-assistant.client.ts` | REST-вызовы сервисов `media_player` |
| `src/integrations/music-assistant.client.ts` | Необязательная телеметрия; не является основным плеером |
| `src/db/database.ts` | SQLite schema, запросы и транзакции |
| `src/api/server.ts` | Локальный health/catalog API |
| `src/config/env.ts` | Валидация переменных окружения через Zod |
| `tests/` | Unit и integration-style тесты с подменёнными внешними клиентами |

## 4. Модель прав

Есть две роли.

| Возможность | Владелец | Обычный пользователь |
|---|---:|---:|
| Добавить песню | Да | Да |
| Посмотреть очередь | Да | Да |
| TTS: произнести текст | Да | Да |
| Громкость | `0–10` | `1–6` |
| Play/Pause/Next/очистка очереди | Да | Нет |
| Выбор колонки | Да | Нет |
| Устройства и сценарии | Да | Нет |
| Пользователи и заявки | Да | Нет |

Владелец задаётся через `OWNER_TELEGRAM_ID`. Гость сначала отправляет `/start`; заявка попадает в SQLite и должна быть принята владельцем.

Ограничения реализованы в двух местах:

- интерфейс не показывает запрещённые кнопки;
- backend повторно проверяет callback/команду, поэтому старую кнопку или ручной ввод нельзя использовать для обхода UI.

## 5. Основные потоки

### Команда устройству

```text
Telegram callback
→ проверка пользователя
→ чтение одноразового callback из SQLite
→ повторная загрузка/проверка target и capability
→ ActionService
→ YandexIotClient
→ журнал результата в SQLite
```

Команды одному target сериализуются в `ActionService`, чтобы быстрые параллельные нажатия не создавали гонку.

### Добавление песни

```text
Пользователь вводит запрос
→ MusicService.enqueue
→ запись QUEUED в SQLite
→ если активного трека нет: PLAYING + команда «Включи песню ...» через Home Assistant
→ иначе запрос ждёт в локальной очереди
```

Пользователю не нужно отдельно нажимать Play. `/play запрос` исторически означает «добавить запрос в очередь».

### TTS

```text
Текст до 100 символов
→ MusicService.speak
→ Home Assistant `media_player.play_media`
→ `media_content_type: text`
→ выбранная колонка произносит текст
```

Это text-to-speech. Получить аудио с микрофона Станции для speech-to-text текущая интеграция не позволяет.

### Inline callback

В Telegram не передаётся полный payload. Backend создаёт в SQLite случайный короткий ID с `actor_id`, payload и TTL. При нажатии запись атомарно читается и удаляется. Callback нельзя повторить, использовать после истечения TTL или нажать из другого аккаунта.

## 6. Музыкальная очередь и источник истины

`music_queue` использует состояния:

```text
QUEUED → PLAYING → DONE
                  ↘ FAILED
QUEUED/PLAYING ───→ CLEARED
```

SQLite хранит намерение пользователя, но не доказывает, что физически играет на колонке. Строка «Сейчас играет» должна заполняться только внешней телеметрией. Если интеграция отдаёт `playing`, но не отдаёт title, UI показывает «нет данных от колонки».

Music Assistant нельзя снова делать основным исполнительным контуром без отдельной проверки: Yandex Station provider не поддерживал надёжный enqueue, недоступные треки вызывали `MediaNotFoundError`, 500 и самопроизвольные переходы. Сейчас он используется только best-effort для чтения состояния и очистки старой очереди.

Reconciliation запускается каждые пять секунд. Автопереход допускается только при подтверждённом `idle` и после защитного интервала от последней команды. Нельзя добавлять переход «по таймеру длительности»: длительность и окончание трека часто неизвестны.

## 7. SQLite

Схема создаётся автоматически в `AppDatabase.migrate()`.

| Таблица | Что хранит |
|---|---|
| `app_state` | Кеш нормализованного каталога |
| `bot_users` | Telegram ID, username, display name, authorization |
| `access_requests` | Заявки `PENDING/APPROVED/REJECTED` |
| `bot_callbacks` | Одноразовые callback с actor и TTL |
| `action_log` | Команды устройствам и результат без токенов |
| `music_queue` | Запрос, автор, колонка, статус и timestamps |

В Docker база находится в volume `home-remote-data`. `docker compose down` сохраняет её; `docker compose down -v` удалит данные.

## 8. Конфигурация и секреты

Скопировать шаблон:

```powershell
Copy-Item .env.example .env
```

Минимальные группы переменных:

- Yandex IoT: `YANDEX_IOT_TOKEN`, опционально `YANDEX_IOT_REFRESH_TOKEN`;
- Telegram: `TELEGRAM_BOT_TOKEN`, `OWNER_TELEGRAM_ID`;
- Station: `HOME_ASSISTANT_URL`, `HOME_ASSISTANT_TOKEN`, `YANDEX_STATION_ENTITY_ID`;
- optional telemetry: `MUSIC_ASSISTANT_URL`, `MUSIC_ASSISTANT_TOKEN`, `MUSIC_ASSISTANT_PLAYER_ID`.

Никогда не коммитить:

- `.env`;
- SQLite и WAL-файлы;
- Home Assistant `/config` и `.storage`;
- реальные Telegram/Yandex/Home Assistant/Music Assistant tokens;
- реальные entity/player IDs, если они идентифицируют личное устройство.

Перед публичным push используется Gitleaks:

```powershell
gitleaks git . --redact
```

## 9. Локальный запуск

Требования:

- Node.js 22+;
- Docker Desktop с работающим Linux engine и WSL 2;
- Telegram bot token;
- Yandex OAuth token;
- настроенный Home Assistant для функций Станции.

Без Docker:

```powershell
npm install
Copy-Item .env.example .env
npm run check
npm run dev
```

Полный стек:

```powershell
npm install
npm run check
docker compose up -d --build
docker compose ps
Invoke-RestMethod http://127.0.0.1:3000/health
```

Home Assistant открывается локально на `http://127.0.0.1:8123`, Music Assistant — на `http://127.0.0.1:8095`.

Важно: одновременно должен работать один экземпляр Telegram-бота. Не запускать `npm run dev` параллельно с контейнером `app`.

## 10. Получение Yandex OAuth token

OAuth-приложению нужны scopes `iot:view` и `iot:control`, redirect URI — `https://oauth.yandex.ru/verification_code`.

```powershell
$env:YANDEX_CLIENT_ID = Read-Host 'Yandex Client ID'
$secret = Read-Host 'Yandex Client Secret' -AsSecureString
$env:YANDEX_CLIENT_SECRET = [Net.NetworkCredential]::new('', $secret).Password
npm run auth:yandex
Remove-Item Env:\YANDEX_CLIENT_ID, Env:\YANDEX_CLIENT_SECRET
```

Скрипт открывает OAuth, проверяет каталог и записывает token только в локальный `.env`.

## 11. Проверка изменений

Обязательная команда перед commit/push:

```powershell
npm run check
```

Она последовательно выполняет:

1. TypeScript build;
2. typecheck тестов;
3. Vitest.

Для изменения runtime дополнительно:

```powershell
docker compose up -d --build app
docker compose ps app
Invoke-RestMethod http://127.0.0.1:3000/health
docker compose logs --since 2m app
```

Успешная сборка не доказывает работу реальной колонки. Команды, меняющие звук, проверяются на устройстве только осознанно, чтобы не прерывать пользователя.

## 12. Git workflow

Публичный remote: `https://github.com/MrPuzzles-man/yandex-home-remote`.

Каждое законченное изменение сохраняется отдельным коммитом:

```powershell
git status
npm run check
gitleaks git . --redact
git add <конкретные-файлы>
git commit -m "Короткое описание изменения"
git push origin main
```

Не использовать `commit --amend` и force-push для уже опубликованных версий. Не добавлять весь рабочий каталог вслепую: сначала проверить `git status` и сохранить чужие незакоммиченные изменения.

## 13. Куда вносить типовые изменения

- Новая кнопка/команда Telegram: `src/bot/bot.ts` и тип `CallbackPayload` в `src/db/database.ts`.
- Новое правило гостевого доступа: `src/core/music-access-policy.ts` плюс тест.
- Новое ограничение значения: отдельная policy в `src/core`, затем проверка до вызова интеграции.
- Новое действие Яндекс.Дома: `domain/models.ts` → `ActionService` → `YandexIotClient`.
- Новая команда Станции: `MusicService`, а не прямой fetch из bot layer.
- Новое поле конфигурации: `src/config/env.ts` и `.env.example` одновременно.
- Новая таблица: идемпотентное изменение `AppDatabase.migrate()` и тест с `:memory:`.

## 14. Известные ограничения

- Home Assistant/YandexStation часто не возвращает title и duration текущего трека.
- Из-за этого автоматическая очередь является best-effort, а не гарантированным gapless player.
- Выбранная колонка хранится в памяти процесса и общая для пользователей.
- STT с микрофона колонки отсутствует.
- Fastify API пока служебный, без полноценной web-панели и отдельной API-аутентификации кроме `x-telegram-user-id` для каталога.
- Home Assistant и YandexStation — community integration, её изменения могут ломать контракт.

## 15. Definition of Done для следующей задачи

Изменение считается законченным, когда:

1. правило реализовано на backend, а не только скрыто в UI;
2. добавлен или обновлён тест;
3. `npm run check` проходит;
4. документация и `.env.example` обновлены, если изменился контракт;
5. Gitleaks не находит секреты;
6. runtime-изменение пересобрано и `/health` отвечает `200`, если Docker доступен;
7. изменение сохранено отдельным коммитом и отправлено в `origin/main`;
8. ограничения реальной интеграции описаны честно, без подмены факта записью из SQLite.

## 16. Объяснение другому разработчику за минуту

> Это локальный Telegram-пульт для Яндекс.Дома. Внутри Node.js/TypeScript backend с разделением на transport, core и adapters. Устройства идут через официальный Yandex IoT user API, а аудиофункции Станции — через Home Assistant/YandexStation. SQLite хранит пользователей, одноразовые callback, журнал и очередь. Гости могут добавлять треки, видеть очередь, ставить громкость 1–6 и использовать TTS; остальные функции owner-only. Music Assistant не управляет воспроизведением и оставлен только для необязательной телеметрии. Главная техническая проблема — колонка не всегда сообщает реальный title/end-of-track, поэтому очередь работает консервативно и никогда не должна выдавать SQLite за фактическое состояние устройства.
