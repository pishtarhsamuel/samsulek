# Experiment log

Every experiment goes here: failures, abandoned ideas and parameter sweeps
included. The running **trial count** feeds the deflated Sharpe ratio. Testing
many variants and keeping the best one is how people fool themselves, so every
variant counts.

Total trials so far: **0**

## Template

```
### E### - <short name> (YYYY-MM-DD)
- Hypothesis (written BEFORE running):
- Market / universe / data source / period (holdout untouched? yes/no):
- Variants tried (count toward trials): N
- Costs: base and 2x; result at 2x:
- Baselines: buy-and-hold ..., random entries (pctile of strategy vs N random runs) ...
- Metrics: CAGR, Sharpe, Sortino, max DD (+ duration), win rate, avg win/loss,
  profit factor, turnover, exposure, deflated Sharpe
- Sanity flags (Sharpe > 3? tiny DD? win rate too good? -> bug hunt first):
- Verdict (plain language): edge / no edge / inconclusive, and why
- Report: research/reports/...
```

## Entries

_None yet. Research starts in M3/M4._
