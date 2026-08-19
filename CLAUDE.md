# SaaS Starter — контекст проекта для Claude Code

Этот файл читают ВСЕ агенты (главная сессия и все саб-агенты). Здесь — то, что должно быть известно каждому, независимо от того, какую часть проекта он делает.

## Что это

SaaS-стартер с подпиской. Исходное ТЗ — `docs/spec.md`; MVP из него построен и задеплоен на прод, плюс с тех пор выросло больше (org switcher, инвайты, участники, вложения). Актуальный список фич — в README, не здесь.

## Стек

Next.js 16 (App Router, Server Actions, Server Components) · Supabase (Auth + Postgres + RLS + Storage) · Stripe (Checkout, Customer Portal, Webhooks) · Resend (транзакционные письма) · Tailwind v4 + shadcn/ui (base-ui) · TypeScript strict · деплой на Vercel.

## Локальная среда: Supabase в Docker

Разработка ведётся против **локального** Supabase, поднятого через Supabase CLI + Docker (`supabase start`), а не против облачного проекта напрямую.

- `.env.local` — только локальные URL/ключи. Для прода — `source scripts/env.sh production`.
- Новая миграция — `supabase migration new <name>`; применяются и тестируются локально через `supabase db reset`.
- Схему меняем только файлами миграций, не через Supabase Studio.
- На hosted миграции накатываются сами при сборке на Vercel (`scripts/apply-production-migrations.mjs`). Вручную (только с разрешения пользователя, см. правило 8) — `supabase db push --db-url "$POSTGRES_URL_NON_POOLING"` после `source scripts/env.sh production`.
- `supabase start` требует запущенный Docker.
- `stripe listen --forward-to localhost:3000/api/webhooks/stripe` держать запущенным весь сеанс разработки.
- Письма локально не улетают реально — их ловит Mailpit (`http://127.0.0.1:54324`), поднятый вместе с `supabase start`.

## Не-переговорные правила (для всех агентов)

1. Секреты только в `.env.local`, в репозитории — только `.env.example` с плейсхолдерами. Никогда не коммитить реальные ключи.
2. `SUPABASE_SERVICE_ROLE_KEY` используется **только** в server-side коде. Никогда не передаётся в клиентский бандл.
3. RLS-политики — deny by default, явные policy на каждую таблицу.
4. Любой Stripe webhook обязан проверять `stripe-signature` через `stripe.webhooks.constructEvent` на raw body, и обрабатывать повторную доставку идемпотентно.
5. TypeScript strict, без `any` без явной причины.
6. К каждой фиче — хотя бы один тест на критичную логику (RLS-политику, webhook, серверный экшен).
7. README актуален и короткий — пара предложений на решение, не абзац.
8. Прод не трогается напрямую без явного разрешения пользователя.
9. Коммит — как только фича и фиксы по ней готовы (см. Git-флоу ниже).
10. Все замечания qa-reviewer фиксятся до готовности фичи.

## Git-флоу

`main` защищён branch protection: прямой `git push origin main` отклоняется. Обязателен PR с зелёным CI-чеком `test`; ревьюер не требуется (соло-проект). `enforce_admins` включён — правило действует без исключений, в том числе для владельца репозитория.

Для каждой задачи:

```bash
git checkout -b <branch> main
# коммиты по ходу работы
git push -u origin <branch>
gh pr create
# дождаться зелёного CI
gh pr merge --squash
```

`gh` CLI установлен и авторизован.

## Как организована работа агентов

В `.claude/agents/` лежат 4 специализированных саб-агента:

- **db-architect** — схема, RLS, миграции, pgTAP.
- **stripe-specialist** — Checkout/Portal/webhook. Только для биллинг-фич.
- **nextjs-frontend** — страницы, компоненты, серверные экшены.
- **qa-reviewer** — ревью безопасности/тестов перед готовностью фичи.

Порядок для новой фичи: db-architect (если нужна схема) → nextjs-frontend → qa-reviewer.

Если Agent tool не подхватывает `.claude/agents/` сам — вставляйте персону текстом в промпт.
