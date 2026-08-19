# SaaS Starter

[English](README.md) | **Русский**

[![CI](https://github.com/Shlykoff/saas-next-stripe-starter/actions/workflows/ci.yml/badge.svg)](https://github.com/Shlykoff/saas-next-stripe-starter/actions/workflows/ci.yml)

**Живое демо:** https://saas.shlykoff.com — тестовые аккаунты ниже ("Запуск локально"), тестовые карты — в разделе "Stripe".

SaaS-стартер с подпиской: Next.js (App Router) + Supabase (Auth/Postgres/RLS) + Stripe (Checkout, Customer Portal, Webhooks). Полное ТЗ — `docs/spec.md`, контекст для агентов — `CLAUDE.md`.

> Задеплоен на прод (Vercel + hosted Supabase + Stripe test mode + Resend) и пройден вручную в браузере от начала до конца: регистрация с подтверждением email, Google OAuth, онбординг, Checkout, апгрейд плана с немедленным списанием, гейтинг `/notes` по подписке.

## Скриншоты

| Лендинг | Тарифы | Личный кабинет |
|---|---|---|
| ![Лендинг](docs/screenshots/landing.png) | ![Страница тарифов, текущий план выделен](docs/screenshots/pricing.png) | ![Личный кабинет с активной подпиской](docs/screenshots/dashboard.png) |

| Заметки (закрытая фича) | Stripe Customer Portal |
|---|---|
| ![CRUD заметок](docs/screenshots/notes.png) | ![Stripe Customer Portal — смена плана](docs/screenshots/billing-portal.png) |

## Стек

Next.js 16 (App Router, Server Actions, Server Components) · Supabase (Auth + Postgres + RLS) · Stripe (Checkout, Customer Portal, Webhooks) · Tailwind v4 + shadcn/ui (base-ui) · TypeScript strict.

## Функционал

- **Регистрация/логин** (`/signup`, `/login`) — email+пароль плюс Google OAuth (PKCE). Подтверждение email обязательно перед входом, через кастомный роут `/auth/confirm` (не встроенный verify-URL Supabase — нужно для совместимости с PKCE).
- **Онбординг** (`/onboarding`) — создание organization; создатель автоматически становится owner'ом.
- **Тарифы** (`/pricing`) — планы Basic/Pro → Stripe Checkout. Кнопка Subscribe скрыта для не-owner'ов, защита на сервере (`requireOrgOwner`).
- **Личный кабинет** (`/dashboard`) — текущий план/статус/дата продления, "Manage billing" → Stripe Customer Portal.
- **Notes** (`/notes`, гейтится по активной подписке) — общие для организации заметки с RLS-CRUD (редактировать/удалять чужую заметку может только owner), серверная пагинация/поиск/сортировка, live-обновления через **приватный** broadcast-канал Supabase Realtime вместо `postgres_changes` (который не проверяет RLS для событий `DELETE`). Поддерживает **вложения** (изображения/PDF/документы, до 10 МиБ), загружаемые прямо из браузера в приватный Storage-бакет через signed URL — почему так, см. "Ключевые технические решения".
- **Переключатель организаций** — пользователь может состоять в нескольких организациях; активная хранится в куке, перепроверяется на сервере при каждом переключении.
- **Участники и email-инвайты** (`/dashboard/members`) — owner приглашает по email+роли через Resend; может удалить участника или сменить роль, оба действия шлют письмо-уведомление.
- **Адаптивный хедер** — сворачивается в мобильное меню ниже 768px.
- **Роуты защищены** и в `proxy.ts`, и повторно на каждой server-странице — не просто для UX.

## Запуск локально

```bash
npm install
supabase start          # локальный Supabase в Docker
cp .env.example .env.local
# заполнить .env.local из `supabase status` + Stripe test-ключами (см. ниже)
npm run dev
```

Держите `stripe listen --forward-to localhost:3000/api/webhooks/stripe` запущенным в отдельном терминале весь сеанс — без него вебхуки не долетают до `localhost`, и `/dashboard` будет выглядеть так, будто оплата не прошла, хотя она прошла. Пропустили событие? `stripe events resend <event_id> --confirm`.

Используйте один и тот же хост везде — `127.0.0.1` или `localhost`, не смешивайте — браузеры считают их разными origin'ами для cookie, что ломает сессию после Checkout. `.env.example`/`supabase/config.toml` уже согласованы на `127.0.0.1`.

> Если `npm run dev` уходит в цикл `Watchpack Error: EMFILE: too many open files` — это локальный лимит файловых дескрипторов, не баг проекта. Попробуйте `ulimit -n 10240` перед `npm run dev`, либо `npm run build && npm run start` (без persistent-вотчера).

Флоу вручную:

1. `/signup` email+паролем → письмо-подтверждение в Mailpit (`http://127.0.0.1:54324`) → перейти по ссылке.
2. Онбординг: назвать workspace → `/dashboard`.
3. `/pricing` → Subscribe → Checkout картой `4242 4242 4242 4242`.
4. На `/dashboard` статус подписки обновится через вебхук (нужен запущенный `stripe listen`, либо `stripe trigger checkout.session.completed`).
5. `/notes` открывается, когда подписка `active`/`trialing`.

Либо не проходить Checkout, а взять сид-аккаунты из `supabase/seed.sql` (пароль `password123` для всех):

| Email | Организация | Роль | Подписка |
|---|---|---|---|
| `owner_a@example.com` | Acme | owner | `active` — `/notes` открыт |
| `member_a@example.com` | Acme | member | `active` — `/notes` открыт, billing скрыт |
| `owner_b@example.com` | Globex | owner | нет подписки — `/notes` показывает paywall |

Тесты: `npm run test` (Vitest, нужен запущенный локальный Supabase — интеграционные тесты пишут в реальные таблицы).

Поменяли схему БД? Перегенерируйте типы: `npm run db:types`.

### Проверить что-то на проде прямо из шелла

`.env.local` всегда указывает на локальный Docker Supabase. Для разовых проверок на hosted-проекте — отдельный gitignored `.env.production.local`, подгружаемый только в текущий шелл:

```bash
source scripts/env.sh production   # только этот шелл
source scripts/env.sh local        # обратно на локальный
```

## Google OAuth

Проверено живьём end-to-end. Без реальных credentials кнопка рендерится, но падает на экране согласия Google (`invalid_client`) — ожидаемо на свежем клоне.

1. Создать OAuth 2.0 Client в [Google Cloud Console](https://console.cloud.google.com/apis/credentials).
2. Redirect URI (локально): `http://127.0.0.1:54321/auth/v1/callback` (callback самого Supabase Auth).
3. Перед `supabase start` экспортировать `GOOGLE_OAUTH_CLIENT_ID`/`GOOGLE_OAUTH_CLIENT_SECRET` (см. `[auth.external.google]` в `supabase/config.toml`).
4. Для прода — то же самое, реальный домен, переменные в Vercel/hosted Supabase.

## Stripe

### Переменные окружения

Все — в `.env.example`:

| Переменная | Назначение |
|---|---|
| `STRIPE_SECRET_KEY` | Только сервер (`lib/stripe.ts`). |
| `STRIPE_WEBHOOK_SECRET` | Проверка подписи вебхука. Локально — из `stripe listen`, в проде — из Dashboard. |
| `STRIPE_PRICE_ID_BASIC`, `STRIPE_PRICE_ID_PRO` | Id тарифных Price. |
| `STRIPE_PORTAL_CONFIGURATION_ID` | Portal-конфигурация с переключением плана (см. ниже). |
| `NEXT_PUBLIC_APP_URL` | Базовый URL для редиректов Checkout/Portal и инвайт-писем. |
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Публичные Supabase-значения. |
| `SUPABASE_SERVICE_ROLE_KEY` | Только сервер — webhook-обработчик, принятие инвайтов, ростер участников. |
| `RESEND_API_KEY` | Только сервер — письма-инвайты. |

Test и live ключи Stripe никогда не смешиваются: локально/CI — test, прод — live.

### Тестовые карты

- Успех: `4242 4242 4242 4242`.
- Отклонённое продление (`invoice.payment_failed`): `4000 0000 0000 0341`.
- Полный список: https://docs.stripe.com/testing

### Тестирование вебхука локально

```bash
stripe login
stripe listen --forward-to localhost:3000/api/webhooks/stripe
```

Выведет `whsec_...` для `STRIPE_WEBHOOK_SECRET`. Затем, пока работают `npm run dev` и `stripe listen`:

```bash
stripe trigger checkout.session.completed
stripe trigger customer.subscription.updated
stripe trigger customer.subscription.deleted
stripe trigger invoice.payment_failed
```

`tests/webhooks-stripe.test.ts` автоматически проверяет подпись и идемпотентность без реального Stripe-аккаунта (`generateTestHeaderString`).

### Смена плана в Customer Portal

Дефолтный Customer Portal не умеет менять план — только отменить или сменить карту. Включается через portal configuration (`features.subscription_update.enabled = true`, `proration_behavior = "always_invoice"` для немедленного списания при апгрейде):

```bash
curl https://api.stripe.com/v1/billing_portal/configurations \
  -u "$STRIPE_SECRET_KEY:" \
  -d "features[subscription_update][enabled]=true" \
  -d "features[subscription_update][proration_behavior]=always_invoice" \
  -d "features[subscription_update][default_allowed_updates][]=price" \
  -d "features[subscription_update][products][0][product]=<basic_product_id>" \
  -d "features[subscription_update][products][0][prices][0]=$STRIPE_PRICE_ID_BASIC" \
  -d "features[subscription_update][products][1][product]=<pro_product_id>" \
  -d "features[subscription_update][products][1][prices][0]=$STRIPE_PRICE_ID_PRO" \
  -d "features[subscription_cancel][enabled]=true" \
  -d "features[payment_method_update][enabled]=true"
```

Сохраните возвращённый `id` как `STRIPE_PORTAL_CONFIGURATION_ID`.

## Что сделать вручную перед первым живым запуском Stripe

1. Создать Stripe-аккаунт, включить test mode.
2. Создать Product/Price для Basic/Pro, вписать `STRIPE_PRICE_ID_BASIC`/`STRIPE_PRICE_ID_PRO`.
3. Задать `STRIPE_SECRET_KEY`.
4. Запустить `stripe listen`, задать `STRIPE_WEBHOOK_SECRET`.
5. Создать portal configuration (выше), задать `STRIPE_PORTAL_CONFIGURATION_ID`.
6. Пройти Checkout тестовой картой и убедиться, что `subscriptions` обновилась.

## Ключевые технические решения

**RLS deny-by-default, а не фильтрация по `organization_id` в приложении.** На каждой таблице с пользовательскими данными — форсированный RLS с отдельными select/insert/update/delete политиками; одна забытая `.eq()` в коде не может привести к утечке между организациями. Часть логики, обычно живущей в приложении (защита последнего owner'а, целостность между таблицами), вынесена в DB-триггеры — например, `trg_prevent_last_owner_change` использует advisory lock, закрывающий реальную гонку, где два одновременных удаления могли оба "выиграть".

**Идемпотентность вебхука — claim/CAS state machine, а не `insert ... on conflict do nothing`.** Наивная проверка "видели ли этот event id" ломается под конкурентными ретраями Stripe. `processed_stripe_events` хранит явный `status` + `claim_token`: дубль либо не может забрать claim и получает `409` (форсируя честный retry), либо видит `status='succeeded'` и отвечает `200` — никогда по факту одного лишь существования строки.

**Auth-роуты пишут cookies явно на response-объект**, а не через ambient `cookies()` — воспроизведённый на практике баг, где ambient-мутация не гарантированно попадала на реальный `NextResponse`, тихо роняя сессию. `signOut()` использует `scope: "local"` по той же причине: дефолт SDK (`"global"`) убивает все сессии на всех устройствах, а не только текущую вкладку.

**Вложения к заметкам загружаются напрямую из браузера в Storage**, не через Server Action с байтами файла — serverless-функции Vercel ограничивают тело запроса ~4.5MB, что меньше лимита бакета в 10 МиБ, так что реальное фото с телефона отклонилось бы платформой раньше, чем сработала бы собственная проверка приложения. Server Action выдаёт короткоживущий signed upload URL; браузер грузит байты напрямую в Storage; второй Server Action записывает метаданные, когда байты уже на месте.

**Миграции накатываются на hosted Supabase прямо во время сборки на Vercel**, а не ручным шагом — раньше изменение схемы требовало запуска `supabase db push` руками перед пушем зависимого кода, легко перепутать порядок и ненадолго сломать живой сайт. `scripts/apply-production-migrations.mjs` запускается в начале каждой сборки, no-op вне `VERCEL_ENV=production`, и роняет всю сборку при ошибке миграции (старый деплой остаётся живым).
