# SaaS Starter

SaaS-стартер с подпиской: Next.js (App Router) + Supabase (Auth/Postgres/RLS) + Stripe (Checkout, Customer Portal, Webhooks). Полное ТЗ — `docs/spec.md`, контекст для агентов — `CLAUDE.md`.

> Статус: в разработке. Схема БД и Stripe-интеграция (Checkout, Customer Portal, webhook-обработчик) готовы. Онбординг/UI кабинета — следующий этап (`nextjs-frontend`). Секции ниже (демо-ссылка, скриншоты, полный setup) будут дополнены по мере готовности остального функционала — см. CLAUDE.md п.7.

## Стек

Next.js 14+ (App Router, Server Actions) · Supabase (Auth + Postgres + RLS) · Stripe (Checkout, Customer Portal, Webhooks) · Tailwind · TypeScript strict.

## Запуск локально

```bash
npm install
supabase start          # поднимает локальный Supabase в Docker
cp .env.example .env.local
# заполнить .env.local значениями из `supabase status` + Stripe test-ключами (см. ниже)
npm run dev
```

Тесты: `npm run test` (Vitest). Требует запущенный локальный Supabase (`supabase start`) — интеграционный тест вебхука пишет/читает реальные таблицы локальной БД.

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

Либо пройти реальный Checkout flow через `/pricing?org=<organization_id>` тестовой картой выше — `stripe listen` перешлёт событие на локальный `/api/webhooks/stripe`.

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
