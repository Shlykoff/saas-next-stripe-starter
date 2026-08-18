# SaaS Starter

SaaS-стартер с подпиской: Next.js (App Router) + Supabase (Auth/Postgres/RLS) + Stripe (Checkout, Customer Portal, Webhooks). Полное ТЗ — `docs/spec.md`, контекст для агентов — `CLAUDE.md`.

> Статус: MVP-флоу собран целиком — регистрация/логин, онбординг (создание workspace), тарифы → Stripe Checkout, личный кабинет со статусом подписки → Stripe Customer Portal, продуктовая фича `/notes` (реальный CRUD с organization-scoped RLS) гейтится по статусу подписки. Скриншоты/демо-ссылка появятся при деплое на Vercel.

## Стек

Next.js 16 (App Router, Server Actions, Server Components) · Supabase (Auth + Postgres + RLS) · Stripe (Checkout, Customer Portal, Webhooks) · Tailwind v4 + shadcn/ui (base-ui) · TypeScript strict.

## Функционал

- **Регистрация/логин** (`/signup`, `/login`) — email+пароль через Server Actions (`app/actions/auth.ts`) + кнопка "Continue with Google" (OAuth, PKCE-флоу через `/auth/callback`). Серверная валидация email/пароля, понятные сообщения об ошибках (неверный пароль, уже зарегистрирован, email не подтверждён).
- **Онбординг** (`/onboarding`) — форма создания organization (name/slug); RLS-триггер в БД делает создателя owner'ом автоматически. Redirect на `/dashboard`, если organization уже есть.
- **Тарифы** (`/pricing`) — 2 плана (Basic/Pro) из `lib/plans.ts`, кнопка Subscribe → `createCheckoutSession` → Stripe Checkout. Показывает текущий план вместо кнопки, если подписка уже активна; для не-owner'ов кнопка скрыта (реальная защита — на уровне server action, см. `requireOrgOwner` в `app/actions/billing.ts`).
- **Личный кабинет** (`/dashboard`) — статус подписки, дата продления, кнопка "Manage billing" → Stripe Customer Portal. Баннер "оформите подписку" / "обновите способ оплаты", если подписки нет или платёж не прошёл.
- **Notes** (`/notes`, gated) — доступ только при `subscriptions.status in ('active', 'trialing')`, проверка выполняется на сервере в `app/notes/page.tsx` через `lib/subscription-access.ts` + RLS-защищённый запрос к `subscriptions` (не просто скрытие кнопки — организация без подписки физически не получает разметку контента). Под гейтингом — реальный CRUD над таблицей `notes` (`supabase/migrations/20260817212642_add_notes.sql`): общие для организации заметки, создать/редактировать может любой участник, удалить/отредактировать чужую заметку — только owner (это делает RLS-политика, не application-код — см. `app/actions/notes.ts`).
- **Роуты защищены** и на уровне `proxy.ts` (Next.js 16 переименовал `middleware.ts` в `proxy.ts`; редирект на `/login` до рендера), и повторно на уровне каждой server component-страницы (реальная проверка, а не UX-удобство).

## Запуск локально (весь флоу целиком)

```bash
npm install
supabase start          # поднимает локальный Supabase в Docker
cp .env.example .env.local
# заполнить .env.local значениями из `supabase status` + Stripe test-ключами (см. ниже)
npm run dev
```

**Пока идёт локальная разработка, держите `stripe listen --forward-to localhost:3000/api/webhooks/stripe` запущенным в отдельном терминале постоянно** (не только на время одного теста) — без него Stripe физически не может доставить вебхук на `localhost`, и `checkout.session.completed`/`customer.subscription.*` события просто теряются: Checkout пройдёт успешно, но `/dashboard` так и останется на "No active subscription", как будто оплата не сработала. Если забыли и уже потеряли событие — не нужно повторять Checkout, событие уже есть в Stripe: `stripe events list --limit 5` найдёт его `evt_...`, `stripe events resend <event_id> --confirm` доставит повторно, как только `stripe listen` снова поднят.

> Известное ограничение окружения: если `npm run dev` падает в цикл `Watchpack Error (watcher): EMFILE: too many open files`, это лимит файловых дескрипторов конкретной песочницы/машины, не баг проекта — `npm run build && npm run start` (без persistent watcher) не подвержен этой проблеме и подходит для сквозной проверки флоу.

