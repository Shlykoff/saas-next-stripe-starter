# SaaS Starter

[English](README.md) | **Русский**

[![CI](https://github.com/Shlykoff/saas-next-stripe-starter/actions/workflows/ci.yml/badge.svg)](https://github.com/Shlykoff/saas-next-stripe-starter/actions/workflows/ci.yml)

**Живое демо:** https://saas.shlykoff.com — тестовые доступы и карты см. в разделах ниже ("Запуск локально" для сид-аккаунтов, "Тестовые карты" для Stripe).

SaaS-стартер с подпиской: Next.js (App Router) + Supabase (Auth/Postgres/RLS) + Stripe (Checkout, Customer Portal, Webhooks). Полное ТЗ — `docs/spec.md`, контекст для агентов — `CLAUDE.md`.

> Статус: MVP-флоу собран целиком, задеплоен на прод (Vercel + hosted Supabase + Stripe test mode + Resend) и вручную пройден в браузере от начала до конца — регистрация с обязательным подтверждением email (реальная доставка через Resend), вход через Google OAuth, онбординг (создание workspace), тарифы → Stripe Checkout, апгрейд плана Basic→Pro прямо в Stripe Customer Portal с немедленным списанием разницы, личный кабинет со статусом/названием подписки, продуктовая фича `/notes` (реальный CRUD с organization-scoped RLS) гейтится по статусу подписки.

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

- **Регистрация/логин** (`/signup`, `/login`) — email+пароль через Server Actions (`app/actions/auth.ts`) + кнопка "Continue with Google" (OAuth, PKCE-флоу через `/auth/callback`). Серверная валидация email/пароля, понятные сообщения об ошибках (неверный пароль, уже зарегистрирован, email не подтверждён). **Email-подтверждение обязательно** (`auth.email.enable_confirmations = true` в `supabase/config.toml`): после `/signup` логин заблокирован, пока пользователь не перейдёт по ссылке из письма. Ссылка ведёт на собственный роут приложения `/auth/confirm` (`app/auth/confirm/route.ts`, кастомный темплейт `supabase/templates/confirmation.html`), а не на встроенный `.../auth/v1/verify` Supabase — это нужно для совместимости с PKCE-флоу, который использует остальное приложение (тот же паттерн явной записи cookies на response, что и в `/auth/callback`).
- **Онбординг** (`/onboarding`) — форма создания organization (name/slug); RLS-триггер в БД делает создателя owner'ом автоматически. Redirect на `/dashboard`, если organization уже есть.
- **Тарифы** (`/pricing`) — 2 плана (Basic/Pro) из `lib/plans.ts`, кнопка Subscribe → `createCheckoutSession` → Stripe Checkout. Показывает текущий план вместо кнопки, если подписка уже активна; для не-owner'ов кнопка скрыта (реальная защита — на уровне server action, см. `requireOrgOwner` в `app/actions/billing.ts`).
- **Личный кабинет** (`/dashboard`) — название и статус текущего плана (`lib/plans.ts`'s `planForPriceId`, обратный поиск по `subscriptions.stripe_price_id`), дата продления, кнопка "Manage billing" → Stripe Customer Portal. Баннер "оформите подписку" / "обновите способ оплаты", если подписки нет или платёж не прошёл.
- **Notes** (`/notes`, gated) — доступ только при `subscriptions.status in ('active', 'trialing')`, проверка выполняется на сервере в `app/notes/page.tsx` через `lib/subscription-access.ts` + RLS-защищённый запрос к `subscriptions` (не просто скрытие кнопки — организация без подписки физически не получает разметку контента). Под гейтингом — реальный CRUD над таблицей `notes` (`supabase/migrations/20260817212642_add_notes.sql`): общие для организации заметки, создать/редактировать может любой участник, удалить/отредактировать чужую заметку — только owner (это делает RLS-политика, не application-код — см. `app/actions/notes.ts`). Список пагинируется на сервере (по 20 на страницу, `?page=`), ищется (`?q=`, регистронезависимый `ilike` по title/body, дебаунс на клиенте перед обращением к серверу) и сортируется (`?sort=newest|oldest|title_asc`) — всё это в `getOrganizationNotes` из `lib/notes.ts`, полностью управляется URL и читается на сервере в `app/notes/page.tsx` (`components/notes/notes-toolbar.tsx`, `components/notes/notes-pagination.tsx`). Изменения от другого участника (или от того же пользователя в другой вкладке) появляются live через `components/notes/notes-realtime.tsx` — **приватный** broadcast-канал Supabase Realtime (`notes:org:<organization_id>`), а не стандартный `postgres_changes`: `postgres_changes` не проверяет RLS для событий `DELETE` (документированное ограничение самого Postgres/Realtime — после удаления строки уже не с чем сверять политику), поэтому наивный клиентский `filter: organization_id=eq.<id>` разлетелся бы по всем организациям для удалений. Вместо этого триггер в БД (`trg_notes_broadcast_changes`) публикует INSERT/UPDATE/DELETE в этот приватный топик, а настоящая RLS-политика на `realtime.messages` (`notes_broadcast_authorized_org_members`, `supabase/migrations/20260818174917_enable_notes_realtime.sql`) авторизует доставку каждому подписчику по его собственному JWT — это проверено на реальном WebSocket-соединении с двумя реальными организациями в `tests/notes-realtime.test.ts`, а не просто принято на веру из комментария в миграции. У заметок также есть **вложения** (изображения, PDF, plain text/CSV, офисные документы — до 10 МиБ): метаданные лежат в `note_attachments` (`supabase/migrations/20260818222947_add_note_attachments.sql`), а сами байты файла — в приватном Storage-бакете `note-attachments`, оба независимо защищены RLS по той же границе организации (триггер в БД следит, чтобы `note_attachments.organization_id` не разошёлся с организацией заметки, на которую он ссылается, — одной только RLS-проверкой `WITH CHECK` кросс-табличное значение не проверить). Загрузка идёт **напрямую из браузера в Supabase Storage** через короткоживущий signed upload URL (`createAttachmentUploadUrl` → `uploadToSignedUrl` → `confirmNoteAttachment`, `app/actions/note-attachments.ts`, `components/notes/attachment-upload.tsx`), а не через Server Action, несущий байты файла — почему именно так, см. "Ключевые технические решения" ниже. Скачивание — по запросу через signed URL (`getAttachmentDownloadUrl`), который создаётся только по клику на кнопку Download, а не заранее для каждого вложения на каждом рендере страницы; удаление вложения сначала убирает строку в БД, потом best-effort удаляет объект в Storage, и разрешено либо тому, кто загрузил файл, либо owner'у организации (`note_attachments_delete_uploader_or_owner`).
- **Переключатель организаций (org switcher)** — пользователь может состоять более чем в одной организации (`organization_members` не имеет ограничения уникальности по пользователю). Какая организация "активна" — хранится в куке `active_org_id`, а не в URL (роуты остаются плоскими, без рефакторинга на `/org/[slug]/...`), резолвится в `lib/org.ts`'s `getActiveOrganization` (кука → RLS-проверка членства → fallback на первую организацию по `created_at` с починкой куки). Переключатель в хедере (`components/layout/org-switcher.tsx`) рендерится как dropdown только если организаций больше одной; при одной — просто название. Переключение идёт через server action `switchOrganization` (`app/actions/org.ts`), которая заново проверяет членство на сервере, не доверяя id организации от клиента.
- **Участники и email-инвайты** (`/dashboard/members`) — owner приглашает по email + роли (owner/member); письмо уходит через [Resend](https://resend.com) (`lib/resend.ts`, `lib/emails/invite-email.ts`) со ссылкой на `/invite/accept?token=...`. Приглашённый логинится или регистрируется (тот же паттерн `next=`) и принимает приглашение; принятие идёт через `service_role` (`app/actions/invites.ts`'s `acceptInvite`), потому что RLS сознательно не даёт обычной сессии пути к самостоятельному accept (`organization_invites_update_owner_revoke` разрешает только `pending → revoked`, а INSERT в `organization_members` — только owner'у) — поэтому `acceptInvite` сама перепроверяет совпадение email, статус `pending` и срок действия, а не доверяет проверкам на странице (они там только для UX). Список участников/инвайтов: создание/отзыв инвайта идёт через сессионный клиент (RLS, только owner); email участников для ростера — read-only запрос через `service_role` (`auth.admin.getUserById`), scoped к id, которые уже подтверждены RLS-запросом как участники организации — потому что у `organization_members` нет колонки email, а `auth.users` не читается anon-key клиентом. Поскольку инвайт может быть принят совсем в другой вкладке/браузере/сессии, чем та, где owner сейчас смотрит на эту страницу, `/dashboard/members` перезапрашивает данные при возврате фокуса на вкладку (`components/refresh-on-focus.tsx`, слушатель `visibilitychange`/`focus`, вызывающий `router.refresh()`, с троттлингом не чаще раза в 3 секунды) — вместо того чтобы оставаться в устаревшем состоянии до ручного обновления страницы. Здесь осознанно не Supabase Realtime: owner'у, который возвращается на эту вкладку и хочет увидеть актуальный статус инвайта, не нужна та же посекундная live-лента, что теперь есть у `/notes` (см. пункт про Notes выше) — обновление по фокусу вкладки для этой страницы ровно той сложности, которая нужна. Owner также может напрямую удалить участника или сменить его роль (инлайн `<Select>` рядом со строкой участника, `changeMemberRole` в `app/actions/org.ts`) — обе операции защищены RLS-политикой (`organization_members_delete_owner_or_self` / `organization_members_update_owner`), никогда не показываются для строки самого owner'а (удаление/понижение единственного owner'а всё равно безопасно отклоняется на сервере через `trg_prevent_last_owner_change`, даже если UI такое не предлагает), и обе шлют затронутому участнику best-effort email-уведомление (`lib/emails/member-removed-email.ts` / `role-changed-email.ts`) — неудачная отправка письма никогда не откатывает саму операцию.
- **Адаптивный хедер** (`components/layout/site-header.tsx`) — горизонтальная навигация (org switcher + до 4 ссылок + кнопка авторизации) помещается только от `md` (768px); ниже она сворачивается в гамбургер/`Sheet` (`components/layout/mobile-nav.tsx`) с теми же ссылками — наложение элементов друг на друга было найдено на реальном телефоне при живом тестировании, после того как в хедер добавились Members и org switcher.
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

**Держите один и тот же хост везде: либо `127.0.0.1`, либо `localhost` — не смешивайте.** Браузеры считают `localhost` и `127.0.0.1` разными хостами для куки, хотя оба указывают на один и тот же сервер. Если зашли в приложение через `http://127.0.0.1:3000`, а `NEXT_PUBLIC_APP_URL` в `.env.local` при этом стоит `http://localhost:3000` — после Stripe Checkout вас редиректнет обратно на `localhost`, где нет вашей сессионной cookie, и `/dashboard` покажет "не авторизован", хотя оплата прошла успешно. Та же логика для Google OAuth и для ссылки подтверждения email: `redirectTo`/ссылка из письма, которую реально шлёт браузер, должна быть в `additional_redirect_urls` в `supabase/config.toml` — если она указана только для `site_url` (голого корня) без пути `/auth/callback` или `/auth/confirm`, GoTrue молча подменит редирект на `site_url`, и код авторизации никогда не будет обменян на сессию. `.env.example` и `supabase/config.toml` в этом репозитории уже согласованы на `127.0.0.1` — меняя один, обновляйте оба.

Пройти весь флоу вручную:

1. Открыть `http://localhost:3000`, нажать "Get started" → `/signup`, зарегистрироваться email+паролем. Сессия **не** создаётся сразу — форма покажет "Account created. Check your email to confirm your address before signing in.". Открыть Mailpit (локальный SMTP-перехватчик, письма никуда реально не уходят) на `http://127.0.0.1:54324`, найти письмо "Confirm your email", перейти по ссылке — она заведёт на `/auth/confirm` и залогинит. Попытка войти до подтверждения вернёт понятную ошибку "Email not confirmed".
2. Onboarding: ввести имя/slug workspace → redirect на `/dashboard`.
3. `/dashboard` покажет баннер "No active subscription" → перейти на `/pricing`.
4. Нажать "Subscribe" на любом плане → Stripe Checkout (test mode) → оплатить тестовой картой `4242 4242 4242 4242` (см. "Тестовые карты" ниже).
5. Redirect обратно на `/dashboard?checkout=success`. Статус подписки обновляется асинхронно через webhook — требует либо `stripe listen --forward-to localhost:3000/api/webhooks/stripe` запущенным заранее (см. ниже), либо ручного триггера `stripe trigger checkout.session.completed`.
6. После того как статус подписки стал `active`/`trialing` — `/notes` открывает реальный список заметок вместо paywall: можно создать заметку, отредактировать/удалить свою; owner организации может отредактировать/удалить любую заметку в организации (модерация), обычный member — только свои.

Либо не проходить Checkout руками, а использовать готовые тестовые аккаунты из `supabase/seed.sql` (загружаются автоматически при `supabase db reset`) — пароль для всех: `password123`. Эти аккаунты создаются напрямую в `auth.users` с уже проставленным `email_confirmed_at`, так что email-подтверждение для них не требуется, логин работает сразу:

| Email | Организация | Роль | Подписка |
|---|---|---|---|
| `owner_a@example.com` | Acme | owner | `active` — `/notes` открыт |
| `member_a@example.com` | Acme | member | `active` — `/notes` открыт, billing скрыт (не owner) |
| `owner_b@example.com` | Globex | owner | нет подписки — `/notes` показывает paywall |

Тесты: `npm run test` (Vitest). Требует запущенный локальный Supabase (`supabase start`) — интеграционные тесты (вебхук, гейтинг `/notes` по подписке, авторизация CRUD над `notes`, пагинация/поиск/сортировка `notes`, а также RLS-авторизация broadcast-канала `notes:org:<id>` на реальном WebSocket в `tests/notes-realtime.test.ts`) пишут/читают реальные таблицы локальной БД и используют сид-аккаунты из таблицы выше.

Если меняли схему БД (новая миграция) — перегенерируйте TS-типы, иначе `lib/supabase/database.types.ts` расходится со схемой молча:

```bash
npm run db:types   # supabase gen types typescript --local > lib/supabase/database.types.ts
```

### Проверить что-то на проде прямо из шелла

`.env.local` всегда указывает на локальный Docker Supabase — именно его читают `npm run dev`/`npm run test`, и его не стоит временно редактировать под прод-креды ради одной curl/supabase-команды. Вместо этого держите отдельный `.env.production.local` (в `.gitignore`, тот же набор переменных, реальные hosted-креды Supabase + `NEXT_PUBLIC_APP_URL=https://saas.shlykoff.com`) и подгружайте его только в текущий шелл по требованию:

```bash
source scripts/env.sh production   # только этот шелл, до его закрытия
# ... curl/supabase-команды теперь видят реальный hosted-проект ...
source scripts/env.sh local        # обратно на локальный Docker Supabase
```

`.env.local` и `npm run dev` этим вообще не затрагиваются — это чисто для разовой проверки (RLS на hosted-проекте, реальная доставка вебхука и т.п.), не второе окружение для разработки.

## Google OAuth

Кнопка "Continue with Google" (`components/auth/google-oauth-button.tsx`) вызывает `supabase.auth.signInWithOAuth({ provider: "google" })` и была живьём проверена end-to-end с реальным Google-аккаунтом. Без настоящих Google OAuth credentials в окружении, где поднимается `supabase start`, кнопка всё равно рендерится, но упадёт на экране согласия Google (`Error 401: invalid_client`) — это ожидаемое поведение "из коробки" при первом клоне репозитория, credentials не коммитятся (`.env.local` в `.gitignore`).

Что нужно, чтобы OAuth реально заработал (в новом окружении/у нового разработчика):

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
| `STRIPE_PORTAL_CONFIGURATION_ID` | Id Billing Portal configuration с включённым `subscription_update` (переключение плана прямо в Customer Portal). См. "Смена плана в Customer Portal" ниже — без неё кнопка "Manage billing" открывает портал, где можно только отменить подписку или сменить карту, не сменить план. |
| `NEXT_PUBLIC_APP_URL` | Базовый URL приложения — используется для `success_url`/`cancel_url`/`return_url` Checkout и Customer Portal, а также для ссылки в email-инвайтах (`lib/app-url.ts`). |
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Публичные Supabase-данные, для клиента и для server actions, работающих от имени текущего пользователя. |
| `SUPABASE_SERVICE_ROLE_KEY` | Только сервер, через `lib/supabase/service-role.ts` — никогда в клиентском коде. Используется webhook-обработчиком, а также флоу принятия инвайта (`app/actions/invites.ts`'s `acceptInvite`, `app/invite/accept/page.tsx`) и ростером участников (`app/dashboard/members/page.tsx`) — оба сознательно обходят RLS (см. раздел "Функционал" выше). |
| `RESEND_API_KEY` | Только сервер, через `lib/resend.ts`. Отправляет email-инвайты в организацию напрямую (не через Supabase Auth email, т.к. инвайт — не auth-событие) — тот же ключ, что уже настроен как пароль в Supabase Custom SMTP. Взять в [Resend Dashboard → API Keys](https://resend.com/api-keys). |

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

### Смена плана в Customer Portal

Дефолтная (авто-созданная) конфигурация Stripe Customer Portal в свежем аккаунте **не разрешает менять план** — только отменить подписку или обновить способ оплаты. Чтобы кнопка "Manage billing" позволяла апгрейд/даунгрейд между Basic и Pro, нужна отдельная portal configuration с `features.subscription_update.enabled = true`, оба Price перечислены как переключаемые продукты, и `proration_behavior = "always_invoice"` (важно: значение по умолчанию `create_prorations` только *копит* разницу до следующего цикла оплаты вместо немедленного списания — если хочется списывать сразу при апгрейде, нужен именно `always_invoice`).

Создать такую конфигурацию можно один раз через API (сохраняет `id`, который идёт в `STRIPE_PORTAL_CONFIGURATION_ID`):

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

`app/actions/billing.ts`'s `createPortalSession` передаёт `configuration: STRIPE_PORTAL_CONFIGURATION_ID` в `stripe.billingPortal.sessions.create()`, если переменная задана; без неё используется дефолтная конфигурация аккаунта (без переключения плана).

## Что нужно сделать вручную перед первым «живым» запуском Stripe

1. Создать Stripe-аккаунт (если его ещё нет) и включить test mode.
2. Создать 2 Product/Price в Stripe Dashboard (test mode) под тарифы Basic/Pro, вписать их id в `STRIPE_PRICE_ID_BASIC` / `STRIPE_PRICE_ID_PRO`.
3. Скопировать `sk_test_...` ключ в `STRIPE_SECRET_KEY`.
4. Запустить `stripe listen --forward-to localhost:3000/api/webhooks/stripe`, вписать выданный `whsec_...` в `STRIPE_WEBHOOK_SECRET`.
5. Создать billing portal configuration (см. "Смена плана в Customer Portal" выше), вписать её id в `STRIPE_PORTAL_CONFIGURATION_ID`.
6. Пройти Checkout тестовой картой `4242 4242 4242 4242` и убедиться, что `subscriptions` в локальной БД обновилась.

## Ключевые технические решения

**RLS deny-by-default, а не "приложение фильтрует по organization_id".** Каждая таблица с пользовательскими данными (`organizations`, `organization_members`, `subscriptions`, `notes`, `processed_stripe_events`) — `ENABLE` + `FORCE ROW LEVEL SECURITY`, отдельные `select`/`insert`/`update`/`delete` политики (не одна политика "на всё"), и запись статуса подписки доступна исключительно `service_role`. Это осознанный выбор в пользу "изоляция гарантируется на уровне БД" вместо "приложение обещает не забыть добавить `.eq('organization_id', ...)` в каждый запрос" — при мультитенантности одна забытая проверка в одном месте кода означает утечку данных между организациями. Цена этого решения: часть логики (кто может редактировать чужую заметку, кто последний owner организации) живёт в SQL-триггерах, а не в TypeScript — например, `trg_prevent_last_owner_change` использует `pg_advisory_xact_lock` по `organization_id`, чтобы сериализовать конкурентные попытки удалить последнего owner'а (наивная `count(*)`-проверка без блокировки не защищает от двух параллельных транзакций, которые обе увидят "ещё есть другой owner" и обе пройдут — воспроизведено и закрыто во время ревью).

**Идемпотентность вебхука — claim/CAS state machine с fencing-токеном, не `insert ... on conflict do nothing`.** Наивная идемпотентность ("уже видели этот `event.id`? тогда игнорируем") ломается под конкурентной повторной доставкой одного и того же события (Stripe так и делает при медленном ответе): если "запись существует" трактуется как синоним "уже успешно обработано", гонка между двумя параллельными доставками может привести к тому, что обработчик отдаст Stripe `200 OK` на событие, которое по факту не применилось. `processed_stripe_events` вместо этого хранит явный `status` (`processing`/`succeeded`) и отдельную `claim_token`-колонку: конкурентный дубль либо не может забрать claim и получает `409` (форсируя честный Stripe-retry), либо видит `status='succeeded'` и только тогда отвечает `200 duplicate` — никогда не по факту одного лишь существования строки. Просроченный (не упавший, а просто медленный) claim может быть переподхвачен другим запросом по stale-таймауту; `claim_token` не даёт исходному "медленному" запросу тихо финализироваться поверх уже переподхваченного claim'а после того, как его владение истекло.

**Явная запись cookies на response-объект в auth-роутах, а не ambient `cookies()` API.** `app/auth/callback/route.ts` (OAuth) и `app/auth/confirm/route.ts` (email-подтверждение) — оба Route Handler'а, возвращающие `NextResponse.redirect(...)`, и оба пишут Supabase-сессионные cookies явно на этот же самый response-объект (`response.cookies.set(...)` внутри `setAll`), а не полагаются на next/headers' `cookies().set()`. Причина — воспроизведённый на практике баг: ambient `cookies()`-мутация не гарантированно попадает именно на тот `NextResponse`, который Route Handler в итоге возвращает, из-за чего сессия успешно создавалась на сервере (Stripe/Supabase логи подтверждали `200`), но браузер её не получал и следующий запрос уже видел "нет сессии". Тот же класс осторожности — `signOut()` в `app/actions/auth.ts` использует `scope: "local"`, а не Supabase SDK-дефолт `scope: "global"`: глобальный logout убивает **все** сессии пользователя (все вкладки/устройства), что для кнопки "Sign out" в одной вкладке — избыточное и неожиданное поведение, обнаруженное живым тестированием (выход в одной вкладке ронял свежесозданную Google OAuth-сессию в другой).

**Вложения к заметкам загружаются напрямую из браузера в Storage, а не через Server Action, несущий байты файла.** Наивный подход — `<form>`/Server Action, принимающий сырой файл и пересылающий его в Supabase Storage на сервере — ломается в продакшене именно потому, что приложение задеплоено на Vercel: serverless-функции там ограничивают тело запроса примерно 4.5 МБ, что заметно меньше собственного лимита бакета в 10 МиБ (`file_size_limit`, `supabase/migrations/20260818222947_add_note_attachments.sql`) — то есть обычный многомегабайтный PDF или фото был бы отклонён платформой ещё до того, как сработала бы собственная проверка размера в приложении. Реальный флоу (`app/actions/note-attachments.ts`, `components/notes/attachment-upload.tsx`) вместо этого гоняет через Server Actions только небольшие JSON-пейлоады — `createAttachmentUploadUrl` валидирует и выдаёт короткоживущий Supabase Storage signed upload URL/token, браузер сам делает `uploadToSignedUrl` с реальными байтами **напрямую в Storage**, а `confirmNoteAttachment` записывает строку метаданных в БД уже после того, как байты подтверждённо оказались в Storage — так что сам файл вообще не касается Vercel-функции, действует только собственный лимит Storage в 10 МиБ. Цена этого решения: signed URL может быть выдан и браузер может реально успеть загрузить по нему файл, но если шаг confirm так и не выполнится (вкладка закрыта посреди загрузки, обрыв сети), объект остаётся в Storage осиротевшим, без строки метаданных, которая на него указывает — известное ограничение, осознанно задокументированное, а не оставленное как сюрприз на потом, без чистящей джобы пока что (см. заголовочный комментарий этого файла).

**Миграции накатываются на hosted Supabase прямо во время сборки на Vercel, а не отдельным ручным шагом.** Раньше выкатка изменения схемы означала запуск `supabase db push` руками из шелла разработчика перед пушем кода приложения, который от неё зависит — легко перепутать порядок (или вовсе забыть), из-за чего живой сайт ненадолго отдаёт 500 всем пользователям в момент, когда новый код обращается к таблице/колонке, которой на hosted Supabase ещё нет. `scripts/apply-production-migrations.js` теперь запускается в начале каждого `npm run build`, но остаётся настоящим no-op, если не `VERCEL_ENV=production` (эта переменная никогда не выставлена ни локально, ни в GitHub Actions CI) — Vercel не отдаёт новый деплой, пока сборка не завершилась успешно, так что "миграция применена" и "новый код стал живым" снаружи выглядят одной атомарной операцией. Условие проверяется строго по `VERCEL_ENV`, а не просто по наличию `POSTGRES_URL_NON_POOLING` — эта переменная есть и в Preview/Development окружениях Vercel тоже (её автоматически прокидывает интеграция Supabase-Vercel), а у проекта нет отдельной staging-базы (см. "Проверить что-то на проде прямо из шелла" выше) — Preview-сборки смотрят в тот же самый hosted-проект, что и Production, так что без этого точного условия открытие PR накатывало бы миграции на прод при каждом пуше. `supabase db push` идемпотентен (отслеживает уже применённые миграции в `supabase_migrations.schema_migrations` на удалённой базе), так что безусловный запуск на каждой продакшн-сборке дёшев. Скрипт завершается с ненулевым кодом при ошибке — осознанно fail-closed: сломанная миграция роняет всю сборку на Vercel, оставляя живым *старый* деплой (соответствующий *старой* схеме), а не выкатывая новый код поверх схемы, которой он не соответствует.
