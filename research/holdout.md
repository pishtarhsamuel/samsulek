# Locked out-of-sample holdout

Fixed on **2026-10-12**, before any market data was downloaded or looked at.
Changing these dates after research has started invalidates every result.

| Market | Research + walk-forward period | FINAL HOLDOUT (never tuned on) |
|---|---|---|
| Stocks / ETFs | everything before 2024-10-01 | **2024-10-01 to 2026-09-30** (24 months) |
| Memecoins | first 2/3 of the forward-recorder history | last 1/3 of the recorder history, split by date once M4 starts and written here |

Rules
- No parameter, filter, universe or idea may be chosen by looking at holdout data.
- Each strategy family is run on the holdout **once**, after its design is
  frozen. The result is logged in `experiments.md` whatever it is, good or bad.
- If a family is redesigned after seeing its holdout result, the holdout is
  burned for that family. Say so in `experiments.md`, and only paper trading
  then counts as out-of-sample evidence.
- Paper trading (M5) is an additional, truly forward out-of-sample period.