**Держите один и тот же хост везде: либо `127.0.0.1`, либо `localhost` — не смешивайте.** Браузеры считают `localhost` и `127.0.0.1` разными хостами для куки, хотя оба указывают на один и тот же сервер. Если зашли в приложение через `http://127.0.0.1:3000`, а `NEXT_PUBLIC_APP_URL` в `.env.local` при этом стоит `http://localhost:3000` — после Stripe Checkout вас редиректнет обратно на `localhost`, где нет вашей сессионной cookie, и `/dashboard` покажет "не авторизован", хотя оплата прошла успешно. Та же логика для Google OAuth: `redirectTo`, который реально шлёт браузер, должен быть в `additional_redirect_urls` в `supabase/config.toml` — если он указан только для `site_url` (голого корня) без пути `/auth/callback`, GoTrue молча подменит редирект на `site_url`, и код авторизации никогда не будет обменян на сессию. `.env.example` и `supabase/config.toml` в этом репозитории уже согласованы на `127.0.0.1` — меняя один, обновляйте оба.

Пройти весь флоу вручную:

1. Открыть `http://localhost:3000`, нажать "Get started" → `/signup`, зарегистрироваться email+паролем (локально email-подтверждение выключено — сессия создаётся сразу).
2. Onboarding: ввести имя/slug workspace → redirect на `/dashboard`.
3. `/dashboard` покажет баннер "No active subscription" → перейти на `/pricing`.
4. Нажать "Subscribe" на любом плане → Stripe Checkout (test mode) → оплатить тестовой картой `4242 4242 4242 4242` (см. "Тестовые карты" ниже).
5. Redirect обратно на `/dashboard?checkout=success`. Статус подписки обновляется асинхронно через webhook — требует либо `stripe listen --forward-to localhost:3000/api/webhooks/stripe` запущенным заранее (см. ниже), либо ручного триггера `stripe trigger checkout.session.completed`.
6. После того как статус подписки стал `active`/`trialing` — `/notes` открывает реальный список заметок вместо paywall: можно создать заметку, отредактировать/удалить свою; owner организации может отредактировать/удалить любую заметку в организации (модерация), обычный member — только свои.

Либо не проходить Checkout руками, а использовать готовые тестовые аккаунты из `supabase/seed.sql` (загружаются автоматически при `supabase db reset`) — пароль для всех: `password123`:

| Email | Организация | Роль | Подписка |
|---|---|---|---|
| `owner_a@example.com` | Acme | owner | `active` — `/notes` открыт |
| `member_a@example.com` | Acme | member | `active` — `/notes` открыт, billing скрыт (не owner) |
| `owner_b@example.com` | Globex | owner | нет подписки — `/notes` показывает paywall |

Тесты: `npm run test` (Vitest). Требует запущенный локальный Supabase (`supabase start`) — интеграционные тесты (вебхук, гейтинг `/notes` по подписке, авторизация CRUD над `notes`) пишут/читают реальные таблицы локальной БД и используют сид-аккаунты из таблицы выше.

Если меняли схему БД (новая миграция) — перегенерируйте TS-типы, иначе `lib/supabase/database.types.ts` расходится со схемой молча:

```bash
npm run db:types   # supabase gen types typescript --local > lib/supabase/database.types.ts
```

## Google OAuth

Кнопка "Continue with Google" (`components/auth/google-oauth-button.tsx`) есть в UI и вызывает `supabase.auth.signInWithOAuth({ provider: "google" })`, но реальный OAuth-флоу **не заработает** без настоящих Google OAuth credentials — их у нас нет и репозиторий их не может предоставить. Локально клик по кнопке приведёт к ошибке на экране согласия Google (`Error 401: invalid_client`), пока не выполнены шаги ниже. Это ожидаемое поведение "из коробки".

Что нужно от пользователя, чтобы OAuth реально заработал:

