# Paw & Order

> Justice for every good boy.

Upload a photo of your dog. AI generates a fictional criminal case around that
dog. You defend them in court.

**Live:** https://paw-order.pages.dev

## DEV Weekend Challenge: Dog Days Edition

Built for the [DEV Weekend Challenge: Dog Days
Edition](https://dev.to/challenges/weekend-2026-08-13), start to finish inside
the challenge window. Everything up to the last commit before the deadline of
2026-08-17 06:59 UTC is the submitted entry; anything after that timestamp is
post-deadline work.

Submission post: `SUBMISSION.md`.

## Local development

```bash
nvm use
npm ci
cp packages/api/.env.example packages/api/.env   # GEMINI_API_KEY is the only one needed
npm run dev:api    # :4270
npm run dev:app    # :5173, proxies /api
```

`npm run all` (format, lint, typecheck, test) must be green before a commit.