1. Создать OAuth 2.0 Client в [Google Cloud Console](https://console.cloud.google.com/apis/credentials) (Application type: **Web application**).
2. Authorized redirect URI (локально): `http://127.0.0.1:54321/auth/v1/callback` — это callback самого Supabase Auth, а не `/auth/callback` этого приложения (тот стоит на шаг дальше по цепочке редиректов).
3. Экспортировать `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET` в shell **перед** запуском `supabase start` (см. `supabase/config.toml`'s `[auth.external.google]` и `.env.example` — эти переменные подставляются процессом `supabase start` через `env(...)`, а не читаются Next.js напрямую):
   ```bash
   export GOOGLE_OAUTH_CLIENT_ID=...
   export GOOGLE_OAUTH_CLIENT_SECRET=...
   supabase start
   ```
4. Для прод-деплоя — то же самое с реальным доменом в redirect URI, и те же переменные заданы в окружении Vercel/хостинга Supabase.

## Stripe

### Переменные окружения

Все — в `.env.example`. Коротко:

| Переменная | Назначение |
|---|---|
| `STRIPE_SECRET_KEY` | Секретный ключ Stripe (test mode: `sk_test_...`), используется только на сервере (`lib/stripe.ts`). |
| `STRIPE_WEBHOOK_SECRET` | Секрет для проверки подписи вебхука (`stripe.webhooks.constructEvent`). Локально — из `stripe listen` (см. ниже), в проде — из Stripe Dashboard при регистрации endpoint URL. |
| `STRIPE_PRICE_ID_BASIC`, `STRIPE_PRICE_ID_PRO` | Id тарифных Price, созданных заранее в Stripe Dashboard (test mode). |
| `NEXT_PUBLIC_APP_URL` | Базовый URL приложения — используется для `success_url`/`cancel_url`/`return_url` Checkout и Customer Portal. |
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Публичные Supabase-данные, для клиента и для server actions, работающих от имени текущего пользователя. |
| `SUPABASE_SERVICE_ROLE_KEY` | Только сервер. Используется исключительно в `lib/supabase/service-role.ts` (webhook-обработчик), никогда в клиентском коде. |

test/live режимы Stripe разделены строго через эти переменные: для локальной разработки и CI используется отдельный набор test-ключей, для прод-деплоя на Vercel — отдельный набор live-ключей, никогда не смешиваются.

### Тестовые карты

Для оплаты в Stripe Checkout (test mode):

- Успешный платёж: `4242 4242 4242 4242`, любая future-дата, любой CVC, любой ZIP.
- Отклонённый платёж (для проверки `invoice.payment_failed`): `4000 0000 0000 0341` (карта проходит на этапе Checkout, но списание/продление подписки отклоняется).

Полный список тестовых карт: https://docs.stripe.com/testing

### Тестирование вебхука локально через Stripe CLI

Требуется реальный Stripe-аккаунт (test mode) и [Stripe CLI](https://docs.stripe.com/stripe-cli).

```bash
stripe login
stripe listen --forward-to localhost:3000/api/webhooks/stripe
```

Команда выведет `whsec_...` — это значение и есть `STRIPE_WEBHOOK_SECRET` для `.env.local` на время локальной разработки (при каждом запуске `stripe listen` CLI может выдавать новый секрет — обновляйте `.env.local` соответственно).

Затем в отдельном терминале, пока `npm run dev` и `stripe listen` работают, можно сгенерировать тестовые события:

```bash
stripe trigger checkout.session.completed
stripe trigger customer.subscription.updated
stripe trigger customer.subscription.deleted
stripe trigger invoice.payment_failed
```

Либо пройти реальный Checkout flow, будучи залогиненным с workspace, через `/pricing` тестовой картой выше — `stripe listen` перешлёт событие на локальный `/api/webhooks/stripe`.

### Автоматизированный тест вебхука (без реального Stripe-аккаунта)

`tests/webhooks-stripe.test.ts` — интеграционный тест на `app/api/webhooks/stripe/route.ts`, использующий `stripe.webhooks.generateTestHeaderString` (тестовая утилита stripe-node, генерирует валидную подпись без реального аккаунта) и локальный Supabase. Проверяет:

- обработку события с валидной подписью и запись в `subscriptions`;
- идемпотентность — повторная доставка того же `event.id` не применяется повторно;
- отклонение запроса без `stripe-signature` / с невалидной подписью (400), без обработки тела.

Требует только запущенный локальный Supabase (`supabase start`) — реальные Stripe-ключи не нужны, т.к. `constructEvent`/`generateTestHeaderString` — чистые локальные HMAC-операции без сетевых вызовов.

## Что нужно сделать вручную перед первым «живым» запуском Stripe

1. Создать Stripe-аккаунт (если его ещё нет) и включить test mode.
2. Создать 2 Product/Price в Stripe Dashboard (test mode) под тарифы Basic/Pro, вписать их id в `STRIPE_PRICE_ID_BASIC` / `STRIPE_PRICE_ID_PRO`.
3. Скопировать `sk_test_...` ключ в `STRIPE_SECRET_KEY`.
4. Запустить `stripe listen --forward-to localhost:3000/api/webhooks/stripe`, вписать выданный `whsec_...` в `STRIPE_WEBHOOK_SECRET`.
5. Пройти Checkout тестовой картой `4242 4242 4242 4242` и убедиться, что `subscriptions` в локальной БД обновилась.

## Что дальше

- **Google OAuth** реальными credentials — см. раздел выше.
- **Org switcher**: сейчас у пользователя предполагается ровно одна организация (`lib/org.ts`'s `getActiveOrganization` берёт первую по `created_at`); инвайт-флоу и мульти-org UI не входили в этот этап.
- **Notes**: сейчас общие для всей организации, плоский список без пагинации/поиска/сортировки, без вложений и real-time обновлений между участниками (нужно обновить страницу, чтобы увидеть чужие правки). Хватает для демонстрации paywall-гейтинга; для реального продукта — отдельная итерация.
